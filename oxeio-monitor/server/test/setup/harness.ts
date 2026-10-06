import { createHash, randomBytes } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { PrismaClient, UserRole } from '@prisma/client';
import request from 'supertest';

import { AppCategoryService } from '../../src/activity/app-category.service';
import { FeaturesService } from '../../src/features/features.service';
import { AppSettingsService } from '../../src/settings/app-settings.service';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { LOCAL_OFFSET_MIN, workDateOf } from '../../src/agent/util/work-time';
import { PrismaService } from '../../src/prisma/prisma.service';

export const OWNER_EMAIL = 'owner@test.local';
export const OWNER_PASSWORD = 'owner-password-123';
export const MANAGER_EMAIL = 'manager@test.local';
export const MANAGER_PASSWORD = 'manager-password-123';

/** supertest agent with a cookie jar */
export type HttpAgent = ReturnType<typeof request.agent>;

export interface Harness {
  app: INestApplication;
  prisma: PrismaClient;
  http: () => HttpAgent;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);

  return {
    app,
    prisma,
    // agent() keeps cookies in a jar, so it sends them on later requests after login
    http: () => request.agent(app.getHttpServer()),
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Before each test, cleans the database and inserts the minimal fixtures.
 * Tables are TRUNCATEd in one statement (with CASCADE).
 */
export async function resetDatabase(
  prisma: PrismaClient,
  app?: INestApplication,
): Promise<void> {
  /**
   * Careful: three tables from R21 used to be missing here, and the failure
   * showed up somewhere completely different. deposit_policy has no FK to
   * employees, so it survived CASCADE: a rule set by one test stayed for the
   * next, ensureLedger filled the ledger again, and the result was an
   * order-dependent failure (12 passing in one run, 4 in the next, same code).
   *
   * When you add a new table, add it to this list too. If you forget, the
   * failure shows up far away, in someone else's test, and the cause is hard
   * to find.
   *
   * Tables with no FK to employees are the real risk: CASCADE does not reach
   * them, so if they are left out they survive test after test. There are
   * three so far: deposit_policy, month_closures (a closed month would block
   * edits in the next test) and summary_dirty (keyed by `work_date`, so one
   * test's marker stayed for the next and counts did not match; the failure
   * looked as if ingest was marking the wrong day).
   *
   * To cross-check this list against the schema's @@map entries:
   *   grep -o '@@map("[a-z_]*")' prisma/schema.prisma
   */
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      time_adjustments, audit_log, alerts, screenshots, app_usage, events,
      activity_segments, work_sessions, enrollment_codes, devices,
      daily_summary, monthly_summary, users, employees, work_policies,
      app_categories, holidays, agent_versions, settings,
      deposit_policy, security_deposits, deposit_settlements,
      leaves, month_closures, summary_dirty
    RESTART IDENTITY CASCADE
  `);

  // `app_categories`: TRUNCATE ... RESTART IDENTITY also resets ids. If the
  // cache keeps an old id, the next ingest breaks a foreign key (in tests this
  // showed up as a 500) and the cause is hard to find.
  app?.get(AppCategoryService).invalidate();
  // the module switches are cached the same way; the row was just truncated
  app?.get(FeaturesService).forget();
  app?.get(AppSettingsService).forget();

  const policy = await prisma.workPolicy.create({
    data: {
      name: 'Standard',
      monthlyTargetHours: 208,
      expectedWorkdays: 26,
      weeklyOffDays: [5],
      screenshotFrom: '07:00',
      screenshotTo: '23:00',
      idleThresholdSec: 60,
      slotMinutes: 5,
      timezone: 'Asia/Dhaka',
    },
  });

  await prisma.user.create({
    data: {
      email: OWNER_EMAIL,
      passwordHash: await hashPassword(OWNER_PASSWORD),
      fullName: 'Test Owner',
      role: UserRole.owner,
      mustChangePw: true,
    },
  });

  await prisma.user.create({
    data: {
      email: MANAGER_EMAIL,
      passwordHash: await hashPassword(MANAGER_PASSWORD),
      fullName: 'Test Manager',
      role: UserRole.manager,
      mustChangePw: false,
    },
  });

  return void policy;
}

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

// ── auth helpers ────────────────────────────────────────────────────────────

export interface Session {
  http: HttpAgent;
  /** double-submit CSRF token; goes in the header of every state-changing request */
  csrf: string;
}

/** Extracts the value of one named cookie from the Set-Cookie headers */
export function readCookie(
  setCookie: string[] | undefined,
  name: string,
): string | undefined {
  const line = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return line?.split(';')[0]?.split('=')[1];
}

export async function login(
  harness: Harness,
  email: string,
  password: string,
): Promise<Session> {
  const http = harness.http();
  const res = await http
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(200);

  const csrf = readCookie(
    res.headers['set-cookie'] as unknown as string[],
    'oxeio_csrf',
  );
  if (!csrf) throw new Error('no CSRF cookie after login');

  return { http, csrf };
}

/** Logs in and changes the password to clear `mustChangePw`, giving a fully usable session */
export async function loginReady(
  harness: Harness,
  email: string,
  password: string,
): Promise<Session> {
  const session = await login(harness, email, password);

  const me = await session.http.get('/api/v1/auth/me').expect(200);
  if (me.body.mustChangePassword !== true) return session;

  const changed = await session.http
    .post('/api/v1/auth/change-password')
    .set('X-CSRF-Token', session.csrf)
    .send({ currentPassword: password, newPassword: `${password}-changed` })
    .expect(204);

  const csrf =
    readCookie(
      changed.headers['set-cookie'] as unknown as string[],
      'oxeio_csrf',
    ) ?? session.csrf;

  return { http: session.http, csrf };
}

// ── agent helpers ───────────────────────────────────────────────────────────

export interface EnrolledDevice {
  token: string;
  deviceId: number;
  employeeId: number;
  configVersion: string;
}

export async function createEmployeeWithCode(
  prisma: PrismaClient,
  empCode = 'OX-001',
): Promise<{ employeeId: number; code: string }> {
  const policy = await prisma.workPolicy.findFirstOrThrow();
  const owner = await prisma.user.findFirstOrThrow({
    where: { role: UserRole.owner },
  });

  const employee = await prisma.employee.create({
    data: {
      empCode,
      fullName: 'Rakib Hasan',
      policyId: policy.id,
      joinedOn: new Date('2026-01-05T00:00:00Z'),
    },
  });

  const code = randomBytes(6).toString('hex').toUpperCase();
  await prisma.enrollmentCode.create({
    data: {
      codeHash: createHash('sha256').update(code).digest('hex'),
      employeeId: employee.id,
      createdById: owner.id,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });

  return { employeeId: employee.id, code };
}

export async function enrollDevice(
  harness: Harness,
  code: string,
  overrides: Record<string, unknown> = {},
): Promise<EnrolledDevice> {
  const res = await harness
    .http()
    .post('/api/v1/agent/enroll')
    .send({
      enrollmentCode: code,
      hostname: 'PC-07',
      windowsUsername: 'rakib',
      machineGuid: 'guid-test-001',
      osVersion: 'Windows 11',
      agentVersion: '1.0.0',
      monitors: 2,
      ...overrides,
    })
    .expect(201);

  return {
    token: res.body.deviceToken,
    deviceId: res.body.deviceId,
    employeeId: res.body.employee.id,
    configVersion: res.body.configVersion,
  };
}

export const iso = (d: Date): string => d.toISOString();
export const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);

/**
 * A recent window that stays inside today's Dhaka day.
 *
 * Tests cannot be written with `minutesAgo(30)`: just after Dhaka midnight,
 * "30 minutes ago" means yesterday. Three tests used to break, and the cause
 * was the clock, not the code:
 *
 * - today's total came out 0 (the segment belonged to yesterday)
 * - the session closed with `day_rollover` instead of `logoff`
 * - the segment was split in two at midnight, and `findFirstOrThrow` returned
 *   the first half, which ends at exactly 00:00
 *
 * With CI red for half an hour after midnight every day, a real breakage could
 * not be told apart from a clock breakage. So the window is clipped at
 * midnight, and tests compare the returned `durationSec` instead of a
 * hardcoded 600.
 */
export function todayWindow(seconds: number): {
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
} {
  // 1 second margin: if endedAt ended up just after "now", the server would
  // see a future timestamp
  const endedAt = new Date(Date.now() - 1_000);
  const workMidnight = workDateOf(endedAt).getTime() - LOCAL_OFFSET_MIN * 60_000;

  const startedAt = new Date(
    Math.max(endedAt.getTime() - seconds * 1_000, workMidnight + 1_000),
  );

  return {
    startedAt,
    endedAt,
    durationSec: Math.round((endedAt.getTime() - startedAt.getTime()) / 1_000),
  };
}

// ── Test clock ─────────────────────────────────────────────────────────────
//
// The definitions live in `./clock`, not here: pure-function specs cannot
// import the harness (it boots the whole Nest app and Postgres), yet the clock
// rule must be the same for both kinds of spec. Writing it here again would
// give two definitions, and one day one of them would change.
export { workNoon, workTodayIso, realNow } from './clock';

/**
 * A unique piece to put in emails and employee codes.
 *
 * `Date.now()` used to be used here, and it was harmless, but having that name
 * in the file meant the ban on the real clock could no longer be enforced by
 * grep, and "which use is harmless" had to be judged by hand each time. So
 * uniqueness no longer touches the clock: a counter plus random bytes is
 * enough, and it stays unique even for two tests run in the same millisecond
 * (`Date.now()` would give the same value then, which was itself a rare flake).
 */
let uniqueCounter = 0;
export function uniqueSuffix(): string {
  uniqueCounter += 1;
  return `${uniqueCounter}${randomBytes(3).toString('hex')}`;
}
