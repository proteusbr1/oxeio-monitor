import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createEmployeeWithCode,
  createHarness,
  hashPassword,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
  uniqueSuffix,
} from './setup/harness';

/**
 * Employee deactivated, then reactivated: can they log in?
 *
 * Careful: this file comes from a field bug, and the bug was completely
 * silent. `deactivate()` set `is_active = false` on the employee's `users`
 * row, but `reactivate()` did not restore it. As a result:
 *
 *   1. the Staff screen showed the employee as Active
 *   2. "Reset password" succeeded and displayed a new password
 *   3. login always said "Email or password is incorrect"
 *
 * The login message is deliberately always the same (to prevent user
 * enumeration), so there was no way to see the cause: the owner reset again
 * and again and got the same message every time.
 */
let h: Harness;
let owner: Session;

const PASSWORD = 'staff-password-123';

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

/** An employee plus their portal account: a unique email, to avoid the throttle counter */
async function staffWithLogin(code: string) {
  const { employeeId } = await createEmployeeWithCode(h.prisma, code);
  const email = `${code.toLowerCase()}-${uniqueSuffix()}@test.local`;

  const user = await h.prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      fullName: 'Rafiq Alam',
      role: 'employee',
      employeeId,
      mustChangePw: false,
    },
  });

  return { employeeId, userId: user.id, email };
}

const signIn = (email: string, password: string) =>
  h.http().post('/api/v1/auth/login').send({ email, password });

const deactivate = (employeeId: number) =>
  owner.http
    .post(`/api/v1/employees/${employeeId}/deactivate`)
    .set('X-CSRF-Token', owner.csrf)
    .send({ leftOn: '2026-08-01', reason: 'lifecycle test' });

const reactivate = (employeeId: number) =>
  owner.http
    .post(`/api/v1/employees/${employeeId}/reactivate`)
    .set('X-CSRF-Token', owner.csrf);

describe('deactivate then reactivate: login comes back', () => {
  it('deactivating closes login', async () => {
    const { employeeId, email } = await staffWithLogin('LC-OFF');

    await signIn(email, PASSWORD).expect(200);
    await deactivate(employeeId).expect(200);

    await signIn(email, PASSWORD).expect(401);
  });

  /** The core test of this file: it did not exist before, so the bug went unnoticed */
  it('after reactivation the old password works again', async () => {
    const { employeeId, email } = await staffWithLogin('LC-BACK');

    await deactivate(employeeId).expect(200);
    await reactivate(employeeId).expect(200);

    await signIn(email, PASSWORD).expect(200);
  });

  it('is_active comes back in the database too', async () => {
    const { employeeId, userId } = await staffWithLogin('LC-DB');

    await deactivate(employeeId).expect(200);
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: userId } })).isActive).toBe(
      false,
    );

    await reactivate(employeeId).expect(200);
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: userId } })).isActive).toBe(
      true,
    );
  });

  /**
   * Accounts unrelated to the employee must not be touched: with a wrong
   * `where` in `updateMany`, restoring one person would have unlocked
   * everyone's login, including employees who had left.
   */
  it('nobody else\'s login is touched', async () => {
    const a = await staffWithLogin('LC-A');
    const b = await staffWithLogin('LC-B');

    await deactivate(a.employeeId).expect(200);
    await deactivate(b.employeeId).expect(200);
    await reactivate(a.employeeId).expect(200);

    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: b.userId } })).isActive).toBe(
      false,
    );
  });

  it('the audit log also records how many logins were restored', async () => {
    const { employeeId } = await staffWithLogin('LC-AUDIT');

    await deactivate(employeeId).expect(200);
    await reactivate(employeeId).expect(200);

    const row = await h.prisma.auditLog.findFirstOrThrow({
      // `target_id` is a string column: passing a number matches nothing
      where: { targetId: String(employeeId), action: 'change_setting' },
      orderBy: { id: 'desc' },
    });

    expect(row.meta).toMatchObject({ op: 'reactivate', portalRestored: 1 });
  });
});

describe('password reset on an inactive account', () => {
  /**
   * This is the silence that kept the bug invisible: the reset succeeded and
   * showed a password, but it never worked.
   */
  it('is refused, and says why', async () => {
    const { employeeId, userId } = await staffWithLogin('LC-RESET');
    await deactivate(employeeId).expect(200);

    const res = await owner.http
      .post(`/api/v1/users/${userId}/reset-password`)
      .set('X-CSRF-Token', owner.csrf);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/inactive/i);
    // The message says what to do, not only what is wrong
    expect(res.body.message).toMatch(/Reactivate/i);
  });

  it('after reactivation a reset works, and the new password works', async () => {
    const { employeeId, userId, email } = await staffWithLogin('LC-FIXED');

    await deactivate(employeeId).expect(200);
    await reactivate(employeeId).expect(200);

    const res = await owner.http
      .post(`/api/v1/users/${userId}/reset-password`)
      .set('X-CSRF-Token', owner.csrf)
      .expect(200);

    await signIn(email, res.body.tempPassword).expect(200);
  });

  /**
   * A reset does not reactivate the account by itself; otherwise someone
   * fixing a password could unknowingly unlock a departed employee's login.
   */
  it('a reset does not unlock the account by itself', async () => {
    const { employeeId, userId } = await staffWithLogin('LC-NOAUTO');
    await deactivate(employeeId).expect(200);

    await owner.http
      .post(`/api/v1/users/${userId}/reset-password`)
      .set('X-CSRF-Token', owner.csrf);

    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: userId } })).isActive).toBe(
      false,
    );
  });
});
