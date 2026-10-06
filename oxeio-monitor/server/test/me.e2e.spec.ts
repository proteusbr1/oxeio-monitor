import { randomUUID } from 'node:crypto';

import { UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/dhaka-time';
import {
  createHarness,
  hashPassword,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  dhakaNoon,
} from './setup/harness';

/**
 * **J04, J05, J08** — the staff member's own page.
 *
 * The most important tests in this file are not about data but about the
 * boundary: a staff member must never see a colleague's numbers. That is
 * impossible because the path has no `:id` — the tests guard exactly that design.
 */
let h: Harness;
let employeeId: number;
let otherId: number;
let deviceId: number;

const STAFF_EMAIL = 'rakib@test.local';
const STAFF_PASSWORD = 'staff-password-123';

const now = dhakaNoon();
const workDate = workDateOf(now);
const MS_PER_DAY = 86_400_000;

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** An ACTIVE segment on that day */
async function segment(
  forEmployee: number,
  day: Date,
  seconds: number,
): Promise<void> {
  const session = await h.prisma.workSession.create({
    data: {
      employeeId: forEmployee,
      deviceId,
      workDate: day,
      startedAt: day,
      endedAt: new Date(day.getTime() + seconds * 1000),
    },
  });

  await h.prisma.activitySegment.create({
    data: {
      sessionId: session.id,
      employeeId: forEmployee,
      deviceId,
      clientUuid: randomUUID(),
      workDate: day,
      state: 'active',
      startedAt: day,
      endedAt: new Date(day.getTime() + seconds * 1000),
      durationSec: seconds,
      countsAsWork: true,
    },
  });
}

const staffSession = () => loginReady(h, STAFF_EMAIL, STAFF_PASSWORD);

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);

  const policy = await h.prisma.workPolicy.findFirstOrThrow();

  const employee = await h.prisma.employee.create({
    data: {
      empCode: 'OX-001',
      fullName: 'Rakib Hasan',
      designation: 'Developer',
      policyId: policy.id,
      joinedOn: new Date('2026-01-05T00:00:00Z'),
    },
  });
  employeeId = employee.id;

  const other = await h.prisma.employee.create({
    data: { empCode: 'OX-002', fullName: 'Someone Else', policyId: policy.id },
  });
  otherId = other.id;

  const device = await h.prisma.device.create({
    data: {
      hostname: 'PC-07',
      windowsUsername: 'rakib',
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
    },
  });
  deviceId = device.id;

  // The staff member's portal account — `employeeId` is set, and that is the boundary
  await h.prisma.user.create({
    data: {
      email: STAFF_EMAIL,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      fullName: 'Rakib Hasan',
      role: UserRole.employee,
      employeeId,
      mustChangePw: false,
    },
  });
});

describe('GET /me', () => {
  it('staff see their own name and hours', async () => {
    await segment(employeeId, workDate, 3 * 3600);

    const s = await staffSession();
    const res = await s.http.get('/api/v1/me').expect(200);

    expect(res.body.employee.fullName).toBe('Rakib Hasan');
    expect(res.body.employee.empCode).toBe('OX-001');
    expect(res.body.employee.designation).toBe('Developer');
    expect(res.body.progress.todayActiveSec).toBe(3 * 3600);
    /**
     * G37, ADR-025 — the target is no longer a flat 208, it is work days x 8.
     * So it varies by month (Feb 192, Sep 208, Aug 216), and writing down a
     * fixed number would break the test whenever the month changed.
     *
     * The real claim here is the rule, not a number: the target is a
     * multiple of 8 and within the range of a month's work days (20 to 27 days).
     */
    const target = res.body.progress.monthlyTargetHours as number;
    expect(target % 8).toBe(0);
    expect(target).toBeGreaterThanOrEqual(20 * 8);
    expect(target).toBeLessThanOrEqual(27 * 8);
  });

  /**
   * "Screenshots are deleted after 90 days" — the promise is on paper and
   * must be on the page too. The number comes from the server
   * (`SCREENSHOT_RETENTION_DAYS`), not hand-written in the web app —
   * otherwise if the policy changed one day the page would keep showing the old promise.
   */
  it('it also says how long screenshots are kept', async () => {
    const s = await staffSession();
    const res = await s.http.get('/api/v1/me').expect(200);

    expect(res.body.screenshotRetentionDays).toBe(90);
  });

  it('shows the signing date when there is one', async () => {
    await h.prisma.employee.update({
      where: { id: employeeId },
      data: { policySignedAt: new Date('2026-08-01T00:00:00Z') },
    });

    const s = await staffSession();
    const res = await s.http.get('/api/v1/me').expect(200);

    expect(res.body.policySignedAt).toBe('2026-08-01');
  });

  /**
   * The owner's `users.employee_id` is usually null — this page does not
   * exist for them, and that is not a mistake. A clean 403 is needed, not a 500.
   */
  it('403 for an account not tied to a staff row', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await s.http.get('/api/v1/me').expect(403);
  });

  it('401 without login', async () => {
    await h.http().get('/api/v1/me').expect(401);
  });
});

describe('GET /me/days', () => {
  it('a row comes back for every day — even with no work', async () => {
    const today = iso(workDate);
    const twoDaysAgo = iso(new Date(workDate.getTime() - 2 * MS_PER_DAY));

    // The middle day is deliberately empty
    await segment(employeeId, new Date(workDate.getTime() - 2 * MS_PER_DAY), 3600);
    await segment(employeeId, workDate, 2 * 3600);

    const s = await staffSession();
    const res = await s.http
      .get(`/api/v1/me/days?from=${twoDaysAgo}&to=${today}`)
      .expect(200);

    // Three rows, not two — the empty day must be there too, otherwise the
    // question "what happened that day" would vanish from the page
    expect(res.body).toHaveLength(3);
    // Newest day first
    expect(res.body[0].workDate).toBe(today);
    expect(res.body[0].workedSec).toBe(2 * 3600);
    expect(res.body[1].workedSec).toBe(0);
    expect(res.body[2].workedSec).toBe(3600);
  });

  it('shows the adjustment separately, and it adds into credited', async () => {
    await segment(employeeId, workDate, 3600);

    const owner = await h.prisma.user.findFirstOrThrow({
      where: { role: UserRole.owner },
    });
    await h.prisma.timeAdjustment.create({
      data: {
        employeeId,
        workDate,
        deltaSec: 1800,
        cause: 'agent_down',
        reason: 'এজেন্ট বন্ধ ছিল',
        createdById: owner.id,
      },
    });

    const s = await staffSession();
    const day = iso(workDate);
    const res = await s.http
      .get(`/api/v1/me/days?from=${day}&to=${day}`)
      .expect(200);

    expect(res.body[0].workedSec).toBe(3600);
    expect(res.body[0].adjustmentSec).toBe(1800);
    expect(res.body[0].creditedSec).toBe(5400);
  });

  /**
   * This test is the reason for the module. With `:id` in the path a staff
   * member could change the number and see a colleague's days. The id comes
   * from the session, so there is no way to ask for a colleague's data —
   * this checks exactly that: another staff member's hours are in the
   * database, yet do not appear in the result.
   */
  it('a colleague\'s hours never mix in', async () => {
    await segment(otherId, workDate, 8 * 3600);

    const s = await staffSession();
    const day = iso(workDate);
    const res = await s.http
      .get(`/api/v1/me/days?from=${day}&to=${day}`)
      .expect(200);

    expect(res.body[0].workedSec).toBe(0);
  });

  it('asking for a future date gives up to today only', async () => {
    const s = await staffSession();
    const day = iso(workDate);
    const later = iso(new Date(workDate.getTime() + 10 * MS_PER_DAY));

    const res = await s.http
      .get(`/api/v1/me/days?from=${day}&to=${later}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].workDate).toBe(day);
  });

  /** Without a ceiling, someone could pull the whole table with `from=2000-01-01` */
  it('asking for more than 92 days gives the last 92 days', async () => {
    const s = await staffSession();
    const res = await s.http
      .get(`/api/v1/me/days?from=2020-01-01&to=${iso(workDate)}`)
      .expect(200);

    expect(res.body).toHaveLength(92);
  });

  /** The regex checks shape, `parseWorkDate` checks the calendar — 400, not 500 */
  it('400 for an impossible date', async () => {
    const s = await staffSession();
    await s.http.get('/api/v1/me/days?from=2026-02-31&to=2026-02-31').expect(400);
  });

  it('400 without a date', async () => {
    const s = await staffSession();
    await s.http.get('/api/v1/me/days').expect(400);
  });

  it('even a manager does not get their own page — not tied to a staff row', async () => {
    const s = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await s.http
      .get(`/api/v1/me/days?from=${iso(workDate)}&to=${iso(workDate)}`)
      .expect(403);
  });
});
