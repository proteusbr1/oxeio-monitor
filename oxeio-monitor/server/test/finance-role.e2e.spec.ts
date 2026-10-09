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
} from './setup/harness';

let h: Harness;
let finance: Session;
const PASSWORD = 'finance-password-123';

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  const { employeeId } = await createEmployeeWithCode(h.prisma, 'FIN-1');
  await h.prisma.user.create({
    data: {
      email: 'finance@test.local',
      passwordHash: await hashPassword(PASSWORD),
      fullName: 'Finance Person',
      role: 'finance',
      employeeId,
      mustChangePw: false,
    },
  });
  finance = await loginReady(h, 'finance@test.local', PASSWORD);
});

describe('the finance role', () => {
  it('loads the dashboard shell', async () => {
    for (const path of [
      '/auth/me',
      '/auth/time-zone',
      '/auth/currency',
      '/account',
      '/features',
    ]) {
      const res = await finance.http.get(`/api/v1${path}`);
      expect(res.status, path).toBe(200);
    }
  });

  it('is refused everywhere else', async () => {
    const refused = [
      '/me',
      '/employees',
      '/work-policies',
      '/payroll?month=2026-10',
      '/reports/attendance?from=2026-10-01&to=2026-10-02',
      '/screenshots/latest',
      '/alerts',
      '/schedule/people',
      '/settings/smtp',
      '/settings/region',
      '/audit-log',
    ];
    for (const path of refused) {
      const res = await finance.http.get(`/api/v1${path}`);
      expect(res.status, path).toBe(403);
    }
  });

  it('the owner can make a portal login finance', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const user = await h.prisma.user.findUniqueOrThrow({
      where: { email: 'finance@test.local' },
    });
    await h.prisma.user.update({
      where: { id: user.id },
      data: { role: 'employee' },
    });
    const res = await owner.http
      .patch(`/api/v1/users/${user.id}/role`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ role: 'finance' })
      .expect(200);
    expect(res.body.role).toBe('finance');
  });
});
