import { describe, expect, it } from 'vitest';

import {
  MAX_RANGE_DAYS,
  bucketOf,
  countWorkdays,
  dailyTargetSec,
  daysInclusive,
  eachDate,
  isWorkday,
  isoDayOf,
  monthsIn,
  parseReportRange,
  parseWorkDate,
  secondsToHours,
  sharePct,
  toIsoDate,
  weekStartIsoDay,
  type WorkdayRule,
} from '../src/reports/reports.range';

/** 11 August 2026 in Dhaka, noon: used as "today" */
const NOW = new Date('2026-08-11T06:00:00.000Z');

/** Friday is the day off, no public holidays */
const FRIDAY_OFF: WorkdayRule = { weeklyOffDays: [5], holidays: new Set() };

const day = (iso: string): Date => parseWorkDate(iso);

describe('date parsing', () => {
  it('builds UTC midnight from YYYY-MM-DD, matching Prisma @db.Date', () => {
    const d = parseWorkDate('2026-08-11');
    expect(d.toISOString()).toBe('2026-08-11T00:00:00.000Z');
    expect(toIsoDate(d)).toBe('2026-08-11');
  });

  /**
   * The most useful test. `Date.UTC(2026, 1, 30)` raises no error: it quietly
   * makes 2 March. A "February report" would then bring March data and nobody
   * could catch it.
   */
  it('a date not in the calendar is rejected instead of rolling into the next month', () => {
    expect(() => parseWorkDate('2026-02-30')).toThrow(RangeError);
    expect(() => parseWorkDate('2026-13-01')).toThrow(RangeError);
    expect(() => parseWorkDate('2026-00-10')).toThrow(RangeError);
  });

  it('29 February works in a leap year and not in a normal year', () => {
    expect(toIsoDate(parseWorkDate('2028-02-29'))).toBe('2028-02-29');
    expect(() => parseWorkDate('2026-02-29')).toThrow(RangeError);
  });

  it('loose formats are not accepted', () => {
    expect(() => parseWorkDate('2026-8-1')).toThrow(RangeError);
    expect(() => parseWorkDate('11/08/2026')).toThrow(RangeError);
    expect(() => parseWorkDate('')).toThrow(RangeError);
  });
});

describe('range validation (F08)', () => {
  it('a normal range stays intact', () => {
    const r = parseReportRange('2026-08-01', '2026-08-10', { now: NOW });
    expect(toIsoDate(r.from)).toBe('2026-08-01');
    expect(toIsoDate(r.to)).toBe('2026-08-10');
    expect(r.days).toBe(10);
    expect(r.clampedToToday).toBe(false);
  });

  it('a one-day range works too (F01: one-day attendance)', () => {
    const r = parseReportRange('2026-08-11', '2026-08-11', { now: NOW });
    expect(r.days).toBe(1);
  });

  it('a reversed range is rejected', () => {
    expect(() =>
      parseReportRange('2026-08-10', '2026-08-01', { now: NOW }),
    ).toThrow(RangeError);
  });

  /**
   * Without a limit, asking for `from=2000-01-01` would make the server build
   * 15 people x 9500 days of rows: memory gone, and the whole dashboard down.
   */
  it('more than 370 days is rejected', () => {
    expect(MAX_RANGE_DAYS).toBe(370);

    const ok = parseReportRange('2025-08-11', '2026-08-11', { now: NOW });
    expect(ok.days).toBe(366);

    expect(() =>
      parseReportRange('2000-01-01', '2026-08-11', { now: NOW }),
    ).toThrow(/370/);
  });

  /**
   * Unless both are caught together the limit would be effectively empty.
   * If clamping came first, `2000-01-01 -> 2999-12-31` would be clamped to
   * "until today" and still not fall under the limit, but
   * `2026-08-01 -> 2999-12-31` would pass: the user would ask one question and
   * get the answer to another.
   */
  it('the limit is measured on the requested range, before clamping', () => {
    expect(() =>
      parseReportRange('2026-08-01', '2999-12-31', { now: NOW }),
    ).toThrow(RangeError);
  });

  it('a future end date is clamped to today, and that is reported', () => {
    const r = parseReportRange('2026-08-01', '2026-08-31', { now: NOW });

    expect(toIsoDate(r.to)).toBe('2026-08-11');
    expect(toIsoDate(r.requestedTo)).toBe('2026-08-31');
    expect(r.clampedToToday).toBe(true);
    expect(r.days).toBe(11);
  });

  it('a range entirely in the future is rejected: not an empty report', () => {
    expect(() =>
      parseReportRange('2026-09-01', '2026-09-30', { now: NOW }),
    ).toThrow(RangeError);
  });

  /**
   * Dhaka is UTC+6. 9pm UTC on 10 August is 3am on 11 August in Dhaka, so
   * "today" is the 11th. Writing the offset arithmetic by hand would lose a day right here.
   */
  it('"today" is the Dhaka date, not the server\'s UTC date', () => {
    const r = parseReportRange('2026-08-01', '2026-08-31', {
      now: new Date('2026-08-10T21:00:00.000Z'),
    });
    expect(toIsoDate(r.to)).toBe('2026-08-11');
  });
});

describe('workdays and target (spec section 2.1b)', () => {
  it('ISO day comes out right: Friday is 5', () => {
    expect(isoDayOf(day('2026-08-10'))).toBe(1); // Monday
    expect(isoDayOf(day('2026-08-14'))).toBe(5); // Friday
    expect(isoDayOf(day('2026-08-16'))).toBe(7); // Sunday
  });

  it('the weekly day off is not a workday', () => {
    expect(isWorkday(day('2026-08-13'), FRIDAY_OFF)).toBe(true);
    expect(isWorkday(day('2026-08-14'), FRIDAY_OFF)).toBe(false);
  });

  it('a day in the holiday calendar is not a workday either', () => {
    const rule: WorkdayRule = {
      weeklyOffDays: [5],
      holidays: new Set([day('2026-08-13').getTime()]),
    };
    expect(isWorkday(day('2026-08-13'), rule)).toBe(false);
  });

  it('with no weekly day off, every calendar day is a workday', () => {
    const rule: WorkdayRule = { weeklyOffDays: [], holidays: new Set() };
    expect(countWorkdays(day('2026-08-01'), day('2026-08-31'), rule)).toBe(31);
  });

  it('August 2026 has 27 workdays excluding Fridays', () => {
    // a 31-day month, with four Fridays: 7/14/21/28
    expect(
      countWorkdays(day('2026-08-01'), day('2026-08-31'), FRIDAY_OFF),
    ).toBe(27);
  });

  it('splitting the total target and adding it back gives exactly 208 hours', () => {
    const monthly = 208 * 3600;
    const workdays = countWorkdays(
      day('2026-08-01'),
      day('2026-08-31'),
      FRIDAY_OFF,
    );

    const perDay = dailyTargetSec(monthly, workdays);
    expect(secondsToHours(perDay * workdays)).toBe(208);
  });

  /**
   * Rounding the daily target would make this sum not match. In a 22-workday
   * month, 748800 / 22 = 34036.36...; rounding and adding 22 times would give
   * 207.99 or 208.01, and someone who hit the target exactly would see a
   * shortfall on paper.
   */
  it('even with uneven workday counts the sum does not go past the target', () => {
    const monthly = 208 * 3600;

    for (const workdays of [20, 21, 22, 23, 24, 25, 26, 27, 30]) {
      const perDay = dailyTargetSec(monthly, workdays);
      expect(secondsToHours(perDay * workdays)).toBe(208);

      const naive = Math.round(perDay) * workdays;
      expect(Math.abs(naive - monthly)).toBeLessThanOrEqual(workdays);
    }
  });

  it('zero workdays gives target 0, not Infinity', () => {
    expect(dailyTargetSec(208 * 3600, 0)).toBe(0);
  });

  it('a negative monthly target is rejected', () => {
    expect(() => dailyTargetSec(-1, 26)).toThrow(RangeError);
  });
});

describe('months and buckets', () => {
  it('each month in the range returns its full bounds, even a half month', () => {
    const months = monthsIn(day('2026-08-10'), day('2026-09-05'));

    expect(months.map((m) => m.key)).toEqual(['2026-08', '2026-09']);
    // even when asked from 10 August, the denominator is the workdays of the WHOLE of August
    expect(toIsoDate(months[0].first)).toBe('2026-08-01');
    expect(toIsoDate(months[0].last)).toBe('2026-08-31');
    expect(toIsoDate(months[1].last)).toBe('2026-09-30');
  });

  it('February of a leap year ends on the 29th', () => {
    const [feb] = monthsIn(day('2028-02-05'), day('2028-02-06'));
    expect(toIsoDate(feb.last)).toBe('2028-02-29');
  });

  /**
   * If weeks started on Monday, every working week that ends on Friday (Saturday to
   * Thursday, as in Bangladesh) would be split across two buckets, and the weekly summary would
   * never show anyone a whole week.
   */
  it('the week starts the day after the weekly day off', () => {
    expect(weekStartIsoDay([5])).toBe(6); // Friday off: starts on Saturday
    expect(weekStartIsoDay([7])).toBe(1); // Sunday off: starts on Monday
    expect(weekStartIsoDay([])).toBe(1);
  });

  it('a week bucket starts on Saturday and ends on Friday', () => {
    const b = bucketOf(day('2026-08-11'), 'week', weekStartIsoDay([5]));

    expect(b.key).toBe('2026-08-08'); // Saturday
    expect(toIsoDate(b.start)).toBe('2026-08-08');
    expect(toIsoDate(b.end)).toBe('2026-08-14'); // Friday
    expect(isoDayOf(b.end)).toBe(5);
  });

  it('every day of the same week falls on the same key, the next day on a new key', () => {
    const start = weekStartIsoDay([5]);
    for (const iso of ['2026-08-08', '2026-08-11', '2026-08-14']) {
      expect(bucketOf(day(iso), 'week', start).key).toBe('2026-08-08');
    }
    expect(bucketOf(day('2026-08-15'), 'week', start).key).toBe('2026-08-15');
  });

  it('the month bucket is YYYY-MM: the same format as the monthly_summary key', () => {
    const b = bucketOf(day('2026-08-11'), 'month', 6);
    expect(b.key).toBe('2026-08');
    expect(toIsoDate(b.start)).toBe('2026-08-01');
    expect(toIsoDate(b.end)).toBe('2026-08-31');
  });

  it('a week bucket stays intact across a month boundary', () => {
    const b = bucketOf(day('2026-09-01'), 'week', weekStartIsoDay([5]));
    expect(b.key).toBe('2026-08-29');
    expect(toIsoDate(b.end)).toBe('2026-09-04');
  });
});

describe('counting days and presentation', () => {
  it('days are counted inclusive of both ends', () => {
    expect(daysInclusive(day('2026-08-01'), day('2026-08-01'))).toBe(1);
    expect(daysInclusive(day('2026-08-01'), day('2026-08-31'))).toBe(31);
  });

  it('eachDate drops no day and keeps the order right', () => {
    const dates = eachDate(day('2026-08-01'), day('2026-08-31'));
    expect(dates).toHaveLength(31);
    expect(toIsoDate(dates[0])).toBe('2026-08-01');
    expect(toIsoDate(dates[30])).toBe('2026-08-31');
  });

  /**
   * Hours come back as a number, not "7h 32m". As text in Excel, column sums
   * and sorting would not work.
   */
  it('seconds to hours: a number, two decimals', () => {
    expect(secondsToHours(3600)).toBe(1);
    expect(secondsToHours(27120)).toBe(7.53); // 7h 32m
    expect(secondsToHours(0)).toBe(0);
    expect(typeof secondsToHours(27120)).toBe('number');
  });

  it('percentage with a zero denominator gives 0, not NaN', () => {
    expect(sharePct(0, 0)).toBe(0);
    expect(sharePct(1, 4)).toBe(25);
    expect(sharePct(1, 3)).toBe(33.33);
  });
});
