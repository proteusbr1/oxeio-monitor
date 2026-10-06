import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
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
 * The only precondition of the rollout: "no agent goes on anyone's PC without
 * a signature" ([01 section Rollout](../../docs/01-Planning.md)).
 *
 * Careful: for a while the `policy_signed_at` column existed, the API read it
 * and the web typed it, but there was no way to set it. So the precondition
 * could not be recorded in the system at all. These tests guard that path.
 */
let h: Harness;
let employeeId: number;

const today = (): string => {
  // today's date in Dhaka (UTC+6, no DST)
  const dhaka = dhakaNoon();
  return dhaka.toISOString().slice(0, 10);
};

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);

  const policy = await h.prisma.workPolicy.create({
    data: { name: 'test', monthlyTargetHours: 208, isActive: true },
  });

  const employee = await h.prisma.employee.create({
    data: { empCode: 'OX-99', fullName: 'Policy Test', policyId: policy.id },
  });

  employeeId = employee.id;
});

describe('recording a signature (rollout precondition)', () => {
  it('today\'s date is used when none is given', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http
      .post(`/api/v1/employees/${employeeId}/policy-signed`)
      .set('X-CSRF-Token', s.csrf)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.policySignedAt).toBeTruthy();
    expect(String(res.body.policySignedAt).slice(0, 10)).toBe(today());
  });

  /**
   * The paper is often signed earlier and entered in the dashboard two days
   * later. Treating the entry day as the signing day would make the record
   * disagree with the paper.
   */
  it('a past date can be given', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http
      .post(`/api/v1/employees/${employeeId}/policy-signed`)
      .set('X-CSRF-Token', s.csrf)
      .send({ signedOn: '2026-08-03' });

    expect(res.status).toBe(200);
    expect(String(res.body.policySignedAt).slice(0, 10)).toBe('2026-08-03');
  });

  /**
   * If it could be recorded before the paper is signed, the whole
   * precondition would mean nothing.
   */
  it('a future date is rejected', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const soon = dhakaNoon(3).toISOString().slice(0, 10);

    const res = await s.http
      .post(`/api/v1/employees/${employeeId}/policy-signed`)
      .set('X-CSRF-Token', s.csrf)
      .send({ signedOn: soon });

    expect(res.status).toBe(400);
  });

  it('a badly formatted date is rejected', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http
      .post(`/api/v1/employees/${employeeId}/policy-signed`)
      .set('X-CSRF-Token', s.csrf)
      .send({ signedOn: '03-08-2026' });

    expect(res.status).toBe(400);
  });

  it('unknown employee gives 404', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http
      .post('/api/v1/employees/999999/policy-signed')
      .set('X-CSRF-Token', s.csrf)
      .send({});

    expect(res.status).toBe(404);
  });
});

describe('removing a signature', () => {
  it('DELETE clears the date and the employee stays', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    await s.http
      .post(`/api/v1/employees/${employeeId}/policy-signed`)
      .set('X-CSRF-Token', s.csrf)
      .send({});

    const res = await s.http
      .delete(`/api/v1/employees/${employeeId}/policy-signed`)
      .set('X-CSRF-Token', s.csrf);

    expect(res.status).toBe(200);
    expect(res.body.policySignedAt).toBeNull();

    // The employee row is intact: DELETE must never delete the employee
    const row = await h.prisma.employee.findUnique({ where: { id: employeeId } });
    expect(row).not.toBeNull();
    expect(row?.empCode).toBe('OX-99');
  });
});

describe('audit and permissions', () => {
  /**
   * If this were folded into `change_setting`, six months later the question
   * "was their signature really taken?" could no longer be answered.
   */
  it('a separate audit action is written, with the previous value', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    await s.http
      .post(`/api/v1/employees/${employeeId}/policy-signed`)
      .set('X-CSRF-Token', s.csrf)
      .send({ signedOn: '2026-08-03' });

    await s.http
      .post(`/api/v1/employees/${employeeId}/policy-signed`)
      .set('X-CSRF-Token', s.csrf)
      .send({ signedOn: '2026-08-05' });

    await s.http
      .delete(`/api/v1/employees/${employeeId}/policy-signed`)
      .set('X-CSRF-Token', s.csrf);

    const rows = await h.prisma.auditLog.findMany({
      where: { targetId: String(employeeId) },
      orderBy: { id: 'asc' },
    });

    const actions = rows.map((r) => r.action);
    expect(actions).toContain('policy_signed');
    expect(actions).toContain('policy_signed_cleared');

    // On the second set, the earlier value must be in meta, to tell a correction from a mistake
    const second = rows.filter((r) => r.action === 'policy_signed')[1];
    expect(JSON.stringify(second.meta)).toContain('2026-08-03');
  });

  /**
   * The CSRF header must be sent: without it the CSRF guard would answer 403
   * and the test would pass for the wrong reason. Then even removing the role
   * guard would leave it green.
   */
  it('a manager cannot record a signature (the role guard, not CSRF)', async () => {
    const s = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    const res = await s.http
      .post(`/api/v1/employees/${employeeId}/policy-signed`)
      .set('X-CSRF-Token', s.csrf)
      .send({});

    expect(res.status).toBe(403);
  });

  it('closed without login', async () => {
    // No CSRF header here, on purpose: there is no session, so no token either.
    // It must be 401, not 403: this checks that the guard order is right (the
    // fix from section 3.1).
    const res = await h
      .http()
      .post(`/api/v1/employees/${employeeId}/policy-signed`)
      .send({});

    expect(res.status).toBe(401);
  });
});
