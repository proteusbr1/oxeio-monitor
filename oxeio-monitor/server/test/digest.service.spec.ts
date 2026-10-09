import { TelegramChannel } from '../src/alerts/telegram.channel';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { Mailer, SendOutcome } from '../src/mail/mailer';
import type { MailRecipients } from '../src/mail/recipients.service';
import type { MailKind } from '../src/mail/recipients.rules';
import { DigestJob } from '../src/digest/digest.job';
import type { FeaturesService } from '../src/features/features.service';
import { DigestService } from '../src/digest/digest.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { ReportsService } from '../src/reports/reports.service';
import type {
  AttendanceReport,
  ReportMeta,
  SummaryReport,
} from '../src/reports/reports.types';

/**
 * F07 — the digest's promises, without a DB.
 *
 * The most important test here is one sentence: the digest can never bring
 * the server down. A dead SMTP, a deleted work policy or a transient database
 * timeout — none of them may cost "monitoring is off". A rejected promise
 * escaping a cron callback is an unhandled rejection in Node, and that kills
 * the whole process.
 */

const meta: ReportMeta = {
  from: '2026-08-01',
  to: '2026-08-11',
  requestedTo: '2026-08-11',
  clampedToToday: false,
  days: 11,
  generatedAt: '2026-08-11T12:30:00.000Z',
  excludedEmployees: [],
  targetHoursInRange: {},
  /**
   * For staff 1: "should have 64 hours up to yesterday" — a number from the
   * server's single definition (`elapsedWindow()`). The summary row below
   * counts 40, so they are 24 hours behind.
   *
   * If left empty the expectation would be taken as 0 and nobody would be
   * "behind" — the digest's most important list would silently come out empty.
   */
  expectedHours: { 1: 64 },
  // No holidays at all in this sample world, so empty — "no possible dates"
  approximateHolidayDates: [],
  // Nobody in the sample is 'unobserved' — this fixture makes no claim about G110/G111
  observed: {},
  trackedFrom: {},
};

const attendance: AttendanceReport = {
  meta,
  rows: [
    {
      employeeId: 1,
      empCode: 'OX-001',
      fullName: '山田太郎',
      receivesTasks: false,
    department: null,
      date: '2026-08-11',
      dayType: 'workday',
      status: 'worked',
      // Nobody in the sample is on leave — this fixture makes no claim about G130
      onLeave: false,
      workedHours: 7.5,
      presenceHours: 7.5,
      idleHours: 0.5,
      adjustmentHours: 0,
    tasksDone: null,
    creditedHours: 7.5,
      targetHours: 8,
    },
  ],
  totals: {
    employees: 1,
    rows: 1,
    workedHours: 7.5,
    creditedHours: 7.5,
    targetHours: 8,
    daysWithWork: 1,
  },
};

const summary: SummaryReport = {
  meta,
  groupBy: 'month',
  overtimeNote: 'x',
  rows: [
    {
      employeeId: 1,
      empCode: 'OX-001',
      fullName: '山田太郎',
      bucket: '2026-08',
      bucketStart: '2026-08-01',
      bucketEnd: '2026-08-11',
      workdays: 9,
      daysWithWork: 8,
      workedHours: 40,
      adjustmentHours: 0,
      creditedHours: 40,
      targetHours: 72,
      shortfallHours: 32,
      overtimeHours: 0,
    },
  ],
};

interface Sent {
  to: readonly string[];
  subject: string;
  body: string;
}

function makeService(
  over: {
    outcome?: SendOutcome;
    env?: Record<string, string>;
    /** What `MailRecipients.for()` answers */
    recipients?: string[];
    reports?: Partial<ReportsService>;
  } = {},
): {
  service: DigestService;
  sent: Sent[];
  calls: { from: string; to: string }[];
  asked: MailKind[];
} {
  const sent: Sent[] = [];
  const asked: MailKind[] = [];
  const calls: { from: string; to: string }[] = [];

  const prisma = {
    // "How many PCs were silent today" — for the one Telegram line (18 August)
    alert: { findMany: () => Promise.resolve([]) },
    /**
     * The task count. Without the stub `tasksToday()` would
     * throw, caught by `logger.warn`, so the "no SMTP" test's warn count would
     * go from 1 to 2. The failure is not silent, which is what we want; it
     * just should not have a reason to happen in the tests.
     */
    employee: { findMany: () => Promise.resolve([]) },
  } as unknown as PrismaService;

  const reports = {
    attendance: (q: { from: string; to: string }) => {
      calls.push({ from: q.from, to: q.to });
      return Promise.resolve(attendance);
    },
    summary: (q: { from: string; to: string }) => {
      calls.push({ from: q.from, to: q.to });
      return Promise.resolve(summary);
    },
    ...over.reports,
  } as unknown as ReportsService;

  const mailer = {
    send: (to: readonly string[], subject: string, body: string) => {
      sent.push({ to, subject, body });
      return Promise.resolve(over.outcome ?? 'sent');
    },
  } as unknown as Mailer;

  const config = {
    get: (key: string) => over.env?.[key],
  } as unknown as ConfigService;

  /**
   * Telegram is assumed not configured — the tests in this file are about
   * email behaviour. Pulling Telegram in would blur the meaning of every claim.
   */
  const telegram = {
    send: () => Promise.resolve('not_configured' as const),
    // The daily report now goes through `sendHtml()` (monospace) — if it were
    // missing from the stub, the whole `runOnce()` would throw
    sendHtml: () => Promise.resolve('not_configured' as const),
  } as unknown as TelegramChannel;

  return {
    service: new DigestService(
      prisma,
      reports,
      mailer,
      telegram,
      config,
      { isOn: async () => true } as unknown as FeaturesService,
      {
        for: async (kind: MailKind) => {
          asked.push(kind);
          return over.recipients ?? ['owner@x.test'];
        },
      } as unknown as MailRecipients,
    ),
    sent,
    calls,
    asked,
  };
}

/** UTC 12:30 = 6:30 PM in the work zone (UTC+6) — the job runs at exactly this time */
const AT_6_30_PM = new Date('2026-08-11T12:30:00.000Z');

describe('DigestService — which range is requested', () => {
  it('today\'s single-day F01 and the 1st of the month -> today\'s F02', async () => {
    const { service, calls } = makeService();
    await service.runOnce(AT_6_30_PM);

    expect(calls).toEqual([
      { from: '2026-08-11', to: '2026-08-11' },
      { from: '2026-08-01', to: '2026-08-11' },
    ]);
  });

  it('"today" means the work zone\'s today — even when it is still yesterday in UTC', async () => {
    // UTC 11 August 20:00 = 2:00 AM on 12 August in the work zone
    const { service, calls } = makeService();
    await service.runOnce(new Date('2026-08-11T20:00:00.000Z'));

    expect(calls[0]).toEqual({ from: '2026-08-12', to: '2026-08-12' });
    expect(calls[1]).toEqual({ from: '2026-08-01', to: '2026-08-12' });
  });
});

describe('DigestService — who it goes to', () => {
  it('to whatever MailRecipients answers for the daily digest', async () => {
    const { service, sent, asked } = makeService({
      recipients: ['a@x.com', 'b@x.com'],
    });

    const result = await service.runOnce(AT_6_30_PM);

    expect(asked).toEqual(['dailyDigest']);
    expect(sent[0].to).toEqual(['a@x.com', 'b@x.com']);
    expect(result.recipients).toBe(2);
    expect(result.outcome).toBe('sent');
  });
});

describe('DigestService — without SMTP', () => {
  it('no crash, and the whole summary goes to the log', async () => {
    const { service, sent } = makeService({ outcome: 'not_configured' });
    const warn = vi
      .spyOn(
        (service as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const result = await service.runOnce(AT_6_30_PM);

    expect(result.outcome).toBe('not_configured');
    // Not just "could not send" — the numbers are in the log too, otherwise
    // on the day SMTP is fixed the earlier days would be lost for good
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(sent[0].body);
    warn.mockRestore();
  });

  it('even if sending fails the result is a value, not an exception', async () => {
    const { service } = makeService({ outcome: 'failed' });
    vi.spyOn(
      (service as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    ).mockImplementation(() => undefined);

    await expect(service.runOnce(AT_6_30_PM)).resolves.toMatchObject({
      outcome: 'failed',
    });
  });
});

describe('DigestJob — never throws', () => {
  it('even if the report throws a 500, the job quietly returns null', async () => {
    const { service } = makeService({
      reports: {
        attendance: () =>
          Promise.reject(new Error('No active work policy found')),
      } as Partial<ReportsService>,
    });

    const job = new DigestJob(service);
    vi.spyOn(
      (job as unknown as { logger: { error: (m: string, s?: string) => void } })
        .logger,
      'error',
    ).mockImplementation(() => undefined);

    await expect(job.runOnce(AT_6_30_PM)).resolves.toBeNull();
  });

  it('on success the result is returned', async () => {
    const { service } = makeService();
    const job = new DigestJob(service);

    await expect(job.runOnce(AT_6_30_PM)).resolves.toMatchObject({
      workDate: '2026-08-11',
      employees: 1,
      behind: 1,
    });
  });

  it('the scheduler is off in tests — `scheduled()` does nothing', async () => {
    const { service, sent } = makeService();
    const job = new DigestJob(service);

    // NODE_ENV=test, so SCHEDULING_ENABLED = false
    await job.scheduled();
    expect(sent).toHaveLength(0);
  });
});
