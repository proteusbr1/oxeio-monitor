import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SummaryService } from '../src/summary/summary.service';
import {
  createHarness,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/** Work regimes end to end: a 40 h/week policy and an hourly-paid person */
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

const post = (s: Session, path: string, body: object) =>
  s.http.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const patch = (s: Session, path: string, body: object) =>
  s.http.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);

describe('work policy regimes', () => {
  it('a weekly target needs its hours', async () => {
    const res = await post(owner, '/work-policies', { name: 'Weekly', targetBasis: 'week' }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/hours per week/);
  });

  it('40 h/week, Saturday and Sunday off: the month target is its workdays × 8 h', async () => {
    const policy = await post(owner, '/work-policies', {
      name: 'Full time 40h',
      targetBasis: 'week',
      weeklyTargetHours: 40,
      weeklyOffDays: [6, 7],
      overtimeMultiplier: 1.5,
      deductShortfall: false,
    }).expect(201);
    expect(policy.body).toMatchObject({ targetBasis: 'week', weeklyTargetHours: 40, overtimeMultiplier: 1.5, deductShortfall: false });

    const staff = await post(owner, '/employees', {
      fullName: 'Hourly Person',
      policyId: policy.body.id,
      joinedOn: '2026-01-05',
      payBasis: 'hourly',
      hourlyRate: '25',
    }).expect(201);
    expect(staff.body).toMatchObject({ payBasis: 'hourly', hourlyRate: '25.00' });

    // October 2026: 22 days Monday–Friday, no holidays in the test calendar
    await h.app.get(SummaryService).refreshDate(new Date('2026-10-15T00:00:00Z'), new Date('2026-11-01T06:00:00Z'));
    const row = await h.prisma.monthlySummary.findFirstOrThrow({ where: { employeeId: staff.body.id, yearMonth: '2026-10' } });
    expect(row.targetSec).toBe(22 * 8 * 3600);

    const sheet = await owner.http.get('/api/v1/payroll?month=2026-10').expect(200);
    const line = (sheet.body.rows as { employeeId: number }[]).find((r) => r.employeeId === staff.body.id);
    expect(line).toMatchObject({ payBasis: 'hourly', hourlyRate: '25.00', deduction: '0.00' });
  });

  it('no target: hours only, nobody behind', async () => {
    const policy = await post(owner, '/work-policies', { name: 'Freelance', targetBasis: 'none' }).expect(201);
    const staff = await post(owner, '/employees', { fullName: 'Free Lancer', policyId: policy.body.id, joinedOn: '2026-01-05' }).expect(201);
    await h.app.get(SummaryService).refreshDate(new Date('2026-10-15T00:00:00Z'), new Date('2026-11-01T06:00:00Z'));
    const row = await h.prisma.monthlySummary.findFirstOrThrow({ where: { employeeId: staff.body.id, yearMonth: '2026-10' } });
    expect(row).toMatchObject({ targetSec: 0, expectedSec: 0, paceSec: 0, shortfallSec: 0, targetMet: false });
  });
});

describe('pay terms', () => {
  it('a manager neither sees nor changes them', async () => {
    const staff = await post(owner, '/employees', { fullName: 'Paid Person', payBasis: 'hourly', hourlyRate: '30' }).expect(201);
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    const seen = await manager.http.get(`/api/v1/employees/${staff.body.id}`).expect(200);
    expect('hourlyRate' in seen.body).toBe(false);
    expect('payBasis' in seen.body).toBe(false);
    await patch(manager, `/employees/${staff.body.id}`, { payBasis: 'monthly' }).expect(403);
  });

  it('changing from a salary to an hourly rate keeps the salary as history', async () => {
    const staff = await post(owner, '/employees', { fullName: 'Switcher', monthlySalary: '5000' }).expect(201);
    await patch(owner, `/employees/${staff.body.id}`, { payBasis: 'hourly', hourlyRate: '30', monthlySalary: null }).expect(200);
    const history = await h.prisma.salaryPeriod.findMany({ where: { employeeId: staff.body.id } });
    expect(history).toHaveLength(1);
    expect(history[0].payBasis).toBe('monthly');
    expect(String(history[0].monthlySalary)).toBe('5000');
  });
});
