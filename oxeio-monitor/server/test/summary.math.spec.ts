import { resolve, sep } from 'node:path';
import { workNoon } from './setup/clock';

import { describe, expect, it } from 'vitest';

import { RunLock } from '../src/summary/scheduling';
import {
  countWorkdays,
  workHourOf,
  hoursToSec,
  isInsideRoot,
  isWorkday,
  isoWeekday,
  mergeSpans,
  monthBounds,
  previousWorkDate,
  productivityPct,
  retentionCutoff,
  rollupMonth,
  summarizeDay,
  unionSec,
  type DaySegment,
} from '../src/summary/summary.math';

/** 208 hours, in seconds */
const TARGET = 208 * 3600;
const HOUR = 3600;

/** Write Dhaka time, get a UTC instant — makes the tests easier to read */
function work(iso: string): Date {
  return new Date(`${iso}+06:00`);
}

function seg(
  state: DaySegment['state'],
  from: string,
  to: string,
): DaySegment {
  const startedAt = work(from);
  const endedAt = work(to);
  return {
    state,
    startedAt,
    endedAt,
    durationSec: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
  };
}

/** UTC midnight — what Prisma's `@db.Date` and `workDateOf()` return */
function day(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

// ══════════════════════════════════════════════════════════════════════════

describe('mergeSpans / unionSec — one person, two devices (§ 2.1-c)', () => {
  it('separate spans are added', () => {
    expect(
      unionSec([
        { startedAt: work('2026-08-11T09:00:00'), endedAt: work('2026-08-11T10:00:00') },
        { startedAt: work('2026-08-11T11:00:00'), endedAt: work('2026-08-11T12:00:00') },
      ]),
    ).toBe(2 * HOUR);
  });

  /**
   * This test is the reason for this file. With a desktop and a laptop running
   * at the same time, the sum gave 4 hours, yet the person sat for 3 hours.
   */
  it('with two devices running at the same time, the time counts only once', () => {
    const spans = [
      { startedAt: work('2026-08-11T09:00:00'), endedAt: work('2026-08-11T11:00:00') },
      { startedAt: work('2026-08-11T10:00:00'), endedAt: work('2026-08-11T12:00:00') },
    ];

    expect(unionSec(spans)).toBe(3 * HOUR);

    const naive = spans.reduce(
      (t, s) => t + (s.endedAt.getTime() - s.startedAt.getTime()) / 1000,
      0,
    );
    expect(naive).toBe(4 * HOUR); // what would have happened
  });

  it('a span that falls entirely inside another still counts once', () => {
    expect(
      unionSec([
        { startedAt: work('2026-08-11T09:00:00'), endedAt: work('2026-08-11T17:00:00') },
        { startedAt: work('2026-08-11T10:00:00'), endedAt: work('2026-08-11T11:00:00') },
      ]),
    ).toBe(8 * HOUR);
  });

  it('two adjoining spans merge into one', () => {
    const merged = mergeSpans([
      { startedAt: work('2026-08-11T09:00:00'), endedAt: work('2026-08-11T10:00:00') },
      { startedAt: work('2026-08-11T10:00:00'), endedAt: work('2026-08-11T11:00:00') },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].endedAt).toEqual(work('2026-08-11T11:00:00'));
  });

  it('works even when they arrive in random order', () => {
    expect(
      unionSec([
        { startedAt: work('2026-08-11T14:00:00'), endedAt: work('2026-08-11T15:00:00') },
        { startedAt: work('2026-08-11T09:00:00'), endedAt: work('2026-08-11T11:00:00') },
        { startedAt: work('2026-08-11T10:30:00'), endedAt: work('2026-08-11T12:00:00') },
      ]),
    ).toBe(4 * HOUR);
  });

  it('zero-length or reversed spans are dropped', () => {
    expect(
      unionSec([
        { startedAt: work('2026-08-11T09:00:00'), endedAt: work('2026-08-11T09:00:00') },
        { startedAt: work('2026-08-11T12:00:00'), endedAt: work('2026-08-11T11:00:00') },
      ]),
    ).toBe(0);
  });

  /** The input is Prisma rows — if they were mutated, the caller would silently get wrong data */
  it('does not mutate the input objects', () => {
    const first = {
      startedAt: work('2026-08-11T09:00:00'),
      endedAt: work('2026-08-11T11:00:00'),
    };
    const spans = [
      first,
      { startedAt: work('2026-08-11T10:00:00'), endedAt: work('2026-08-11T12:00:00') },
    ];

    mergeSpans(spans);

    expect(first.endedAt).toEqual(work('2026-08-11T11:00:00'));
  });
});

// ══════════════════════════════════════════════════════════════════════════

describe('summarizeDay — one day summary (K06)', () => {
  const empty = {
    screenshotCount: 0,
    adjustmentSec: 0,
    productiveSpans: [],
    unproductiveSpans: [],
    isOffDay: false,
  };

  it('keeps the raw sum of active and the UNION separate', () => {
    const n = summarizeDay({
      ...empty,
      segments: [
        seg('active', '2026-08-11T09:00:00', '2026-08-11T11:00:00'),
        seg('active', '2026-08-11T10:00:00', '2026-08-11T12:00:00'),
      ],
    });

    expect(n.activeSec).toBe(4 * HOUR); // sum over both devices
    expect(n.workedSec).toBe(3 * HOUR); // how long they actually sat
  });

  it('locked time also counts as idle', () => {
    const n = summarizeDay({
      ...empty,
      segments: [
        seg('active', '2026-08-11T09:00:00', '2026-08-11T13:00:00'),
        seg('idle', '2026-08-11T13:00:00', '2026-08-11T13:30:00'),
        seg('locked', '2026-08-11T13:30:00', '2026-08-11T14:00:00'),
      ],
    });

    expect(n.workedSec).toBe(4 * HOUR);
    expect(n.idleSec).toBe(HOUR);
  });

  it('idle or locked time is never added to working time', () => {
    const n = summarizeDay({
      ...empty,
      segments: [
        seg('idle', '2026-08-11T09:00:00', '2026-08-11T17:00:00'),
        seg('locked', '2026-08-11T17:00:00', '2026-08-11T18:00:00'),
      ],
    });

    expect(n.workedSec).toBe(0);
    expect(n.creditedSec).toBe(0);
    expect(n.dayType).toBe('no_activity');
  });

  it('adjustments are added to give credited time (§ 2.1-e)', () => {
    const n = summarizeDay({
      ...empty,
      segments: [seg('active', '2026-08-11T09:00:00', '2026-08-11T11:00:00')],
      adjustmentSec: 2 * HOUR,
    });

    expect(n.workedSec).toBe(2 * HOUR);
    expect(n.creditedSec).toBe(4 * HOUR);
  });

  /** Daily credited may go negative — the owner's instruction is kept unchanged */
  it('a deduction larger than the work makes daily credited negative', () => {
    const n = summarizeDay({
      ...empty,
      segments: [seg('active', '2026-08-11T09:00:00', '2026-08-11T10:00:00')],
      adjustmentSec: -3 * HOUR,
    });

    expect(n.creditedSec).toBe(-2 * HOUR);
  });

  it('first and last work times are placed on the Dhaka clock', () => {
    const n = summarizeDay({
      ...empty,
      segments: [
        seg('active', '2026-08-11T22:30:00', '2026-08-11T23:00:00'),
        seg('active', '2026-08-11T07:15:00', '2026-08-11T08:00:00'),
      ],
    });

    expect(n.firstActivityAt).toEqual(work('2026-08-11T07:15:00'));
    expect(n.lastActivityAt).toEqual(work('2026-08-11T23:00:00'));
    expect(n.earliestHour).toBe(7);
    expect(n.latestHour).toBe(23);
  });

  /** § 2.1-b — working on a holiday counts the hours in full */
  it('working on a holiday makes the day worked, not holiday', () => {
    const n = summarizeDay({
      ...empty,
      segments: [seg('active', '2026-08-07T10:00:00', '2026-08-07T13:00:00')],
      isOffDay: true,
    });

    expect(n.dayType).toBe('worked');
    expect(n.workedSec).toBe(3 * HOUR);
  });

  it('holiday if nobody sat, no_activity on a normal day', () => {
    expect(summarizeDay({ ...empty, segments: [], isOffDay: true }).dayType).toBe('holiday');
    expect(summarizeDay({ ...empty, segments: [], isOffDay: false }).dayType).toBe('no_activity');
  });

  it('with no segments the times are null, not zero', () => {
    const n = summarizeDay({ ...empty, segments: [] });

    expect(n.firstActivityAt).toBeNull();
    expect(n.lastActivityAt).toBeNull();
    expect(n.earliestHour).toBeNull();
    expect(n.productivityPct).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════

describe('productivityPct — category score', () => {
  it('productive ÷ (productive + unproductive)', () => {
    expect(productivityPct(3 * HOUR, HOUR)).toBe(75);
  });

  it('keeps up to two decimals', () => {
    expect(productivityPct(1, 2)).toBe(33.33);
  });

  /** "Nothing was categorised" and "everything is bad" are different */
  it('null when no categorised app ran', () => {
    expect(productivityPct(0, 0)).toBeNull();
  });

  it('0 when only unproductive ran', () => {
    expect(productivityPct(0, HOUR)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════

describe('counting working days — § 2.1-b', () => {
  /** Sunday is 0 in JS but 7 in ISO — unless reconciled, Sunday off would never be caught */
  it('ISO weekday: Sunday 7, Friday 5', () => {
    expect(isoWeekday(day('2026-02-01'))).toBe(7); // Sunday
    expect(isoWeekday(day('2026-08-07'))).toBe(5); // Friday
    expect(isoWeekday(day('2026-08-31'))).toBe(1); // Monday
  });

  it('Sunday as the weekly day off (7) is excluded correctly too', () => {
    expect(isWorkday(day('2026-02-01'), [7], new Set())).toBe(false);
    expect(isWorkday(day('2026-02-02'), [7], new Set())).toBe(true);
  });

  it('a day in the holidays table is not a working day', () => {
    const holidays = new Set([day('2026-08-10').getTime()]);
    expect(isWorkday(day('2026-08-10'), [5], holidays)).toBe(false);
    expect(isWorkday(day('2026-08-11'), [5], holidays)).toBe(true);
  });

  it('with weeklyOffDay = null every calendar day is a working day', () => {
    expect(countWorkdays(day('2026-08-01'), day('2026-08-31'), [], new Set())).toBe(31);
  });

  it('August 2026 — 27 days excluding Fridays', () => {
    expect(countWorkdays(day('2026-08-01'), day('2026-08-31'), [5], new Set())).toBe(27);
  });

  it('"up to today" includes today', () => {
    // 1–11 August has exactly one Friday (the 7th)
    expect(countWorkdays(day('2026-08-01'), day('2026-08-11'), [5], new Set())).toBe(10);
  });

  it('a holiday and a weekly day off on the same day are not excluded twice', () => {
    const holidays = new Set([day('2026-08-07').getTime()]); // that is a Friday too
    expect(countWorkdays(day('2026-08-01'), day('2026-08-31'), [5], holidays)).toBe(27);
  });
});

describe('monthBounds and previousWorkDate', () => {
  it('first and last day of the month, and year_month', () => {
    const b = monthBounds(day('2026-08-11'));
    expect(b.start).toEqual(day('2026-08-01'));
    expect(b.end).toEqual(day('2026-08-31'));
    expect(b.yearMonth).toBe('2026-08');
  });

  it('February of a leap year ends on day 29', () => {
    expect(monthBounds(day('2024-02-10')).end).toEqual(day('2024-02-29'));
    expect(monthBounds(day('2026-02-10')).end).toEqual(day('2026-02-28'));
  });

  it('year_month keeps the month in two digits', () => {
    expect(monthBounds(day('2026-01-05')).yearMonth).toBe('2026-01');
    expect(monthBounds(day('2026-12-31')).yearMonth).toBe('2026-12');
  });

  /**
   * The main assurance for K05. The job runs at 00:15 Dhaka time, which in UTC is
   * still the evening of the **previous day** — computing in UTC would close the wrong day.
   */
  it('running at 00:15 Dhaka closes the previous day', () => {
    expect(previousWorkDate(work('2026-08-12T00:15:00'))).toEqual(day('2026-08-11'));
  });

  it('running on the 1st of the month gives the last day of the previous month', () => {
    expect(previousWorkDate(work('2026-09-01T00:15:00'))).toEqual(day('2026-08-31'));
    // And then the monthly rollup goes to the previous month — otherwise the
    //    hours of 31 August would count in no month at all
    expect(monthBounds(previousWorkDate(work('2026-09-01T00:15:00'))).yearMonth).toBe('2026-08');
  });

  it('calling at any time of day gives the same previous day', () => {
    expect(previousWorkDate(work('2026-08-12T23:59:00'))).toEqual(day('2026-08-11'));
  });
});

describe('workHourOf', () => {
  it('gives the Dhaka hour, not the UTC one', () => {
    expect(workHourOf(new Date('2026-08-11T18:15:00Z'))).toBe(0); // 00:15 on the 12th in Dhaka
    expect(workHourOf(new Date('2026-08-11T01:00:00Z'))).toBe(7);
  });
});

// ══════════════════════════════════════════════════════════════════════════

describe('rollupMonth — monthly target and pace', () => {
  const base = {
    adjustmentSec: 0,
    targetSec: TARGET,
    expectedWorkdays: 27,
    monthWorkdays: 27,
    workdaysElapsed: 10,
    observedWorkdays: 10,
    daysWithWork: 10,
  };

  it('expected = target × past working days ÷ total working days', () => {
    const m = rollupMonth({ ...base, workedSec: 80 * HOUR });

    expect(m.expectedSec).toBe(Math.round((TARGET * 10) / 27));
    expect(m.paceSec).toBe(80 * HOUR - m.expectedSec);
  });

  /** § 2.1-b — on the last working day of the month, pace lands exactly on zero */
  it('pace is zero when the target is met exactly at month end', () => {
    const m = rollupMonth({
      ...base,
      workedSec: TARGET,
      workdaysElapsed: 27,
      observedWorkdays: 27,
      daysWithWork: 27,
    });

    expect(m.expectedSec).toBe(TARGET);
    expect(m.paceSec).toBe(0);
    expect(m.targetMet).toBe(true);
    expect(m.shortfallSec).toBe(0);
  });

  /** § 2.1-e — without counting adjustments, hours lost to a server fault would keep someone behind all month */
  it("pace counts the owner's adjustments", () => {
    const withoutAdj = rollupMonth({ ...base, workedSec: 60 * HOUR });
    const withAdj = rollupMonth({ ...base, workedSec: 60 * HOUR, adjustmentSec: 8 * HOUR });

    expect(withAdj.creditedSec).toBe(68 * HOUR);
    expect(withAdj.paceSec - withoutAdj.paceSec).toBe(8 * HOUR);
  });

  /**
   * The most important safeguard. `payroll.math.ts` throws a `RangeError` on a
   * negative `creditedSec` — one person's excess deduction would turn the whole
   * month's payroll sheet into a 500.
   */
  it('monthly credited does not go negative when the deduction exceeds the work', () => {
    const m = rollupMonth({ ...base, workedSec: 10 * HOUR, adjustmentSec: -50 * HOUR });

    expect(m.creditedSec).toBe(0);
    expect(m.shortfallSec).toBe(TARGET);
    expect(m.overtimeSec).toBe(0);
  });

  it('overtime when the target is exceeded, shortfall zero', () => {
    const m = rollupMonth({ ...base, workedSec: TARGET + 10 * HOUR, workdaysElapsed: 27, observedWorkdays: 27 });

    expect(m.overtimeSec).toBe(10 * HOUR);
    expect(m.shortfallSec).toBe(0);
    expect(m.targetMet).toBe(true);
  });

  it('targetMet as soon as the target is reached (not one second short)', () => {
    expect(rollupMonth({ ...base, workedSec: TARGET }).targetMet).toBe(true);
    expect(rollupMonth({ ...base, workedSec: TARGET - 1 }).targetMet).toBe(false);
  });

  /** The divisor is zero — without a guard NaN would reach the database */
  it('expected is zero, not NaN, when the month has no working days', () => {
    const m = rollupMonth({
      ...base,
      workedSec: 5 * HOUR,
      expectedWorkdays: 0,
      workdaysElapsed: 0,
      observedWorkdays: 0,
    });

    expect(m.expectedSec).toBe(0);
    expect(m.paceSec).toBe(5 * HOUR);
  });

  /** Division by 0 — Infinity would end up there */
  it('the average is zero when nobody worked a single day', () => {
    const m = rollupMonth({ ...base, workedSec: 0, daysWithWork: 0 });

    expect(m.avgDailySec).toBe(0);
    expect(Number.isFinite(m.avgDailySec)).toBe(true);
  });

  it('past working days cannot exceed total working days', () => {
    const m = rollupMonth({ ...base, workedSec: 0, workdaysElapsed: 40, observedWorkdays: 40 });

    // expected must never exceed the full target, otherwise everyone would
    // suddenly fall further behind at month end
    expect(m.expectedSec).toBe(TARGET);
  });

  it('stops when the target is zero', () => {
    expect(() => rollupMonth({ ...base, workedSec: 0, targetSec: 0 })).toThrow(RangeError);
  });

  it('hours → seconds', () => {
    expect(hoursToSec(208)).toBe(TARGET);
    expect(hoursToSec(207.5)).toBe(747000);
  });
});

// ══════════════════════════════════════════════════════════════════════════

describe('retentionCutoff — the most dangerous number in K01', () => {
  it('gives the date 90 days ago', () => {
    expect(retentionCutoff(work('2026-08-11T02:00:00'), 90)).toEqual(day('2026-05-13'));
  });

  /** A picture exactly 90 days old **stays** — those before it are cut */
  it('the boundary day is spared', () => {
    const cutoff = retentionCutoff(work('2026-08-11T02:00:00'), 90);

    expect(day('2026-05-13') < cutoff).toBe(false); // stays
    expect(day('2026-05-12') < cutoff).toBe(true); // goes
  });

  it('is computed on the Dhaka date, not UTC', () => {
    // 2 a.m. on the 12th in Dhaka = 8 p.m. on the 11th in UTC
    expect(retentionCutoff(work('2026-08-12T02:00:00'), 90)).toEqual(day('2026-05-14'));
  });

  /**
   * If `0` were set in config by mistake, the cutoff would land on today's date,
   * and the 2 a.m. job would silently wipe the whole archive including today's
   * pictures — both files and rows.
   */
  it('stops at zero or negative days', () => {
    expect(() => retentionCutoff(workNoon(), 0)).toThrow(RangeError);
    expect(() => retentionCutoff(workNoon(), -1)).toThrow(RangeError);
    expect(() => retentionCutoff(workNoon(), Number.NaN)).toThrow(RangeError);
  });
});

describe('isInsideRoot — the guard before deleting files', () => {
  const root = resolve('storage-root-for-test');

  it('a normal relative path is inside', () => {
    expect(isInsideRoot(root, 'screenshots/2026/08/09/emp-003/093147_m0.webp')).toBe(true);
  });

  /** `..` — a single gap is enough to delete a file outside storage */
  it('a path escaping with .. is rejected', () => {
    expect(isInsideRoot(root, '../../Windows/System32/config')).toBe(false);
    expect(isInsideRoot(root, 'screenshots/../../outside.webp')).toBe(false);
  });

  it('an absolute path entirely outside is rejected', () => {
    expect(isInsideRoot(root, resolve(root, '..', 'other.webp'))).toBe(false);
  });

  /** With only `startsWith(root)`, this neighbour would look "inside" */
  it('a sibling folder whose name merely starts the same is not inside', () => {
    expect(isInsideRoot(root, `${root}-old${sep}x.webp`)).toBe(false);
  });

  it('the root itself counts as inside', () => {
    expect(isInsideRoot(root, root)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════

describe('RunLock — the same job never twice at once', () => {
  it('while running, a second call returns null', async () => {
    const lock = new RunLock();
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = lock.run(async () => {
      await gate;
      return 'প্রথম';
    });
    const second = await lock.run(async () => 'দ্বিতীয়');

    expect(second).toBeNull();

    release();
    expect(await first).toBe('প্রথম');
  });

  it('when the previous one finishes, the next one runs', async () => {
    const lock = new RunLock();

    expect(await lock.run(async () => 1)).toBe(1);
    expect(await lock.run(async () => 2)).toBe(2);
  });

  /** Without the finally, a single exception would block the job forever */
  it('the lock is released even on an exception', async () => {
    const lock = new RunLock();

    await expect(
      lock.run(() => Promise.reject(new Error('ডাটাবেস নেই'))),
    ).rejects.toThrow('ডাটাবেস নেই');

    expect(await lock.run(async () => 'পরেরবার চলল')).toBe('পরেরবার চলল');
  });
});
