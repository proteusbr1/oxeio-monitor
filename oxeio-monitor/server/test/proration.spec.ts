import { describe, expect, it } from 'vitest';

import { prorate, salaryFraction, type ProrationInput } from '../src/summary/proration';

/**
 * Target and salary when someone joins mid-month (ADR-025).
 *
 * The most important test in this file is not about a single number but an
 * equality: someone who joined on the 15th and someone who stayed the whole
 * month must have exactly the same hourly rate. If that breaks, the rule
 * becomes unfair even though every other number is right, and nobody would
 * notice.
 */
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

/** September 2026: Fridays 4, 11, 18, 25; 26 workdays without holidays */
const SEPT: ProrationInput = {
  monthStart: d(2026, 9, 1),
  monthEnd: d(2026, 9, 30),
  joinedOn: null,
  leftOn: null,
  weeklyOffDays: [5], // Friday
  holidays: new Set<number>(),
  monthlyTargetSec: 208 * 3600,
  policyWorkdays: 26,
};

const HOURS = 3600;

describe('prorate: counting workdays', () => {
  it('staying the whole month gives d = D', () => {
    const r = prorate(SEPT);

    expect(r.monthWorkdays).toBe(26);
    expect(r.employeeWorkdays).toBe(26);
    expect(r.partial).toBe(false);
  });

  /** The owner's own example: "if someone joins on the 15th, 15 days of salary" */
  it('joining on 15 September gives 14 workdays', () => {
    const r = prorate({ ...SEPT, joinedOn: d(2026, 9, 15) });

    expect(r.employeeWorkdays).toBe(14);
    expect(r.partial).toBe(true);
  });

  it('leaving mid-month is counted the same way', () => {
    const r = prorate({ ...SEPT, leftOn: d(2026, 9, 14) });

    // 1-14 September, minus Fridays the 4th and 11th = 12
    expect(r.employeeWorkdays).toBe(12);
  });

  /**
   * If the join date is before the month, it is clamped to the month start;
   * otherwise `countWorkdays` would count the earlier months too, and the
   * target would skyrocket.
   */
  it('joining in an earlier month means the whole month', () => {
    const r = prorate({ ...SEPT, joinedOn: d(2020, 1, 1) });
    expect(r.employeeWorkdays).toBe(26);
  });

  it('joining after the month means nothing for that month', () => {
    const r = prorate({ ...SEPT, joinedOn: d(2026, 10, 1) });

    expect(r.employeeWorkdays).toBe(0);
    expect(r.targetSec).toBe(0);
  });

  it('leaving before the month is the same', () => {
    const r = prorate({ ...SEPT, leftOn: d(2026, 8, 31) });
    expect(r.employeeWorkdays).toBe(0);
  });

  /** Joining and leaving in the same month: both ends apply together */
  it('joining and leaving in the same month gives only the middle part', () => {
    const r = prorate({
      ...SEPT,
      joinedOn: d(2026, 9, 7),
      leftOn: d(2026, 9, 10),
    });

    // 7, 8, 9, 10: no Friday among them
    expect(r.employeeWorkdays).toBe(4);
  });

  it('holidays are excluded from workdays', () => {
    const r = prorate({
      ...SEPT,
      holidays: new Set([d(2026, 9, 1).getTime(), d(2026, 9, 2).getTime()]),
    });

    expect(r.monthWorkdays).toBe(24);
    expect(r.employeeWorkdays).toBe(24);
  });
});

describe('prorate: target', () => {
  it('for a full month, target = workdays x 8 hours, not 208', () => {
    // September has 26 workdays, so it comes to exactly 208 here, but
    // August has 27 days, i.e. 216h. A flat 208 no longer exists.
    expect(prorate(SEPT).targetSec).toBe(208 * HOURS);
  });

  it('August has 27 workdays: target 216 hours', () => {
    const r = prorate({
      ...SEPT,
      monthStart: d(2026, 8, 1),
      monthEnd: d(2026, 8, 31),
    });

    expect(r.monthWorkdays).toBe(27);
    expect(r.targetSec).toBe(216 * HOURS);
  });

  it('joining on the 15th gives a target of 14 x 8 = 112 hours', () => {
    expect(prorate({ ...SEPT, joinedOn: d(2026, 9, 15) }).targetSec).toBe(112 * HOURS);
  });

  /**
   * The 8 hours are not hardcoded: they come from dividing two policy
   * columns. If the contract changes to 260h / 26, the daily target is
   * 10 hours and no migration is needed.
   */
  it('the daily target comes from the policy, not hardcoded', () => {
    const r = prorate({ ...SEPT, monthlyTargetSec: 260 * HOURS, policyWorkdays: 26 });

    expect(r.dailyTargetSec).toBe(10 * HOURS);
    expect(r.targetSec).toBe(260 * HOURS);
  });

  it('throws when policy workdays are zero or negative', () => {
    expect(() => prorate({ ...SEPT, policyWorkdays: 0 })).toThrow(RangeError);
    expect(() => prorate({ ...SEPT, monthlyTargetSec: -1 })).toThrow(RangeError);
  });
});

describe('salaryFraction: the salary fraction', () => {
  it('the whole month gives the whole salary', () => {
    expect(salaryFraction(26, 26)).toBe(1);
  });

  it('half the workdays gives half', () => {
    expect(salaryFraction(13, 26)).toBe(0.5);
  });

  it('zero when not present that month', () => {
    expect(salaryFraction(0, 26)).toBe(0);
  });

  /**
   * The whole month is a holiday (D = 0). This is possible when Eid and public
   * holidays fall together. Then nobody has any workday, so a shortfall is
   * impossible; owner's decision: full salary. Treating 0/0 as 0 would give
   * everyone zero salary that month through no fault of their own.
   */
  it('a month that is all holiday gets full salary, not zero', () => {
    expect(salaryFraction(0, 0)).toBe(1);
  });

  /** Never more than 1: even with messy data nobody gets extra salary */
  it('never more than 1', () => {
    expect(salaryFraction(30, 26)).toBe(1);
  });
});

/**
 * The most important test in this file.
 *
 * The whole argument of ADR-025 stands on this equality: if both salary and
 * target are prorated, the hourly rate = (S*d/D) / (d*8) = S / (D*8), since d
 * cancels out. So the rate does not change with who joined when.
 *
 * If only the target were prorated, the rate for someone who joined on the
 * 15th would double, and no single number would reveal it.
 */
describe('the hourly rate is the same for everyone, whatever day they join', () => {
  const salary = 20000;

  const rateOf = (joinedOn: Date | null): number => {
    const r = prorate({ ...SEPT, joinedOn });
    const paid = salary * salaryFraction(r.employeeWorkdays, r.monthWorkdays);
    return paid / (r.targetSec / HOURS);
  };

  it('whole month, the 15th, the 24th: all three get the same rate', () => {
    const full = rateOf(null);

    expect(rateOf(d(2026, 9, 15))).toBeCloseTo(full, 10);
    expect(rateOf(d(2026, 9, 24))).toBeCloseTo(full, 10);
  });

  it('the rate is S / (D x daily hours)', () => {
    // 20000 / (26 x 8) = 96.15...
    expect(rateOf(null)).toBeCloseTo(20000 / (26 * 8), 10);
  });
});

/**
 * R2: the leave ledger.
 *
 * The most important test here is not about a number but about a separation:
 * leave reduces `targetSec` but does not touch `employeeWorkdays` (d) or
 * `monthWorkdays` (D). Those two form the payroll fraction `d / D`, so leave
 * is paid. If this separation broke, taking leave would silently cut pay, and
 * the numbers would still look reasonable.
 */
describe('prorate: leave (R2)', () => {
  /** Workdays of September 2026: 1, 2, 3 (Friday the 4th), 7, 8 ... */
  const day = (n: number) => d(2026, 9, n).getTime();

  it('leave reduces the target, but d and D stay intact: so pay is not cut', () => {
    const base = prorate(SEPT);
    const withLeave = prorate({
      ...SEPT,
      leaveDates: new Set([day(1), day(2), day(3)]),
    });

    // the hours target dropped by three days
    expect(withLeave.leaveWorkdays).toBe(3);
    expect(withLeave.targetSec).toBe(base.targetSec - 3 * 8 * HOURS);

    // but the two payroll numbers did not move at all
    expect(withLeave.employeeWorkdays).toBe(base.employeeWorkdays);
    expect(withLeave.monthWorkdays).toBe(base.monthWorkdays);
    expect(salaryFraction(withLeave.employeeWorkdays, withLeave.monthWorkdays)).toBe(
      salaryFraction(base.employeeWorkdays, base.monthWorkdays),
    );
  });

  /**
   * If "leave" is recorded on a Friday, there was no target that day anyway;
   * without excluding it, eight hours would be deducted twice and nobody
   * could find the cause.
   */
  it('leave recorded on a weekly day off is not counted', () => {
    const base = prorate(SEPT);
    const onFriday = prorate({ ...SEPT, leaveDates: new Set([day(4)]) });

    expect(onFriday.leaveWorkdays).toBe(0);
    expect(onFriday.targetSec).toBe(base.targetSec);
  });

  it('leave recorded on a public holiday is not counted either', () => {
    const withHoliday = { ...SEPT, holidays: new Set([day(7)]) };
    const base = prorate(withHoliday);
    const both = prorate({ ...withHoliday, leaveDates: new Set([day(7)]) });

    expect(both.leaveWorkdays).toBe(0);
    expect(both.targetSec).toBe(base.targetSec);
  });

  /** Leave before the join date is not in d at all, so there is nothing to exclude */
  it('leave outside the period of employment is not counted', () => {
    const joinedMid = { ...SEPT, joinedOn: d(2026, 9, 15) };
    const base = prorate(joinedMid);
    const before = prorate({ ...joinedMid, leaveDates: new Set([day(1), day(2)]) });

    expect(before.leaveWorkdays).toBe(0);
    expect(before.targetSec).toBe(base.targetSec);
  });

  it('when every workday is leave, the target is zero, not negative', () => {
    const all = new Set<number>();
    for (let n = 1; n <= 30; n++) all.add(day(n));

    const p = prorate({ ...SEPT, leaveDates: all });
    expect(p.targetSec).toBe(0);
    // d and D are still as before: even taking leave all month, the salary fraction is full
    expect(p.employeeWorkdays).toBe(p.monthWorkdays);
  });

  it('without leave the behaviour is as before', () => {
    expect(prorate(SEPT)).toEqual(prorate({ ...SEPT, leaveDates: new Set() }));
  });
});
