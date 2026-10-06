import { describe, expect, it } from 'vitest';

import {
  countWorkdays,
  dailyTargetSec,
  eachDate,
  isWorkday,
  overlapOf,
  secondsToHours,
  targetSecIn,
  type WorkdayRule,
} from '../src/reports/reports.range';
import { prorate } from '../src/summary/proration';

/**
 * One rate: the two paths must never give two numbers.
 *
 * The most important test in this file is not about one number but an
 * equality: for the same employee, the same month and the same holiday
 * calendar,
 *
 *   - `summary/proration.ts` -> `prorate().targetSec` (the tray, Live Board,
 *     `monthly_summary` and payroll run on this path), and
 *   - `reports/reports.range.ts` -> `targetSecIn()` (the Reports page, Excel,
 *     PDF and the digest run on this path)
 *
 * must give the same hours.
 *
 * Careful, why "hours" and not "workdays": the previous round's test only
 * matched the workday counts. Both paths counted workdays the same, but the
 * denominator differed: proration divided by the policy's 26, reports divided
 * by that month's calendar workdays. So the same employee's daily target was
 * 8.00 hours on one screen and 7.70 on another, and the test stayed green.
 * Matching the ingredients of a number instead of the number leaves exactly
 * that kind of gap.
 */

const HOUR = 3600;
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

/** Friday is the weekly day off */
const FRIDAY = 5;

/** What the policy row says: 208 hours / 26 standard workdays = 8 hours */
const MONTHLY_TARGET_SEC = 208 * HOUR;
const POLICY_WORKDAYS = 26;

interface Month {
  name: string;
  start: Date;
  end: Date;
  /** calendar workdays without holidays, only Fridays excluded */
  workdays: number;
}

/**
 * The three months deliberately have three different workday counts: 27, 26,
 * 25. If the denominator slips back to the calendar by mistake, the daily
 * target will differ across the three months and the tests below go red at once.
 */
const MONTHS: Month[] = [
  { name: 'আগস্ট ২০২৬', start: d(2026, 8, 1), end: d(2026, 8, 31), workdays: 27 },
  { name: 'সেপ্টেম্বর ২০২৬', start: d(2026, 9, 1), end: d(2026, 9, 30), workdays: 26 },
  { name: 'ফেব্রুয়ারি ২০২৮', start: d(2028, 2, 1), end: d(2028, 2, 29), workdays: 25 },
];

const ruleOf = (holidays: ReadonlySet<number>): WorkdayRule => ({
  weeklyOffDays: [FRIDAY],
  holidays,
});

const holidaysOn = (...dates: Date[]): Set<number> =>
  new Set(dates.map((x) => x.getTime()));

/** Day-by-day sum: exactly the sum of the cells printed on the report page */
function sumDayByDay(
  from: Date,
  to: Date,
  rule: WorkdayRule,
  perWorkdaySec: number,
): number {
  let sec = 0;
  for (const date of eachDate(from, to)) {
    if (isWorkday(date, rule)) sec += perWorkdaySec;
  }
  return sec;
}

describe('one rate: the denominator is always the policy expected_workdays', () => {
  it('whatever the workdays in the month, the daily target is 8 hours', () => {
    for (const month of MONTHS) {
      const rule = ruleOf(new Set<number>());

      // the months really differ, otherwise the claim below would have no force
      expect(countWorkdays(month.start, month.end, rule)).toBe(month.workdays);

      expect(
        secondsToHours(dailyTargetSec(MONTHLY_TARGET_SEC, POLICY_WORKDAYS)),
      ).toBe(8);
    }
  });

  /**
   * In the owner's words: "if holidays increase, does the employee gain, or
   * does the burden grow?" With a calendar denominator, more holidays would
   * raise the daily target while the month's total stayed stuck at 208, so a
   * holiday would buy nothing.
   */
  it('more holidays do not raise the daily target, they lower the month total', () => {
    const month = MONTHS[0]; // August 2026: 27 workdays without holidays
    const perDay = dailyTargetSec(MONTHLY_TARGET_SEC, POLICY_WORKDAYS);

    const noHoliday = ruleOf(new Set<number>());
    // Wednesday 26 August (Eid-e-Miladunnabi, not final yet), Monday 17 August
    const twoHolidays = ruleOf(holidaysOn(d(2026, 8, 26), d(2026, 8, 17)));

    const span = { from: month.start, to: month.end };

    expect(secondsToHours(targetSecIn(span, noHoliday, perDay))).toBe(216);
    expect(secondsToHours(targetSecIn(span, twoHolidays, perDay))).toBe(200);

    // the difference is exactly two days' target, not a cent off
    expect(
      targetSecIn(span, noHoliday, perDay) -
        targetSecIn(span, twoHolidays, perDay),
    ).toBeCloseTo(2 * perDay, 6);
  });

  it('a holiday on the weekly day off does not reduce workdays twice', () => {
    const perDay = dailyTargetSec(MONTHLY_TARGET_SEC, POLICY_WORKDAYS);
    const span = { from: d(2026, 8, 1), to: d(2026, 8, 31) };

    // 7 August 2026 is a Friday, already a weekly day off
    const onFriday = ruleOf(holidaysOn(d(2026, 8, 7)));

    expect(secondsToHours(targetSecIn(span, onFriday, perDay))).toBe(216);
  });
});

describe('two paths, one number: proration vs reports', () => {
  /**
   * Hours are matched on purpose: `prorate()` rounds to the second and
   * `targetSecIn()` does not. They may differ by under half a second, but
   * there must be no difference in the two-decimal hours printed on paper,
   * because that is the number people look at.
   */
  const cases: {
    label: string;
    holidays: Set<number>;
    joinedOn: Date | null;
    leftOn: Date | null;
  }[] = [
    { label: 'ছুটিহীন, পুরো মাস', holidays: new Set(), joinedOn: null, leftOn: null },
    {
      label: 'দুটো সরকারি ছুটি',
      holidays: holidaysOn(d(2026, 8, 17), d(2026, 8, 26)),
      joinedOn: null,
      leftOn: null,
    },
    {
      label: 'মাসের মাঝে যোগ দিয়েছেন',
      holidays: holidaysOn(d(2026, 8, 26)),
      joinedOn: d(2026, 8, 13),
      leftOn: null,
    },
    {
      label: 'মাসের মাঝে চলে গেছেন',
      holidays: new Set(),
      joinedOn: null,
      leftOn: d(2026, 8, 20),
    },
  ];

  for (const month of MONTHS) {
    for (const c of cases) {
      it(`${month.name} · ${c.label}: targetSec gives the same hours`, () => {
        // The cases' dates are in August; in other months they fall outside
        // anyway, so holidays and employment apply independent of the month
        const rule = ruleOf(c.holidays);

        const p = prorate({
          monthStart: month.start,
          monthEnd: month.end,
          joinedOn: c.joinedOn,
          leftOn: c.leftOn,
          weeklyOffDays: [FRIDAY],
          holidays: c.holidays,
          monthlyTargetSec: MONTHLY_TARGET_SEC,
          policyWorkdays: POLICY_WORKDAYS,
        });

        // how reports sees it: period of employment intersected with the month
        const from =
          c.joinedOn !== null && c.joinedOn.getTime() > month.start.getTime()
            ? c.joinedOn
            : month.start;
        const to =
          c.leftOn !== null && c.leftOn.getTime() < month.end.getTime()
            ? c.leftOn
            : month.end;

        const perDay = dailyTargetSec(MONTHLY_TARGET_SEC, POLICY_WORKDAYS);
        const reportSec = targetSecIn({ from, to }, rule, perDay);

        // the denominators match too: the division is written in two files, so pin it
        expect(p.dailyTargetSec).toBe(perDay);
        expect(countWorkdays(from, to, rule)).toBe(p.employeeWorkdays);

        // the real claim
        expect(secondsToHours(reportSec)).toBe(secondsToHours(p.targetSec));
      });
    }
  }

  /**
   * 208 / 26 happens to be a whole number (28800 seconds). The two paths must
   * not part even with a policy that does not divide evenly; otherwise "our
   * numbers match" would hide the gap.
   */
  it('the two stay the same even for a policy that does not divide evenly (200h / 22 days)', () => {
    const monthlyTargetSec = 200 * HOUR;
    const policyWorkdays = 22;
    const month = MONTHS[0];
    const holidays = holidaysOn(d(2026, 8, 26));
    const rule = ruleOf(holidays);

    const p = prorate({
      monthStart: month.start,
      monthEnd: month.end,
      joinedOn: null,
      leftOn: null,
      weeklyOffDays: [FRIDAY],
      holidays,
      monthlyTargetSec,
      policyWorkdays,
    });

    const reportSec = targetSecIn(
      { from: month.start, to: month.end },
      rule,
      dailyTargetSec(monthlyTargetSec, policyWorkdays),
    );

    expect(secondsToHours(reportSec)).toBe(secondsToHours(p.targetSec));
  });
});

describe('product vs day-by-day sum: so the column adds up', () => {
  /**
   * The report page prints the target one cell per day, with a total below.
   * The total comes from `targetSecIn()` (multiplication). If the two differ,
   * a reader adding up the column would find it does not match the total,
   * which is worse than any wrong number.
   *
   * This equality holds only because the denominator is constant. If the
   * denominator varied by month, multiplying across a two-month range would be
   * wrong, so this test also guards the denominator.
   */
  it('even for a range touching two months, product = day-by-day sum', () => {
    const rule = ruleOf(holidaysOn(d(2026, 8, 26), d(2026, 9, 15)));
    const perDay = dailyTargetSec(MONTHLY_TARGET_SEC, POLICY_WORKDAYS);
    const span = { from: d(2026, 8, 10), to: d(2026, 9, 20) };

    expect(secondsToHours(targetSecIn(span, rule, perDay))).toBe(
      secondsToHours(sumDayByDay(span.from, span.to, rule, perDay)),
    );
  });

  it('the sum matches for a policy that does not divide evenly too', () => {
    const rule = ruleOf(new Set<number>());
    const perDay = dailyTargetSec(200 * HOUR, 22);
    const span = { from: d(2026, 8, 1), to: d(2026, 8, 31) };

    expect(secondsToHours(targetSecIn(span, rule, perDay))).toBe(
      secondsToHours(sumDayByDay(span.from, span.to, rule, perDay)),
    );
  });
});

describe('overlapOf: intersection of the expectation window and the range', () => {
  it('with an overlap, the part inside both bounds is returned', () => {
    const seen = overlapOf(
      { from: d(2026, 8, 13), to: d(2026, 8, 20) },
      { from: d(2026, 8, 1), to: d(2026, 8, 31) },
    );

    expect(seen).not.toBeNull();
    expect(seen?.from).toEqual(d(2026, 8, 13));
    expect(seen?.to).toEqual(d(2026, 8, 20));
  });

  it('even a single shared day is an overlap, not empty', () => {
    const seen = overlapOf(
      { from: d(2026, 8, 1), to: d(2026, 8, 13) },
      { from: d(2026, 8, 13), to: d(2026, 8, 31) },
    );

    expect(seen).toEqual({ from: d(2026, 8, 13), to: d(2026, 8, 13) });
  });

  /** `null` means "no overlap at all", which is different from "0 workdays" */
  it('null when they do not meet, not a reversed range', () => {
    expect(
      overlapOf(
        { from: d(2026, 8, 1), to: d(2026, 8, 10) },
        { from: d(2026, 8, 11), to: d(2026, 8, 31) },
      ),
    ).toBeNull();
  });
});

describe('expectation vs target: the denominator of the shortfall', () => {
  const perDay = dailyTargetSec(MONTHLY_TARGET_SEC, POLICY_WORKDAYS);
  const rule = ruleOf(new Set<number>());
  const range = { from: d(2026, 8, 1), to: d(2026, 8, 31) };

  /**
   * The real event of this installation: the agent went live on 13 August
   * 2026. Nobody measured 1-12 August, so those days are not in the
   * expectation, yet they are in the target (the days print as report rows).
   */
  it('days before tracking began are in the target, not in the expectation', () => {
    const window = { from: d(2026, 8, 13), to: d(2026, 8, 20) }; // yesterday = 20th
    const seen = overlapOf(window, range);

    const targetHours = secondsToHours(targetSecIn(range, rule, perDay));
    const expectedHours = secondsToHours(
      seen === null ? 0 : targetSecIn(seen, rule, perDay),
    );

    expect(targetHours).toBe(216); // the 27 workdays of the whole of August
    expect(expectedHours).toBe(56); // 13-20 August, 7 days excluding Friday the 14th
    expect(expectedHours).toBeLessThan(targetHours);
  });

  /**
   * Once the period is over (last month's report) the window covers the whole
   * range, so expectation = target and the shortfall calculation stays as
   * before. Old printed papers do not move under this rule.
   */
  it('once the period is over, expectation and target become the same', () => {
    const seen = overlapOf(range, range);

    expect(secondsToHours(targetSecIn(seen!, rule, perDay))).toBe(
      secondsToHours(targetSecIn(range, rule, perDay)),
    );
  });
});
