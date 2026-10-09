import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Workbook } from 'exceljs';

import { HoursStatementJob } from '../src/hours-statement/hours-statement.job';
import { HoursStatementService } from '../src/hours-statement/hours-statement.service';
import {
  MAX_DELIVERY_ATTEMPTS,
  StatementDeliveryService,
} from '../src/hours-statement/statement-delivery.service';
import { Mailer, type MailMessage } from '../src/mail/mailer';
import { AppSettingsService } from '../src/settings/app-settings.service';
import { SummaryService } from '../src/summary/summary.service';
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
let sent: ({ to: readonly string[] } & MailMessage)[];

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
    sent.push({ to, ...message });
    return { outcome: 'sent' };
  });
});

/** Every cell of every sheet, as text */
async function workbookText(content: Buffer): Promise<string> {
  const wb = new Workbook();
  await wb.xlsx.load(content as unknown as ArrayBuffer);
  const cells: string[] = [];
  wb.eachSheet((sheet) =>
    sheet.eachRow((row) =>
      row.eachCell((cell) => cells.push(String(cell.text))),
    ),
  );
  return cells.join('\n');
}

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
    expect(
      await h.prisma.payPeriod.findFirstOrThrow({
        where: { snapshotAt: { not: null } },
      }),
    ).toMatchObject({ deliveryStatus: 'no_staff' });
    expect(sent).toHaveLength(0);

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

  it('a statement frozen but never sent (a restart in between) goes out at the next run, once', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 28_800);
    const open = await h.prisma.payPeriod.findFirstOrThrow();
    await h.app
      .get(HoursStatementService)
      .snapshot(open.id, local('2026-09-26T07:05'));
    expect(
      await h.prisma.payPeriod.findUniqueOrThrow({ where: { id: open.id } }),
    ).toMatchObject({ deliveryStatus: 'pending', deliveryAttempts: 0 });

    await job.tick(local('2026-09-26T08:10'));
    await job.tick(local('2026-09-26T09:10'));
    expect(sent).toHaveLength(1);
    expect(
      await h.prisma.payPeriod.findUniqueOrThrow({ where: { id: open.id } }),
    ).toMatchObject({ deliveryStatus: 'sent', deliveryAttempts: 1 });
  });

  it('a period at the attempt limit is not retried again', async () => {
    const job = h.app.get(HoursStatementJob);
    const deliver = vi
      .spyOn(h.app.get(Mailer), 'deliver')
      .mockResolvedValue({ outcome: 'failed', error: 'timeout' });
    deliver.mockClear(); // the spy outlives each test: count this test's calls only
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 28_800);
    await job.tick(local('2026-09-26T07:10'));
    expect(deliver).toHaveBeenCalledTimes(1);

    const period = await h.prisma.payPeriod.findFirstOrThrow({
      where: { snapshotAt: { not: null } },
    });
    await h.prisma.payPeriod.update({
      where: { id: period.id },
      data: { deliveryAttempts: MAX_DELIVERY_ATTEMPTS },
    });
    await job.tick(local('2026-09-26T08:10'));
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(
      await h.prisma.payPeriod.findUniqueOrThrow({ where: { id: period.id } }),
    ).toMatchObject({ deliveryAttempts: MAX_DELIVERY_ATTEMPTS });
  });

  it('no finance login and no extra address: no_recipients, nothing sent', async () => {
    await h.prisma.user.update({
      where: { email: 'fin@test.local' },
      data: { isActive: false },
    });
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 28_800);
    await job.tick(local('2026-09-26T07:10'));
    expect(sent).toHaveLength(0);
    expect(
      await h.prisma.payPeriod.findFirstOrThrow({
        where: { snapshotAt: { not: null } },
      }),
    ).toMatchObject({ deliveryStatus: 'no_recipients' });
  });

  it('inactive with no leaving date gets no line; someone who left is cut at the leaving day, days too', async () => {
    const { employeeId: gone } = await createEmployeeWithCode(h.prisma, 'HR-2');
    await h.prisma.employee.update({
      where: { id: gone },
      data: {
        fullName: 'Bea Gone',
        payBasis: 'hourly',
        status: 'inactive',
        leftOn: day('2026-09-05'),
      },
    });
    await h.prisma.employee.update({
      where: { id: employeeId },
      data: { status: 'inactive' },
    });
    for (const [date, sec] of [
      ['2026-09-01', 3_600],
      ['2026-09-10', 7_200],
    ] as const) {
      await h.prisma.dailySummary.create({
        data: {
          employeeId: gone,
          workDate: day(date),
          workedSec: sec,
          creditedSec: sec,
        },
      });
    }
    await credited('2026-09-01', 28_800);

    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await job.tick(local('2026-09-26T07:10'));

    const lines = await h.prisma.payPeriodLine.findMany();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ employeeId: gone, measuredSec: 3_600 });
    expect(lines[0].toDate.toISOString().slice(0, 10)).toBe('2026-09-05');

    const text = await workbookText(sent[0].attachments![0].content);
    expect(text).toContain('2026-09-01');
    expect(text).not.toContain('2026-09-10');
  });

  it('the email and the spreadsheet carry hours only, never an amount', async () => {
    await h.prisma.employee.update({
      where: { id: employeeId },
      data: { hourlyRate: '987.65' },
    });
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 28_800);
    await job.tick(local('2026-09-26T07:10'));

    expect(sent).toHaveLength(1);
    const { text, html, attachments } = sent[0];
    const sheet = await workbookText(attachments![0].content);
    for (const body of [text, html ?? '', sheet]) {
      expect(body).toContain('Alex Silva');
      expect(body).not.toMatch(/987|hourly ?rate|USD|\$/i);
    }
  });

  it('a cutoff change during a snapshot rolls it back; the next run freezes the new range', async () => {
    const job = h.app.get(HoursStatementJob);
    const statements = h.app.get(HoursStatementService);
    await job.tick(local('2026-09-10T06:00'));
    const open = await h.prisma.payPeriod.findFirstOrThrow();
    vi.spyOn(h.app.get(SummaryService), 'refreshDate').mockImplementationOnce(
      async () => {
        await statements.reanchorOpen(20);
        return undefined as never;
      },
    );

    await expect(
      statements.snapshot(open.id, local('2026-09-26T07:05')),
    ).rejects.toThrow(/changed while it was being frozen/);
    const after = await h.prisma.payPeriod.findUniqueOrThrow({
      where: { id: open.id },
    });
    expect(after.snapshotAt).toBeNull();
    expect(after.endDate.toISOString().slice(0, 10)).toBe('2026-09-20');
    expect(await h.prisma.payPeriodLine.count()).toBe(0);

    await job.tick(local('2026-09-26T07:10'));
    const line = await h.prisma.payPeriodLine.findFirstOrThrow();
    expect(line.toDate.toISOString().slice(0, 10)).toBe('2026-09-20');
  });

  it('one period that cannot be resent does not keep the others from going out', async () => {
    const job = h.app.get(HoursStatementJob);
    const mailer = h.app.get(Mailer);
    vi.spyOn(mailer, 'deliver').mockResolvedValue({
      outcome: 'failed',
      error: 'timeout',
    });
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 28_800);
    await job.tick(local('2026-09-26T07:10'));
    await credited('2026-10-01', 3_600);
    await job.tick(local('2026-10-26T07:10'));
    const [first, second] = await h.prisma.payPeriod.findMany({
      where: { deliveryStatus: 'failed' },
      orderBy: { startDate: 'asc' },
    });
    expect(second).toBeDefined();

    vi.spyOn(mailer, 'deliver').mockImplementation(async (to, message) => {
      sent.push({ to, ...message });
      return { outcome: 'sent' };
    });
    vi.spyOn(
      h.app.get(StatementDeliveryService),
      'deliver',
    ).mockRejectedValueOnce(new Error('boom'));
    await job.tick(local('2026-10-26T08:10'));

    expect(
      await h.prisma.payPeriod.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ deliveryStatus: 'failed' });
    expect(
      await h.prisma.payPeriod.findUniqueOrThrow({ where: { id: second.id } }),
    ).toMatchObject({ deliveryStatus: 'sent' });
    expect(sent).toHaveLength(1);
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
