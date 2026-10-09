import {
  afterAll,
  afterEach,
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
  type Session,
} from './setup/harness';

/**
 * A full cycle in the pinned zone Etc/GMT-6 (local = UTC+6), cutoff 25, send 07:00.
 * local(…) builds the instant of a local wall-clock time.
 */
let h: Harness;
let owner: Session;
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
// a spy that throws must not outlive its test
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  // the owner's first sign-in (password change done), as on a live install
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
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
    // one period frozen already: a cutoff change moves only the open end
    await job.tick(local('2026-08-10T06:00'));
    await job.tick(local('2026-08-26T07:10'));
    const open = await h.prisma.payPeriod.findFirstOrThrow({
      where: { snapshotAt: null },
    });
    expect(open.startDate.toISOString().slice(0, 10)).toBe('2026-08-26');
    vi.spyOn(h.app.get(SummaryService), 'refreshDate').mockImplementationOnce(
      async () => {
        await statements.reanchorOpen(20, '2026-09-26');
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
    expect(
      await h.prisma.payPeriodLine.count({ where: { periodId: open.id } }),
    ).toBe(0);

    await job.tick(local('2026-09-26T07:10'));
    const line = await h.prisma.payPeriodLine.findFirstOrThrow({
      where: { periodId: open.id },
    });
    expect(line.toDate.toISOString().slice(0, 10)).toBe('2026-09-20');
  });

  it('a snapshot that throws does not keep a failed statement from being retried', async () => {
    const job = h.app.get(HoursStatementJob);
    const mailer = h.app.get(Mailer);
    vi.spyOn(mailer, 'deliver').mockResolvedValue({
      outcome: 'failed',
      error: 'timeout',
    });
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 28_800);
    await job.tick(local('2026-09-26T07:10'));
    const first = await h.prisma.payPeriod.findFirstOrThrow({
      where: { deliveryStatus: 'failed' },
    });

    vi.spyOn(mailer, 'deliver').mockImplementation(async (to, message) => {
      sent.push({ to, ...message });
      return { outcome: 'sent' };
    });
    vi.spyOn(h.app.get(HoursStatementService), 'snapshot').mockRejectedValue(
      new Error('database gone'),
    );
    await expect(job.tick(local('2026-10-26T07:10'))).resolves.toBeUndefined();

    expect(
      await h.prisma.payPeriod.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ deliveryStatus: 'sent' });
    expect(
      await h.prisma.payPeriod.count({ where: { snapshotAt: null } }),
    ).toBe(1);
  });

  it('a period still not frozen 3 hours after its send moment raises an alert', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    vi.spyOn(h.app.get(HoursStatementService), 'snapshot').mockRejectedValue(
      new Error('database gone'),
    );
    const alerts = () =>
      h.prisma.alert.findMany({
        where: { type: 'statement_delivery_failed' },
      });

    await job.tick(local('2026-09-26T07:10'));
    await job.tick(local('2026-09-26T09:10'));
    expect(await alerts()).toHaveLength(0);

    await job.tick(local('2026-09-26T10:10'));
    const raised = await alerts();
    expect(raised).toHaveLength(1);
    expect(raised[0].title).toBe('The hours statement could not be prepared');
    expect(sent).toHaveLength(0);
  });

  it('a concurrent drain that already cleared a dirty mark does not abort the freeze', async () => {
    const job = h.app.get(HoursStatementJob);
    const summary = h.app.get(SummaryService);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 28_800);
    await h.prisma.summaryDirty.create({
      data: { workDate: day('2026-09-02') },
    });
    const refresh = summary.refreshDate.bind(summary);
    vi.spyOn(summary, 'refreshDate').mockImplementation(async (date, now) => {
      // another drain (the summary cron) counts the same day and clears it first
      await h.prisma.summaryDirty.deleteMany({ where: { workDate: date } });
      return refresh(date, now);
    });

    await job.tick(local('2026-09-26T07:10'));
    expect(
      await h.prisma.payPeriod.count({ where: { snapshotAt: { not: null } } }),
    ).toBe(1);
    expect(sent).toHaveLength(1);
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

  it('posted can be undone until the next snapshot, then it is locked', async () => {
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
  });
});

describe('hours statement endpoints', () => {
  it('finance lists periods and sees live numbers for the open one; no money in the answer', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 3_600);

    const fin = await loginReady(h, 'fin@test.local', 'fin-password-123');
    const list = await fin.http
      .get('/api/v1/hours-statement/periods')
      .expect(200);
    expect(list.body[0]).toMatchObject({
      start: '2026-08-26',
      end: '2026-09-25',
      open: true,
    });

    const view = await fin.http
      .get(`/api/v1/hours-statement/periods/${list.body[0].id}`)
      .expect(200);
    expect(view.body.lines[0]).toMatchObject({
      id: null,
      measuredSec: 3_600,
      toPostMin: 60,
    });
    expect(JSON.stringify(view.body)).not.toMatch(
      /hourlyRate|monthlySalary|salary/i,
    );

    const days = await fin.http
      .get(
        `/api/v1/hours-statement/periods/${list.body[0].id}/people/${employeeId}`,
      )
      .expect(200);
    expect(days.body).toHaveLength(1);
    expect(days.body[0]).toMatchObject({
      date: '2026-09-01',
      creditedHours: 1,
    });
  });

  it('a frozen period answers its stored lines; a negative posted value is kept', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 3_600);
    await job.tick(local('2026-09-26T07:10'));
    const period = await h.prisma.payPeriod.findFirstOrThrow({
      where: { snapshotAt: { not: null } },
    });
    const line = await h.prisma.payPeriodLine.findFirstOrThrow();

    const fin = await loginReady(h, 'fin@test.local', 'fin-password-123');
    const post = (body: object) =>
      fin.http
        .post(`/api/v1/hours-statement/lines/${line.id}/posted`)
        .set('X-CSRF-Token', fin.csrf)
        .send(body);
    await post({ postedMin: 1.5 }).expect(400);
    await post({ postedMin: -30, note: 'overpaid before' }).expect(201);

    const view = await fin.http
      .get(`/api/v1/hours-statement/periods/${period.id}`)
      .expect(200);
    expect(view.body.locked).toBe(false);
    expect(view.body.lines[0]).toMatchObject({
      id: line.id,
      postedMin: -30,
      postedBy: 'Fin',
      note: 'overpaid before',
    });
    const days = await fin.http
      .get(`/api/v1/hours-statement/periods/${period.id}/people/${employeeId}`)
      .expect(200);
    // the freeze refreshes the last day too, so an empty row may sit beside the credited one
    expect(days.body).toContainEqual(
      expect.objectContaining({ date: '2026-09-01', creditedHours: 1 }),
    );
  });

  it('resend is owner only', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 3_600);
    await job.tick(local('2026-09-26T07:10'));
    const period = await h.prisma.payPeriod.findFirstOrThrow({
      where: { snapshotAt: { not: null } },
    });

    const fin = await loginReady(h, 'fin@test.local', 'fin-password-123');
    await fin.http
      .post(`/api/v1/hours-statement/periods/${period.id}/resend`)
      .set('X-CSRF-Token', fin.csrf)
      .expect(403);
    const res = await owner.http
      .post(`/api/v1/hours-statement/periods/${period.id}/resend`)
      .set('X-CSRF-Token', owner.csrf)
      .expect(201);
    expect(res.body.status).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('resend sends the stored statement after recipients were fixed, and refuses an open period', async () => {
    await h.prisma.user.update({
      where: { email: 'fin@test.local' },
      data: { isActive: false },
    });
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 3_600);
    const openPeriod = await h.prisma.payPeriod.findFirstOrThrow();
    await owner.http
      .post(`/api/v1/hours-statement/periods/${openPeriod.id}/resend`)
      .set('X-CSRF-Token', owner.csrf)
      .expect(404);

    await job.tick(local('2026-09-26T07:10'));
    expect(sent).toHaveLength(0);
    expect(
      await h.prisma.payPeriod.findUniqueOrThrow({
        where: { id: openPeriod.id },
      }),
    ).toMatchObject({ deliveryStatus: 'no_recipients' });

    await h.prisma.user.update({
      where: { email: 'fin@test.local' },
      data: { isActive: true },
    });
    const res = await owner.http
      .post(`/api/v1/hours-statement/periods/${openPeriod.id}/resend`)
      .set('X-CSRF-Token', owner.csrf)
      .expect(201);
    expect(res.body.status).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('changing the cutoff after a period was frozen moves only the open end', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await job.tick(local('2026-09-26T07:10'));
    const res = await owner.http
      .put('/api/v1/settings/pay-period')
      .set('X-CSRF-Token', owner.csrf)
      .send({ cutoffDay: 'end', sendTime: '07:00' })
      .expect(200);
    expect(res.body.open).toEqual({ start: '2026-09-26', end: '2026-09-30' });

    await owner.http
      .put('/api/v1/settings/pay-period')
      .set('X-CSRF-Token', owner.csrf)
      .send({ cutoffDay: 31, sendTime: '07:00' })
      .expect(400);
    const fin = await loginReady(h, 'fin@test.local', 'fin-password-123');
    await fin.http.get('/api/v1/settings/pay-period').expect(403);
  });

  it('saving the same cutoff (only the send time changed) leaves the open period as it is', async () => {
    await h.app.get(HoursStatementJob).tick(local('2026-10-09T10:00'));
    const res = await owner.http
      .put('/api/v1/settings/pay-period')
      .set('X-CSRF-Token', owner.csrf)
      .send({ cutoffDay: 25, sendTime: '08:00' })
      .expect(200);
    expect(res.body.open).toEqual({ start: '2026-09-26', end: '2026-10-25' });
  });

  it('the file downloads', async () => {
    await h.app.get(HoursStatementJob).tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 3_600);
    const period = await h.prisma.payPeriod.findFirstOrThrow();
    const res = await owner.http
      .get(`/api/v1/hours-statement/periods/${period.id}/file`)
      .expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });
});

describe('setting the cutoff before the first period is frozen', () => {
  const ranges = async () =>
    (await h.prisma.payPeriod.findMany({ orderBy: { startDate: 'asc' } })).map(
      (p) => [
        p.startDate.toISOString().slice(0, 10),
        p.endDate.toISOString().slice(0, 10),
        p.snapshotAt === null ? 'open' : 'frozen',
      ],
    );
  const useCutoff = (cutoffDay: 25 | 'end') =>
    h.app
      .get(AppSettingsService)
      .replace('payPeriod', { cutoffDay, sendTime: '07:00' }, 1);

  it('first run with the default end of month, cutoff 25 set on 9 October: the period holding today', async () => {
    await useCutoff('end');
    await h.app.get(HoursStatementJob).tick(local('2026-10-09T10:00'));
    expect(await ranges()).toEqual([['2026-10-01', '2026-10-31', 'open']]);

    await useCutoff(25);
    await h.app.get(HoursStatementService).reanchorOpen(25, '2026-10-09');
    expect(await ranges()).toEqual([['2026-09-26', '2026-10-25', 'open']]);
  });

  it('cutoff 25 set on 28 October: 26 October – 25 November, nothing frozen or emailed', async () => {
    await useCutoff('end');
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-10-28T10:00'));
    await credited('2026-10-02', 3_600);

    await useCutoff(25);
    await h.app.get(HoursStatementService).reanchorOpen(25, '2026-10-28');
    await job.tick(local('2026-10-28T11:10'));
    expect(await ranges()).toEqual([['2026-10-26', '2026-11-25', 'open']]);
    expect(await h.prisma.payPeriodLine.count()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
