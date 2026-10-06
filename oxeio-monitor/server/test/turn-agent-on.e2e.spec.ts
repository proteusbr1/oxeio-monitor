import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/**
 * **Turning a stopped agent back on** — per employee, not per device.
 *
 * This is needed because `deactivate()` revokes all of an employee's devices,
 * and `reactivate()` **deliberately does not restore them** (a returning
 * employee's old tokens should not wake up by themselves). As a result they
 * would stay "Offline" on the board forever, although the agent runs fine on
 * their PC — and the only way back was the separate Devices screen, which the
 * owner asked to be removed.
 */
let h: Harness;
let owner: Session;

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

const turnOn = (employeeId: number) =>
  owner.http
    .post(`/api/v1/employees/${employeeId}/agent/turn-on`)
    .set('X-CSRF-Token', owner.csrf);

const deactivate = (employeeId: number) =>
  owner.http
    .post(`/api/v1/employees/${employeeId}/deactivate`)
    .set('X-CSRF-Token', owner.csrf)
    .send({ leftOn: '2026-08-01', reason: 'turn-agent-on test' });

const reactivate = (employeeId: number) =>
  owner.http
    .post(`/api/v1/employees/${employeeId}/reactivate`)
    .set('X-CSRF-Token', owner.csrf);

const statusOf = async (deviceId: number) =>
  (await h.prisma.device.findUniqueOrThrow({ where: { id: deviceId } })).status;

describe('POST /employees/:id/agent/turn-on', () => {
  /**
   * **The main test of this file — the owner's real journey.**
   * Deactivated → activated again → agent turned on → everything as before.
   */
  it('after deactivating and restoring, the agent can be turned on again', async () => {
    const { code, employeeId } = await createEmployeeWithCode(h.prisma, 'TA-BACK');
    const device = await enrollDevice(h, code);

    await deactivate(employeeId).expect(200);
    expect(await statusOf(device.deviceId)).toBe('revoked');

    // Only reactivate does not restore devices — deliberate
    await reactivate(employeeId).expect(200);
    expect(await statusOf(device.deviceId)).toBe('revoked');

    const res = await turnOn(employeeId).expect(200);

    expect(res.body.restored).toBe(1);
    expect(await statusOf(device.deviceId)).toBe('active');
  });

  /**
   * The devices of a deactivated employee cannot be restored — otherwise the
   * machine of someone who was dismissed would start sending hours again,
   * while the Staff screen shows them "Inactive".
   */
  it('blocked when the employee is inactive, and says why', async () => {
    const { code, employeeId } = await createEmployeeWithCode(h.prisma, 'TA-OFF');
    const device = await enrollDevice(h, code);
    await deactivate(employeeId).expect(200);

    const res = await turnOn(employeeId);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/reactivate/i);
    expect(await statusOf(device.deviceId)).toBe('revoked');
  });

  it('nothing changes when nothing is stopped', async () => {
    const { code, employeeId } = await createEmployeeWithCode(h.prisma, 'TA-NOOP');
    const device = await enrollDevice(h, code);

    const res = await turnOn(employeeId).expect(200);

    expect(res.body.restored).toBe(0);
    expect(await statusOf(device.deviceId)).toBe('active');
  });

  /** Nothing in audit when nothing changed */
  it('no row piles up in history when nothing changed', async () => {
    const { code, employeeId } = await createEmployeeWithCode(h.prisma, 'TA-QUIET');
    await enrollDevice(h, code);
    await h.prisma.auditLog.deleteMany({});

    await turnOn(employeeId).expect(200);

    const rows = await h.prisma.auditLog.findMany({
      where: { targetId: String(employeeId) },
    });
    expect(rows).toHaveLength(0);
  });

  it('a real change goes into history, with how many came back', async () => {
    const { code, employeeId } = await createEmployeeWithCode(h.prisma, 'TA-AUDIT');
    await enrollDevice(h, code);
    await deactivate(employeeId).expect(200);
    await reactivate(employeeId).expect(200);

    await turnOn(employeeId).expect(200);

    const row = await h.prisma.auditLog.findFirstOrThrow({
      where: { targetId: String(employeeId), action: 'change_setting' },
      orderBy: { id: 'desc' },
    });
    expect(row.meta).toMatchObject({ op: 'turn_agent_on', restored: 1 });
  });

  /**
   * Another employee's devices must not be touched — if the `where` of
   *    `updateMany` were wrong, restoring one person would wake **everyone's** stopped machines.
   */
  it("another person's devices are not touched", async () => {
    const a = await createEmployeeWithCode(h.prisma, 'TA-A');
    const b = await createEmployeeWithCode(h.prisma, 'TA-B');
    /**
     * A separate `machineGuid` is a must. Enroll upserts on `machineGuid`,
     *    so enrolling a second time with the same GUID **does not create a new
     *    row** — the first row moves to the second employee's name, and then
     *    the test no longer measures what it means to measure.
     */
    const deviceA = await enrollDevice(h, a.code, {
      machineGuid: 'ta-a-guid',
      hostname: 'PC-TA-A',
    });
    // hostname is separate too — the (hostname, windowsUsername) pair is also
    //    unique, and enrolling a second time with the same pair gives 409.
    const deviceB = await enrollDevice(h, b.code, {
      machineGuid: 'ta-b-guid',
      hostname: 'PC-TA-B',
    });

    await deactivate(a.employeeId).expect(200);
    await deactivate(b.employeeId).expect(200);
    await reactivate(a.employeeId).expect(200);

    await turnOn(a.employeeId).expect(200);

    expect(await statusOf(deviceA.deviceId)).toBe('active');
    expect(await statusOf(deviceB.deviceId)).toBe('revoked');
  });

  it('unknown employee 404', async () => {
    await turnOn(999_999).expect(404);
  });

  /**
   * **A manager cannot — deliberate.** A manager sees the Staff screen, so the
   * button is in their sight too. But turning an agent back on means **waking
   * old tokens again** — with a lost laptop, whoever holds it comes back too.
   * That is the owner's decision, and that is why the route is kept in the
   * owner-only controller.
   */
  it("a manager cannot — waking old tokens is the owner's decision", async () => {
    const { code, employeeId } = await createEmployeeWithCode(h.prisma, 'TA-MGR');
    await enrollDevice(h, code);
    await deactivate(employeeId).expect(200);
    await reactivate(employeeId).expect(200);

    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http
      .post(`/api/v1/employees/${employeeId}/agent/turn-on`)
      .set('X-CSRF-Token', manager.csrf)
      .expect(403);
  });
});
