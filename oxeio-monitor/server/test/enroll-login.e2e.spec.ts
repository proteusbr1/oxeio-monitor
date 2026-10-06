import { randomUUID } from 'node:crypto';

import { UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  hashPassword,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  uniqueSuffix,
} from './setup/harness';
import { resolveThrottle } from '../src/auth/login-throttle.config';

/** From the running config — hardcoding the number in the test would break whenever the setting changed */
const THROTTLE = resolveThrottle({
  maxFails: process.env.LOGIN_MAX_FAILS,
  lockMinutes: process.env.LOGIN_LOCK_MINUTES,
});

/**
 * Staff add their own PC with their own email and password.
 *
 * With enrollment codes the owner had to create a separate code for each PC
 * and match by hand which code went to which machine. A wrong match raised
 * no error — one person's hours were credited to another, and it was caught
 * only at month end.
 *
 * But this simpler path has a price: it is a password-accepting endpoint,
 * and there is no cookie or CSRF here. So half the tests in this file are
 * about safeguards, not convenience — wrong password, disabled account, 2FA,
 * and the brute-force throttle.
 */
let h: Harness;
let employeeId: number;

const STAFF_EMAIL = 'alex@test.local';
const STAFF_PASSWORD = 'staff-password-123';

const facts = (overrides: Record<string, unknown> = {}) => ({
  hostname: 'PC-07',
  windowsUsername: 'alex',
  machineGuid: randomUUID(),
  osVersion: 'Windows 11',
  agentVersion: '0.2.0',
  monitors: 2,
  ...overrides,
});

const enrollLogin = (body: Record<string, unknown>) =>
  h.http().post('/api/v1/agent/enroll-login').send(body);

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
    data: { empCode: 'OX-001', fullName: 'Alex Silva', policyId: policy.id },
  });
  employeeId = employee.id;

  await h.prisma.user.create({
    data: {
      email: STAFF_EMAIL,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      fullName: 'Alex Silva',
      role: UserRole.employee,
      employeeId,
      mustChangePw: false,
    },
  });
});

describe('POST /agent/enroll-login — success path', () => {
  it('a staff login returns a device token', async () => {
    const res = await enrollLogin({
      ...facts(),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.deviceToken).toBeTruthy();
    expect(res.body.employee.empCode).toBe('OX-001');
    expect(res.body.config).toBeTruthy();

    const device = await h.prisma.device.findUniqueOrThrow({
      where: { id: res.body.deviceId },
    });
    // The device is under the name of whoever logged in — this is the reason for the whole change
    expect(device.employeeId).toBe(employeeId);
    expect(device.monitors).toBe(2);
  });

  /**
   * The token goes out only once — the server keeps only the sha256. This
   * checks that: the plain token in the response is not in the database column.
   */
  it('the plain token is not stored in the database', async () => {
    const res = await enrollLogin({
      ...facts(),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });

    const device = await h.prisma.device.findUniqueOrThrow({
      where: { id: res.body.deviceId },
    });
    expect(device.tokenHash).not.toBe(res.body.deviceToken);
    expect(device.tokenHash).toHaveLength(64); // sha256 hex
  });

  it('the token really works — heartbeat 200', async () => {
    const enrolled = await enrollLogin({
      ...facts(),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });

    const beat = await h
      .http()
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${enrolled.body.deviceToken}`)
      .send({ state: 'active', activeSecToday: 60 });

    expect(beat.status).toBe(200);
  });

  /**
   * Signing in again on the same PC updates the existing row, not a new one
   * (upsert on `machineGuid`). Otherwise every agent reinstall would bloat
   * the device list and nobody could say which one is real.
   */
  it('second time on the same machine — same device, new token', async () => {
    const guid = randomUUID();
    const first = await enrollLogin({
      ...facts({ machineGuid: guid }),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });
    const second = await enrollLogin({
      ...facts({ machineGuid: guid }),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });

    expect(second.body.deviceId).toBe(first.body.deviceId);
    expect(second.body.deviceToken).not.toBe(first.body.deviceToken);

    // The old token is now dead — otherwise even after a PC changed hands,
    // data could still be sent with the old token
    const stale = await h
      .http()
      .post('/api/v1/agent/heartbeat')
      .set('Authorization', `Bearer ${first.body.deviceToken}`)
      .send({ state: 'active', activeSecToday: 60 });
    expect(stale.status).toBe(401);
  });

  /** Six months later, "how was this machine added?" — the answer is in the event */
  it('the agent_start event records which path it came through', async () => {
    await enrollLogin({
      ...facts(),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });

    const [event] = await h.prisma.event.findMany({
      where: { type: 'agent_start' },
    });
    expect((event.meta as { via: string }).via).toBe('login');
  });
});

describe('POST /agent/enroll-login — safeguards', () => {
  it('wrong password gives 401, and no device is created', async () => {
    const res = await enrollLogin({
      ...facts(),
      email: STAFF_EMAIL,
      password: 'wrong-password',
    });

    expect(res.status).toBe(401);
    expect(await h.prisma.device.count()).toBe(0);
  });

  /** "No such user" and "wrong password" give the same message, otherwise
   *  which emails are real could be counted from outside */
  it('an unknown email gets the same 401', async () => {
    const unknown = await enrollLogin({
      ...facts(),
      email: 'nobody@test.local',
      password: STAFF_PASSWORD,
    });
    const wrong = await enrollLogin({
      ...facts(),
      email: STAFF_EMAIL,
      password: 'wrong-password',
    });

    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it('a deactivated account gives 401', async () => {
    await h.prisma.user.update({
      where: { email: STAFF_EMAIL },
      data: { isActive: false },
    });

    const res = await enrollLogin({
      ...facts(),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });
    expect(res.status).toBe(401);
  });

  /**
   * The `users.employee_id` of owner and manager is null — there is no staff
   * row in their name, so nowhere to accumulate hours. It is 403, not 401,
   * and the message is actionable: "sign in with a staff account on this PC".
   */
  it('403 for an owner or manager account', async () => {
    for (const [email, password] of [
      [OWNER_EMAIL, OWNER_PASSWORD],
      [MANAGER_EMAIL, MANAGER_PASSWORD],
    ]) {
      const res = await enrollLogin({ ...facts(), email, password });
      expect(res.status, email).toBe(403);
    }

    expect(await h.prisma.device.count()).toBe(0);
  });

  /**
   * Brute force. The endpoint has no cookie and no CSRF, so it could have
   * been the easiest door for guessing passwords. Because the check happens
   * in `AuthService.login()`, the login throttle applies automatically.
   */
  it.skipIf(!THROTTLE.enabled)('repeated wrong attempts lock the account', async () => {
    /**
     * A separate, unique email for this test. The throttle counter is
     * in-memory (`email|ip`) and `resetDatabase()` does not clear it — so
     * locking the ordinary staff account would give every following test a
     * 429. `auth.e2e.spec.ts` uses exactly the same trick.
     */
    const email = `locked-${uniqueSuffix()}@test.local`;
    const password = 'another-password-123';

    await h.prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        fullName: 'Locked Out',
        role: UserRole.employee,
        employeeId,
        mustChangePw: false,
      },
    });

    /**
     * The number is no longer hardcoded — it is now a `.env` setting. "5" used
     * to be hardcoded, so the test broke the moment the default was softened,
     * although the behaviour was right. The test should guard the rule, not a number.
     */
    const codes: number[] = [];
    for (let i = 0; i <= THROTTLE.maxFails; i++) {
      const res = await enrollLogin({ ...facts(), email, password: `guess-${i}` });
      codes.push(res.status);
    }

    expect(codes.slice(0, THROTTLE.maxFails)).toEqual(
      Array(THROTTLE.maxFails).fill(401),
    );
    expect(codes[THROTTLE.maxFails]).toBe(429);

    // After the lock, even the right password is blocked — otherwise the lock would mean nothing
    const right = await enrollLogin({ ...facts(), email, password });
    expect(right.status).toBe(429);

    expect(await h.prisma.device.count()).toBe(0);
  });

  it('failed attempts appear in audit_log', async () => {
    await h.prisma.auditLog.deleteMany({});

    await enrollLogin({
      ...facts(),
      email: STAFF_EMAIL,
      password: 'wrong-password',
    });

    const rows = await h.prisma.auditLog.findMany({
      where: { action: 'login_failed' },
    });
    expect(rows).toHaveLength(1);
  });

  it('400 when a field is missing', async () => {
    const res = await enrollLogin({ email: STAFF_EMAIL, password: STAFF_PASSWORD });
    expect(res.status).toBe(400);
  });

  it('400 when it is not an email', async () => {
    const res = await enrollLogin({
      ...facts(),
      email: 'alex',
      password: STAFF_PASSWORD,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /agent/enroll-login — 2FA', () => {
  /**
   * With 2FA on, the first reply does not create a device, only
   * `needs_totp` — the agent then shows the six-digit field. If it returned
   * 401, staff would read "wrong password" and keep typing the right one.
   */
  it('with 2FA on it asks for the code and creates no device', async () => {
    await h.prisma.user.update({
      where: { email: STAFF_EMAIL },
      data: {
        // The envelope shape is `TotpEnvelope` in `src/auth/totp.ts` — a wrong
        // shape makes `decodeEnvelope` throw (fail-closed), and the test would
        // get a 500 and falsely reassure that "2FA works"
        totpSecret: JSON.stringify({
          v: 1,
          secret: 'JBSWY3DPEHPK3PXP',
          enabled: true,
          recoveryHashes: [],
          lastCounter: 0,
        }),
      },
    });

    const res = await enrollLogin({
      ...facts(),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('needs_totp');
    expect(res.body.deviceToken).toBeUndefined();
    expect(await h.prisma.device.count()).toBe(0);
  });
});

/**
 * A device row belongs to one person — it never changes hands silently.
 *
 * A bug caught in the real office: two staff members' PCs alternately went
 * "suddenly offline", and their rows on the Staff screen went back to "Ready
 * to install". The `upsert` key was only `machineGuid`, and on conflict both
 * `employeeId` and `tokenHash` were overwritten, so one row changed hands
 * between two machines that sent the same GUID.
 *
 * `machineGuid` comes from the Windows registry and is copied exactly by a
 * disk-image clone — set up one PC in the office and image the rest, and
 * everyone has the same GUID.
 */
/**
 * Device identity: the machine plus whoever signed in.
 *
 * A bug caught in the real office: two staff members' tracking alternately
 * went "suddenly offline", and their rows on the Staff screen went back to
 * "Ready to install". The `upsert` key was only `machineGuid`, and on
 * conflict both `employeeId` and `tokenHash` were overwritten, so one row
 * changed hands between two agents sending the same GUID.
 *
 * `machineGuid` belongs to the machine, not the user — so with two staff on
 * one PC under different Windows accounts it is the same. The office log
 * showed it: "Intern" and "Intern 2" on `DESKTOP-BJNQ6OF`.
 */
describe('POST /agent/enroll-login — device identity', () => {
  const OTHER_EMAIL = 'sadia@test.local';
  const OTHER_PASSWORD = 'other-password-123';

  /** A second staff member + their portal login */
  const addOtherStaff = async (): Promise<number> => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    const other = await h.prisma.employee.create({
      data: { empCode: 'OX-002', fullName: 'Sadia Akther', policyId: policy.id },
    });

    await h.prisma.user.create({
      data: {
        email: OTHER_EMAIL,
        passwordHash: await hashPassword(OTHER_PASSWORD),
        fullName: 'Sadia Akther',
        role: UserRole.employee,
        employeeId: other.id,
        mustChangePw: false,
      },
    });

    return other.id;
  };

  /**
   * The real claim — this is exactly what happens in the office: one PC, two
   * staff, different Windows accounts. Each must get a separate row.
   */
  it('one PC, two Windows accounts -> a separate device for each', async () => {
    const otherId = await addOtherStaff();
    const guid = randomUUID();

    const first = await enrollLogin({
      ...facts({ machineGuid: guid, hostname: 'PC-07', windowsUsername: 'Intern' }),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });
    expect(first.status).toBe(200);

    const second = await enrollLogin({
      ...facts({ machineGuid: guid, hostname: 'PC-07', windowsUsername: 'Intern 2' }),
      email: OTHER_EMAIL,
      password: OTHER_PASSWORD,
    });

    expect(second.status).toBe(200);
    expect(second.body.deviceId).not.toBe(first.body.deviceId);
    expect(await h.prisma.device.count()).toBe(2);

    // Each person's hours are in a separate row — nobody takes anyone else's
    expect(await h.prisma.device.count({ where: { employeeId } })).toBe(1);
    expect(await h.prisma.device.count({ where: { employeeId: otherId } })).toBe(1);
  });

  /**
   * A cloned disk image — two different PCs, the same `MachineGuid`. The
   * hostnames differ, so there are two rows and both people keep working.
   */
  it('same GUID but different PCs -> two rows', async () => {
    const otherId = await addOtherStaff();
    const guid = randomUUID();

    await enrollLogin({
      ...facts({ machineGuid: guid, hostname: 'PC-07' }),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    }).expect(200);

    await enrollLogin({
      ...facts({ machineGuid: guid, hostname: 'PC-09', windowsUsername: 'sadia' }),
      email: OTHER_EMAIL,
      password: OTHER_PASSWORD,
    }).expect(200);

    expect(await h.prisma.device.count()).toBe(2);
    expect(await h.prisma.device.count({ where: { employeeId: otherId } })).toBe(1);
  });

  /**
   * What is still blocked: two people sharing the same Windows account. Their
   * hours would merge into one row and could not be separated.
   */
  it('a second staff member on the same Windows account gets 409, the first one\'s data intact', async () => {
    const otherId = await addOtherStaff();
    const same = facts({ hostname: 'PC-07', windowsUsername: 'shared' });

    const first = await enrollLogin({
      ...same,
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });
    expect(first.status).toBe(200);

    const before = await h.prisma.device.findUniqueOrThrow({
      where: { id: first.body.deviceId },
    });

    const second = await enrollLogin({
      ...same,
      machineGuid: randomUUID(),
      email: OTHER_EMAIL,
      password: OTHER_PASSWORD,
    });

    expect(second.status).toBe(409);

    const after = await h.prisma.device.findUniqueOrThrow({
      where: { id: first.body.deviceId },
    });
    expect(after.employeeId).toBe(employeeId);
    // The token did not change either — the first person's agent keeps running
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(await h.prisma.device.count({ where: { employeeId: otherId } })).toBe(0);
  });

  /** The same staff member installing again works as before — this must not break */
  it('the same staff member reinstalling updates the row', async () => {
    const same = facts({ monitors: 2 });

    const first = await enrollLogin({
      ...same,
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });
    expect(first.status).toBe(200);

    const again = await enrollLogin({
      ...same,
      monitors: 3,
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });

    expect(again.status).toBe(200);
    expect(again.body.deviceId).toBe(first.body.deviceId);
    expect(await h.prisma.device.count()).toBe(1);

    const device = await h.prisma.device.findUniqueOrThrow({
      where: { id: first.body.deviceId },
    });
    expect(device.monitors).toBe(3);
  });

  /**
   * A valid handover — if someone else is to take over the same Windows
   * account, the owner revokes first, then the new staff member can take it.
   */
  it('a revoked device can be taken by a new staff member', async () => {
    const otherId = await addOtherStaff();
    const same = facts({ hostname: 'PC-07', windowsUsername: 'shared' });

    const first = await enrollLogin({
      ...same,
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    });
    expect(first.status).toBe(200);

    await h.prisma.device.update({
      where: { id: first.body.deviceId },
      data: { status: 'revoked' },
    });

    const handover = await enrollLogin({
      ...same,
      email: OTHER_EMAIL,
      password: OTHER_PASSWORD,
    });

    expect(handover.status).toBe(200);

    const device = await h.prisma.device.findUniqueOrThrow({
      where: { id: first.body.deviceId },
    });
    expect(device.employeeId).toBe(otherId);
    expect(device.status).toBe('active');
  });
});
