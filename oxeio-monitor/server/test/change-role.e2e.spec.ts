import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createEmployeeWithCode,
  createHarness,
  hashPassword,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
  uniqueSuffix,
} from './setup/harness';

/**
 * Staff and manager: changing the role of a portal account.
 *
 * Careful: the role used to be set only when the account was created. To make
 * someone a manager, their account had to be deleted and recreated: a new
 * password, and all history tied to `user_id` (the audit log) was cut.
 */
let h: Harness;
let owner: Session;

const PASSWORD = 'role-test-password-123';

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

async function staffWithLogin(code: string, role: 'employee' | 'manager' = 'employee') {
  const { employeeId } = await createEmployeeWithCode(h.prisma, code);
  const email = `${code.toLowerCase()}-${uniqueSuffix()}@test.local`;

  const user = await h.prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      fullName: 'Rafiq Alam',
      role,
      employeeId,
      mustChangePw: false,
    },
  });

  return { employeeId, userId: user.id, email };
}

const setRole = (userId: number, role: string) =>
  owner.http
    .patch(`/api/v1/users/${userId}/role`)
    .set('X-CSRF-Token', owner.csrf)
    .send({ role });

describe('PATCH /users/:id/role', () => {
  it('staff can be made a manager', async () => {
    const { userId } = await staffWithLogin('RL-UP');

    const res = await setRole(userId, 'manager').expect(200);

    expect(res.body.role).toBe('manager');
    expect(
      (await h.prisma.user.findUniqueOrThrow({ where: { id: userId } })).role,
    ).toBe('manager');
  });

  it('a manager can be made staff again', async () => {
    const { userId } = await staffWithLogin('RL-DOWN', 'manager');

    await setRole(userId, 'employee').expect(200);

    expect(
      (await h.prisma.user.findUniqueOrThrow({ where: { id: userId } })).role,
    ).toBe('employee');
  });

  /**
   * Careful: owner cannot be granted from here either. Owner is the key to
   * payroll, the audit log and settings, which should not change hands with
   * one click on a dropdown. The DTO itself blocks it, so the request never
   * reaches the business code.
   */
  it('cannot create an owner', async () => {
    const { userId } = await staffWithLogin('RL-OWNER');

    await setRole(userId, 'owner').expect(400);

    expect(
      (await h.prisma.user.findUniqueOrThrow({ where: { id: userId } })).role,
    ).toBe('employee');
  });

  it('unknown role gives 400', async () => {
    const { userId } = await staffWithLogin('RL-JUNK');

    await setRole(userId, 'superadmin').expect(400);
    await setRole(userId, '').expect(400);
  });

  /**
   * Careful: the owner's role cannot be taken away either. Getting into this
   * route requires being the owner, so demoting oneself would lock everyone
   * out, and the way back would be the `recover-owner` script on the server.
   */
  it('cannot demote the owner', async () => {
    const ownerUser = await h.prisma.user.findFirstOrThrow({
      where: { email: OWNER_EMAIL },
    });

    const res = await setRole(ownerUser.id, 'employee');

    expect(res.status).toBe(409);
    expect(
      (await h.prisma.user.findUniqueOrThrow({ where: { id: ownerUser.id } })).role,
    ).toBe('owner');
  });

  it('a manager cannot touch this route', async () => {
    const { userId } = await staffWithLogin('RL-NOPE');
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await manager.http
      .patch(`/api/v1/users/${userId}/role`)
      .set('X-CSRF-Token', manager.csrf)
      .send({ role: 'manager' })
      .expect(403);
  });

  it('unknown user gives 404', async () => {
    await setRole(999_999, 'manager').expect(404);
  });

  /** Setting the same role writes no "change" in the audit log */
  it('setting the same role leaves nothing in history', async () => {
    const { userId } = await staffWithLogin('RL-SAME');
    await h.prisma.auditLog.deleteMany({});

    await setRole(userId, 'employee').expect(200);

    const rows = await h.prisma.auditLog.findMany({
      where: { targetId: String(userId) },
    });
    expect(rows).toHaveLength(0);
  });

  it('a real change is recorded in history, with the previous role', async () => {
    const { userId } = await staffWithLogin('RL-AUDIT');

    await setRole(userId, 'manager').expect(200);

    const row = await h.prisma.auditLog.findFirstOrThrow({
      where: { targetId: String(userId) },
      orderBy: { id: 'desc' },
    });

    // The old value is stored too: with only the new value, "who became a
    // manager and when" could not be answered
    expect(row.meta).toMatchObject({
      op: 'change_role',
      from: 'employee',
      to: 'manager',
    });
  });

  /** The password is not touched: changing a role must not break anyone's login */
  it('the password stays intact', async () => {
    const { userId, email } = await staffWithLogin('RL-PW');

    await setRole(userId, 'manager').expect(200);

    await h
      .http()
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
  });
});
