import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { HoursStatementJob } from '../src/hours-statement/hours-statement.job';
import { Mailer } from '../src/mail/mailer';
import { AppSettingsService } from '../src/settings/app-settings.service';
import {
  createEmployeeWithCode,
  createHarness,
  hashPassword,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * A full cycle in the pinned zone Etc/GMT-6 (local = UTC+6), cutoff 25, send 07:00.
 * local(…) builds the instant of a local wall-clock time.
 */
let h: Harness;
let employeeId: number;
let sent: { to: readonly string[]; subject: string }[];

const local = (iso: string) =>
  new Date(Date.parse(`${iso}:00.000Z`) - 6 * 3600_000);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  // the owner's first sign-in (password change done), as on a live install
  await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
  await h.app
    .get(AppSettingsService)
    .replace('payPeriod', { cutoffDay: 25, sendTime: '07:00' }, 1);

  ({ employeeId } = await createEmployeeWithCode(h.prisma, 'HR-1'));
  await h.prisma.employee.update({
    where: { id: employeeId },
    data: { payBasis: 'hourly', hourlyRate: '10' },
  });
  await h.prisma.user.create({
    data: {
      email: 'fin@test.local',
      passwordHash: await hashPassword('fin-password-123'),
      fullName: 'Fin',
      role: 'finance',
      mustChangePw: false,
    },
  });

  sent = [];
  const mailer = h.app.get(Mailer);
  vi.spyOn(mailer, 'deliver').mockImplementation(async (to, message) => {
    sent.push({ to, subject: message.subject });
    return { outcome: 'sent' };
  });
});

const credited = (date: string, sec: number) =>
  h.prisma.dailySummary.upsert({
    where: { employeeId_workDate: { employeeId, workDate: day(date) } },
    create: {
      employeeId,
      workDate: day(date),
      workedSec: sec,
      creditedSec: sec,
    },
    update: { workedSec: sec, creditedSec: sec },
  });

describe('the hours statement cycle', () => {
  it('opens a period, sends it the day after the cutoff, carries corrections forward', async () => {
    const job = h.app.get(HoursStatementJob);

    await job.tick(local('2026-09-10T06:00'));
    const open = await h.prisma.payPeriod.findMany();
    expect(
      open.map((p) => [
        p.startDate.toISOString().slice(0, 10),
        p.endDate.toISOString().slice(0, 10),
      ]),
    ).toEqual([['2026-08-26', '2026-09-25']]);

    await credited('2026-09-01', 28_800);
    await credited('2026-09-02', 27_020);

    await job.tick(local('2026-09-26T06:30'));
    expect(sent).toHaveLength(0);

    await job.tick(local('2026-09-26T07:10'));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['fin@test.local']);
    const first = await h.prisma.payPeriodLine.findFirstOrThrow({
      where: { employeeId },
    });
    expect(first).toMatchObject({
      measuredSec: 55_820,
      carryInSec: 0,
      toPostMin: 930,
    });

    // an hour added to an already-sent day, and an hour in the new period
    await credited('2026-09-01', 32_400);
    await credited('2026-10-01', 3_600);

    await job.tick(local('2026-10-26T07:10'));
    expect(sent).toHaveLength(2);
    const lines = await h.prisma.payPeriodLine.findMany({
      where: { employeeId },
      orderBy: { id: 'asc' },
    });
    expect(lines[1]).toMatchObject({
      measuredSec: 3_600,
      carryInSec: 3_620,
      toPostMin: 120,
    });
  });

  it('server down at 07:00: sent at the next run, once', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await job.tick(local('2026-09-26T15:10'));
    await job.tick(local('2026-09-26T16:10'));
    expect(sent).toHaveLength(1);
  });

  it('first run never backfills old periods', async () => {
    await h.app.get(HoursStatementJob).tick(local('2026-10-09T10:00'));
    expect(sent).toHaveLength(0);
    expect(await h.prisma.payPeriod.count()).toBe(1);
  });

  it('a failed delivery is retried, and after 24 attempts the owner gets an alert', async () => {
    const job = h.app.get(HoursStatementJob);
    vi.spyOn(h.app.get(Mailer), 'deliver').mockResolvedValue({
      outcome: 'failed',
      error: 'timeout',
    });
    await job.tick(local('2026-09-10T06:00'));
    await job.tick(local('2026-09-26T07:10'));
    const period = await h.prisma.payPeriod.findFirstOrThrow({
      where: { snapshotAt: { not: null } },
    });
    expect(period).toMatchObject({
      deliveryStatus: 'failed',
      deliveryAttempts: 1,
      deliveryError: 'timeout',
    });

    await h.prisma.payPeriod.update({
      where: { id: period.id },
      data: { deliveryAttempts: 23 },
    });
    await job.tick(local('2026-09-26T08:10'));
    expect(
      await h.prisma.alert.count({
        where: { type: 'statement_delivery_failed' },
      }),
    ).toBe(1);
  });

  it('someone hourly only since this period gets no carry-over from before', async () => {
    const job = h.app.get(HoursStatementJob);
    await h.prisma.employee.update({
      where: { id: employeeId },
      data: { payBasis: 'monthly' },
    });
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 28_800);
    await job.tick(local('2026-09-26T07:10')); // nobody hourly: no lines
    expect(await h.prisma.payPeriodLine.count()).toBe(0);

    await h.prisma.employee.update({
      where: { id: employeeId },
      data: { payBasis: 'hourly' },
    });
    await credited('2026-10-01', 3_600);
    await job.tick(local('2026-10-26T07:10'));
    const line = await h.prisma.payPeriodLine.findFirstOrThrow({
      where: { employeeId },
    });
    expect(line).toMatchObject({
      measuredSec: 3_600,
      carryInSec: 0,
      toPostMin: 60,
    });
  });

  // needs Task 7's endpoints: switch back to `it` there
  it.todo(
    'posted can be undone until the next snapshot, then it is locked',
    async () => {
      const job = h.app.get(HoursStatementJob);
      await job.tick(local('2026-09-10T06:00'));
      await credited('2026-09-01', 36_000);
      await job.tick(local('2026-09-26T07:10'));
      const line = await h.prisma.payPeriodLine.findFirstOrThrow();

      const fin = await loginReady(h, 'fin@test.local', 'fin-password-123');
      const post = (body: object) =>
        fin.http
          .post(`/api/v1/hours-statement/lines/${line.id}/posted`)
          .set('X-CSRF-Token', fin.csrf)
          .send(body);
      await post({ postedMin: 590, note: 'rounded by hand' }).expect(201);
      await fin.http
        .delete(`/api/v1/hours-statement/lines/${line.id}/posted`)
        .set('X-CSRF-Token', fin.csrf)
        .expect(200);
      await post({ postedMin: 590 }).expect(201);

      await job.tick(local('2026-10-26T07:10'));
      await post({}).expect(409);
      const next = await h.prisma.payPeriodLine.findFirstOrThrow({
        where: { NOT: { id: line.id } },
      });
      expect(next.carryInSec).toBe(600); // 36 000 s worked − 590 min posted
    },
  );
});
