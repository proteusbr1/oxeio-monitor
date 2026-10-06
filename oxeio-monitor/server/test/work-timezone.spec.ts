import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * WORK_TIMEZONE — the work-day zone is configurable, Asia/Dhaka by default,
 * and daylight saving is supported (Europe/Lisbon, America/Santiago below).
 *
 * The zone is read from `process.env` when `work-time.ts` is imported
 * (the `@Cron` options need it before Nest exists), so each case here
 * re-imports the modules under a stubbed env instead of calling a setter.
 *
 * Two promises are checked:
 *  1. With nothing set, every value is exactly what it was when the offset
 *     was the constant 360 — the rest of the suite already runs that way.
 *  3. With daylight saving, each instant uses the offset in force then: one
 *     day a year has 23 hours, one has 25, and a skipped midnight is handled.
 *  2. A negative offset (America/Sao_Paulo, UTC−3) cuts days at its own
 *     midnight, including across month and year boundaries. Before, the
 *     Brazilian work day turned over at 15:00 local time.
 */

async function load(timeZone?: string) {
  vi.resetModules();
  if (timeZone === undefined) vi.stubEnv('WORK_TIMEZONE', '');
  else vi.stubEnv('WORK_TIMEZONE', timeZone);

  return {
    time: await import('../src/agent/util/work-time'),
    alerts: await import('../src/alerts/alerts.rules'),
    summary: await import('../src/summary/summary.math'),
    ops: await import('../src/ops/ops.rules'),
    scheduling: await import('../src/summary/scheduling'),
    digest: await import('../src/digest/digest.math'),
    pdf: await import('../src/reports/reports.pdf.text'),
    dash: await import('../src/dashboard/dashboard.math'),
    agentConfig: await import('../src/agent/agent-config.service'),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const at = (iso: string): Date => new Date(iso);
const day = (d: Date): string => d.toISOString().slice(0, 10);

describe('assertKnownZone', () => {
  it('accepts any IANA zone, daylight saving or not', async () => {
    const { time } = await load();
    for (const z of ['Asia/Dhaka', 'America/Sao_Paulo', 'Europe/London', 'Australia/Sydney', 'UTC']) {
      expect(() => time.assertKnownZone(z)).not.toThrow();
    }
  });

  it('refuses an unknown name', async () => {
    const { time } = await load();
    expect(() => time.assertKnownZone('Mars/Olympus')).toThrow(/IANA/);
  });

  it('an unknown WORK_TIMEZONE stops the import, not a silent fallback', async () => {
    await expect(load('Mars/Olympus')).rejects.toThrow(/IANA/);
  });
});

describe('default (WORK_TIMEZONE unset) — unchanged', () => {
  it('is Asia/Dhaka, +360 all year', async () => {
    const { time, scheduling } = await load();
    expect(time.WORK_TIMEZONE).toBe('Asia/Dhaka');
    expect(time.workOffsetMinutesAt(at('2026-01-15T12:00:00Z'))).toBe(360);
    expect(time.workOffsetMinutesAt(at('2026-07-15T12:00:00Z'))).toBe(360);
    expect(time.workZoneTransitions(at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z'))).toEqual([
      { at: at('2026-01-01T00:00:00Z'), offsetMinutes: 360 },
    ]);
    expect(time.WORK_TIMEZONE_LABEL).toBe('Dhaka');
    expect(scheduling.JOB_TIMEZONE).toBe('Asia/Dhaka');
  });

  it('the Dhaka day still turns at 18:00 UTC', async () => {
    const { time } = await load();
    expect(day(time.workDateOf(at('2026-08-11T17:59:59Z')))).toBe('2026-08-11');
    expect(day(time.workDateOf(at('2026-08-11T18:00:00Z')))).toBe('2026-08-12');
    expect(time.localMidnightOf(at('2026-08-12T03:00:00Z')).toISOString()).toBe(
      '2026-08-11T18:00:00.000Z',
    );
  });

  it('human-facing text still says Dhaka', async () => {
    const { pdf } = await load();
    expect(pdf.workStamp(at('2026-08-11T12:30:00Z'))).toBe(
      '2026-08-11 18:30 (Asia/Dhaka)',
    );
  });
});

describe('America/Sao_Paulo (UTC−3)', () => {
  const SP = 'America/Sao_Paulo';

  it('exposes −180', async () => {
    const { time, scheduling } = await load(SP);
    expect(time.workOffsetMinutesAt(at('2026-08-11T12:00:00Z'))).toBe(-180);
    expect(time.WORK_TIMEZONE_LABEL).toBe('Sao Paulo');
    expect(scheduling.JOB_TIMEZONE).toBe(SP);
  });

  it('the day turns at 00:00 local = 03:00 UTC, not at 15:00 local', async () => {
    const { time } = await load(SP);
    expect(day(time.workDateOf(at('2026-08-11T02:59:59Z')))).toBe('2026-08-10');
    expect(day(time.workDateOf(at('2026-08-11T03:00:00Z')))).toBe('2026-08-11');
    // 15:00 local, where the Dhaka offset used to cut the day
    expect(day(time.workDateOf(at('2026-08-11T18:00:00Z')))).toBe('2026-08-11');
    expect(
      time.sameWorkDate(at('2026-08-11T03:00:00Z'), at('2026-08-12T02:59:59Z')),
    ).toBe(true);
  });

  it('local midnight is a real instant 3 hours after UTC midnight', async () => {
    const { time } = await load(SP);
    const noon = at('2026-08-11T15:00:00Z');
    expect(time.localMidnightOf(noon).toISOString()).toBe(
      '2026-08-11T03:00:00.000Z',
    );
    expect(time.nextLocalMidnight(noon).toISOString()).toBe(
      '2026-08-12T03:00:00.000Z',
    );
  });

  it('rolls over months and years at local midnight', async () => {
    const { time } = await load(SP);
    // 31 Aug 23:30 local
    expect(day(time.workDateOf(at('2026-09-01T02:30:00Z')))).toBe('2026-08-31');
    // 31 Dec 23:59 local — still last year
    expect(day(time.workDateOf(at('2027-01-01T02:59:00Z')))).toBe('2026-12-31');
    expect(day(time.workDateOf(at('2027-01-01T03:00:00Z')))).toBe('2027-01-01');
    expect(time.localMidnightOf(at('2027-01-01T01:00:00Z')).toISOString()).toBe(
      '2026-12-31T03:00:00.000Z',
    );
    expect(time.workPathParts(at('2027-01-01T02:59:58Z'))).toEqual({
      year: '2026',
      month: '12',
      day: '31',
      hhmmss: '235958',
    });
  });

  it('hours and clocks are local', async () => {
    const { time, summary, alerts } = await load(SP);
    const t = at('2026-08-11T10:05:00Z'); // 07:05 local
    expect(time.workHourOf(t)).toBe(7);
    expect(summary.workHourOf(t)).toBe(7);
    expect(alerts.workHourOf(t)).toBe(7);
    expect(alerts.workMinuteOfDay(t)).toBe(7 * 60 + 5);
    expect(time.workClock(at('2026-08-11T21:30:00Z'))).toBe('18:30');
    // just after local midnight: hour 0, not 21 of the day before
    expect(time.workHourOf(at('2026-08-11T03:10:00Z'))).toBe(0);
  });

  it('the weekly off day is the local weekday', async () => {
    const { alerts } = await load(SP);
    // Fri 14 Aug 2026, 22:00 local = Sat 01:00 UTC
    expect(alerts.workIsoWeekday(at('2026-08-15T01:00:00Z'))).toBe(5);
    const input = {
      officeFrom: '09:00',
      officeTo: '18:00',
      weeklyOffDays: [5],
      isHoliday: false,
    };
    // Fri 10:00 local — off day
    expect(
      alerts.isOfficeOpen({ ...input, now: at('2026-08-14T13:00:00Z') }),
    ).toBe(false);
    // Thu 10:00 local — open; Thu 08:59 local — not yet
    expect(
      alerts.isOfficeOpen({ ...input, now: at('2026-08-13T13:00:00Z') }),
    ).toBe(true);
    expect(
      alerts.isOfficeOpen({ ...input, now: at('2026-08-13T11:59:00Z') }),
    ).toBe(false);
  });

  it('the no-activity alert window (18–22) is local', async () => {
    const { alerts } = await load(SP);
    expect(alerts.isNoActivityWindow(at('2026-08-11T21:00:00Z'))).toBe(true); // 18:00
    expect(alerts.isNoActivityWindow(at('2026-08-12T01:00:00Z'))).toBe(false); // 22:00
    expect(alerts.isNoActivityWindow(at('2026-08-11T15:00:00Z'))).toBe(false); // 12:00
  });

  it('backup names carry the local date and parse back to the same instant', async () => {
    const { ops } = await load(SP);
    const now = at('2027-01-01T02:30:00Z'); // 31 Dec 23:30 local
    const name = ops.backupFileName(now);
    expect(name).toContain('2026-12-31-2330');
    expect(ops.parseBackupName(name)?.toISOString()).toBe(now.toISOString());
  });

  it('report stamps and the digest name the configured zone', async () => {
    const { pdf, digest } = await load(SP);
    expect(pdf.workStamp(at('2026-08-11T21:30:00Z'))).toBe(
      '2026-08-11 18:30 (America/Sao_Paulo)',
    );
    const body = digest.digestBody(
      digest.buildDigest({
        workDate: '2026-08-11',
        monthFrom: '2026-08-01',
        monthTo: '2026-08-11',
        today: [],
        month: [],
        expectedHours: {},
      }),
      'oXeio',
    );
    expect(body).toContain('2026-08-11 (Sao Paulo)');
  });
});

describe('Europe/Lisbon (daylight saving: UTC+0 in winter, UTC+1 in summer)', () => {
  const LX = 'Europe/Lisbon';

  it('uses the offset in force at each instant', async () => {
    const { time } = await load(LX);
    expect(time.workOffsetMinutesAt(at('2026-01-15T12:00:00Z'))).toBe(0);
    expect(time.workOffsetMinutesAt(at('2026-07-15T12:00:00Z'))).toBe(60);
    // 23:30 UTC is still the same day in winter, already the next in summer
    expect(day(time.workDateOf(at('2026-01-01T23:30:00Z')))).toBe('2026-01-01');
    expect(day(time.workDateOf(at('2026-07-01T23:30:00Z')))).toBe('2026-07-02');
    expect(time.localMidnightOf(at('2026-07-02T12:00:00Z')).toISOString()).toBe('2026-07-01T23:00:00.000Z');
    expect(time.workHourOf(at('2026-07-01T10:00:00Z'))).toBe(11);
  });

  it('the spring day has 23 hours and the autumn day 25', async () => {
    const { time } = await load(LX);
    const hours = (d: string): number => {
      const start = time.startOfWorkDate(at(`${d}T00:00:00Z`));
      return (time.nextLocalMidnight(start).getTime() - start.getTime()) / 3_600_000;
    };
    expect(hours('2026-03-29')).toBe(23);
    expect(hours('2026-10-25')).toBe(25);
    expect(hours('2026-07-02')).toBe(24);
  });

  it('lists the two changes of the year for the agent', async () => {
    const { time } = await load(LX);
    expect(time.workZoneTransitions(at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z'))).toEqual([
      { at: at('2026-01-01T00:00:00Z'), offsetMinutes: 0 },
      { at: at('2026-03-29T01:00:00Z'), offsetMinutes: 60 },
      { at: at('2026-10-25T01:00:00Z'), offsetMinutes: 0 },
    ]);
  });

  it('the agent config carries the window anchored to the month', async () => {
    const { agentConfig } = await load(LX);
    const window = agentConfig.transitionWindow(at('2026-10-05T12:00:00Z'));
    expect(window[0]).toEqual({ at: '2026-09-01T00:00:00.000Z', offsetMinutes: 60 });
    expect(window).toContainEqual({ at: '2026-10-25T01:00:00.000Z', offsetMinutes: 0 });
    expect(window).toContainEqual({ at: '2027-03-28T01:00:00.000Z', offsetMinutes: 60 });
    // the same all month long, so the config hash moves once a month
    expect(agentConfig.transitionWindow(at('2026-10-31T23:00:00Z'))).toEqual(window);
  });

  it('hour buckets follow the wall clock on the 25-hour day', async () => {
    const { dash } = await load(LX);
    const date = at('2026-10-25T00:00:00Z');
    // 01:30 local happens twice: 00:30 UTC (summer) and 01:30 UTC (winter)
    const buckets = dash.spreadIntoHourBuckets(
      [
        { startedAt: at('2026-10-25T00:30:00Z'), endedAt: at('2026-10-25T00:40:00Z'), durationSec: 600 },
        { startedAt: at('2026-10-25T01:30:00Z'), endedAt: at('2026-10-25T01:40:00Z'), durationSec: 600 },
        // 22:00–23:00 local, the last hour of the day
        { startedAt: at('2026-10-25T22:00:00Z'), endedAt: at('2026-10-25T23:00:00Z'), durationSec: 3600 },
      ],
      date,
    );
    expect(buckets[1]).toBe(1200);
    expect(buckets[22]).toBe(3600);
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(4800);
  });

  it('backup names round-trip in summer and in winter', async () => {
    const { ops } = await load(LX);
    for (const iso of ['2026-07-01T01:30:00Z', '2026-12-01T02:30:00Z']) {
      const name = ops.backupFileName(at(iso));
      expect(ops.parseBackupName(name)?.toISOString()).toBe(at(iso).toISOString());
    }
    expect(ops.backupFileName(at('2026-07-01T01:30:00Z'))).toContain('2026-07-01-0230');
  });
});

describe('America/Santiago (midnight is skipped when daylight saving starts)', () => {
  it('the day starts at 01:00 when 00:00 does not exist', async () => {
    const { time } = await load('America/Santiago');
    const start = time.startOfWorkDate(at('2026-09-06T00:00:00Z'));
    expect(start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(time.workHourOf(start)).toBe(1);
    expect(day(time.workDateOf(new Date(start.getTime() - 1)))).toBe('2026-09-05');
  });
});
