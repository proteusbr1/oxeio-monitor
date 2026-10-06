import { describe, expect, it } from 'vitest';

import {
  computePayroll,
  paisaToTaka,
  salaryForMonth,
  supersededThrough,
} from '../src/payroll/payroll.math';

/** 208 hours, in seconds */
const TARGET = 208 * 3600;

/**
 * No deduction for days that were not observed (owner's decision).
 *
 * Bug found in the field: the shortfall was measured against the full
 * `targetSec`, but `creditedSec` only comes from days when the system was
 * running. In August 2026 tracking started on the 13th-15th, so nearly half
 * the month was unobserved, yet those days counted as shortfall and were
 * deducted from salary.
 *
 * Measured cost in the field: 12 people's deductions came to ৳79,788, of which
 * ৳61,280 was for unobserved days.
 */
describe('payroll: no deduction for unobserved days', () => {
  /** The core test of this describe: the real shape of August. */
  it('when half the month was not tracked, only the observed part is asked for', () => {
    const line = computePayroll({
      monthlySalary: 10000,
      targetSec: TARGET,
      // Only 112 of the 208 hours were observed (14 workdays)
      observedTargetSec: 112 * 3600,
      creditedSec: 110 * 3600,
      workdays: 26,
      monthWorkdays: 26,
    });

    // shortfall is 2 hours, not 98
    expect(line.shortfallSec).toBe(2 * 3600);

    // the rate is still the full-month one: 10000 / 208 = 48.0769.../hour
    //   deduction = 10000 x 7200 / 748800 = about 96.15 taka
    expect(paisaToTaka(line.deductionPaisa)).toBe('96.15');
  });

  /**
   * This records what the old behaviour was, so that anyone bringing it back
   * notices the number. Same employee, same work, but measured against the
   * full month the deduction is 47 times larger.
   */
  it('what the deduction would be if measured against the full target', () => {
    const old = computePayroll({
      monthlySalary: 10000,
      targetSec: TARGET,
      observedTargetSec: TARGET, // the old behaviour
      creditedSec: 110 * 3600,
      workdays: 26,
      monthWorkdays: 26,
    });

    expect(old.shortfallSec).toBe(98 * 3600);
    expect(paisaToTaka(old.deductionPaisa)).toBe('4711.54');
  });

  /**
   * Absence is not forgiven: this guards the other direction. The day was
   * observed (a row was written); the person just did not work. Confusing the
   * two would let anyone get full pay without coming to the office.
   */
  it('not working on an observed day is still deducted', () => {
    const line = computePayroll({
      monthlySalary: 10000,
      targetSec: TARGET,
      observedTargetSec: 112 * 3600,
      creditedSec: 0,
      workdays: 26,
      monthWorkdays: 26,
    });

    expect(line.shortfallSec).toBe(112 * 3600);
    expect(line.deductionPaisa).toBeGreaterThan(0);
  });

  /**
   * If nothing was observed there is no shortfall at all; this is exactly what
   * happens in the first days of an employee added mid-month.
   */
  it('nothing observed means zero deduction', () => {
    const line = computePayroll({
      monthlySalary: 10000,
      targetSec: TARGET,
      observedTargetSec: 0,
      creditedSec: 0,
      workdays: 26,
      monthWorkdays: 26,
    });

    expect(line.shortfallSec).toBe(0);
    expect(line.deductionPaisa).toBe(0);
    expect(paisaToTaka(line.payablePaisa)).toBe('10000.00');
  });

  /**
   * The observed part cannot exceed the target: if it did anywhere in the
   * calculation, it would manufacture a shortfall.
   */
  it('an observed part above the target is capped at the target', () => {
    const line = computePayroll({
      monthlySalary: 10000,
      targetSec: TARGET,
      observedTargetSec: TARGET + 50 * 3600,
      creditedSec: TARGET,
      workdays: 26,
      monthWorkdays: 26,
    });

    expect(line.shortfallSec).toBe(0);
  });

  /**
   * Overtime is still measured against the full target, on purpose. Otherwise
   * someone whose half month was untracked would show "overtime" after a few
   * days of work, and the number would be meaningless.
   */
  it('overtime uses the full target, not the observed part', () => {
    const line = computePayroll({
      monthlySalary: 10000,
      targetSec: TARGET,
      observedTargetSec: 112 * 3600,
      creditedSec: 120 * 3600,
      workdays: 26,
      monthWorkdays: 26,
    });

    // the observed part is exceeded, but not the month's target, so OT is zero
    expect(line.overtimeSec).toBe(0);
    expect(line.shortfallSec).toBe(0);
  });
});

describe('payroll: converting shortfall to money', () => {
  it('nothing is deducted when the target is met', () => {
    const line = computePayroll({
      monthlySalary: 13000,
      targetSec: TARGET,
      observedTargetSec: TARGET,
      creditedSec: TARGET,
      // Full month: proration changes nothing here
      workdays: 26,
      monthWorkdays: 26,
    });

    expect(line.shortfallSec).toBe(0);
    expect(line.deductionPaisa).toBe(0);
    expect(paisaToTaka(line.payablePaisa)).toBe('13000.00');
  });

  it('nothing is deducted for working over the target, and OT money is not calculated', () => {
    const line = computePayroll({
      monthlySalary: 13000,
      targetSec: TARGET,
      observedTargetSec: TARGET,
      creditedSec: TARGET + 10 * 3600,
      // Full month: proration changes nothing here
      workdays: 26,
      monthWorkdays: 26,
    });

    expect(line.deductionPaisa).toBe(0);
    expect(line.overtimeSec).toBe(10 * 3600);
    expect(paisaToTaka(line.payablePaisa)).toBe('13000.00');
  });

  it('checks the numbers with a salary that divides evenly', () => {
    // 13000 / 208 = 62.50 taka/hour. 20 hours short = 1250 taka.
    const line = computePayroll({
      monthlySalary: 13000,
      targetSec: TARGET,
      observedTargetSec: TARGET,
      creditedSec: TARGET - 20 * 3600,
      // Full month: proration changes nothing here
      workdays: 26,
      monthWorkdays: 26,
    });

    expect(paisaToTaka(line.hourlyRatePaisa)).toBe('62.50');
    expect(paisaToTaka(line.deductionPaisa)).toBe('1250.00');
    expect(paisaToTaka(line.payablePaisa)).toBe('11750.00');
  });

  /**
   * The most useful test. 10000 / 208 = 48.0769..., which does not divide
   * evenly. Rounding the rate to paisa first (4808) and then multiplying by
   * the hours would give 961.60 for 20 hours, when the correct value is
   * 961.54. Six paisa a month sounds small, but the error always leans the
   * same way: against the employee.
   */
  it('for a salary that does not divide evenly, the rate is not rounded first', () => {
    const line = computePayroll({
      monthlySalary: 10000,
      targetSec: TARGET,
      observedTargetSec: TARGET,
      creditedSec: TARGET - 20 * 3600,
      // Full month: proration changes nothing here
      workdays: 26,
      monthWorkdays: 26,
    });

    expect(paisaToTaka(line.deductionPaisa)).toBe('961.54');

    const naive = Math.round((Math.round(1000000 / 208) * 20) / 1);
    expect(paisaToTaka(naive)).toBe('961.60'); // what it would have been
  });

  it('a full month of absence gives payable zero, not negative', () => {
    const line = computePayroll({
      monthlySalary: 15000,
      targetSec: TARGET,
      observedTargetSec: TARGET,
      creditedSec: 0,
      // Full month: proration changes nothing here
      workdays: 26,
      monthWorkdays: 26,
    });

    expect(paisaToTaka(line.deductionPaisa)).toBe('15000.00');
    expect(line.payablePaisa).toBe(0);
  });

  /**
   * Workdays present but target zero means the policy was set up wrong.
   * Accepting it would make a shortfall impossible and the deduction zero, so
   * someone could get full pay without working an hour. This check was kept
   * after proration was introduced.
   */
  it('workdays exist but the target is zero: rejected', () => {
    expect(() =>
      computePayroll({
        monthlySalary: 13000,
        targetSec: 0,
        observedTargetSec: 0,
        creditedSec: 0,
        workdays: 26,
        monthWorkdays: 26,
      }),
    ).toThrow(RangeError);
  });

  it('a negative salary is rejected', () => {
    expect(() =>
      computePayroll({
        monthlySalary: -1,
        targetSec: TARGET,
        observedTargetSec: TARGET,
        creditedSec: 0,
        workdays: 26,
        monthWorkdays: 26,
      }),
    ).toThrow(RangeError);
  });

  // -- Proration (ADR-025): joining mid-month ------------------------------

  describe('G37 — proration', () => {
    /** Joined on the 15th: d = 14, D = 26, target 14 x 8 = 112h */
    const HALF = {
      monthlySalary: 20000,
      targetSec: 112 * 3600,
      observedTargetSec: 112 * 3600,
      workdays: 14,
      monthWorkdays: 26,
    };

    it('salary is also prorated: d / D', () => {
      const line = computePayroll({ ...HALF, creditedSec: 112 * 3600 });

      // 20000 x 14 / 26 = 10,769.23
      expect(line.payablePaisa).toBe(Math.round((2000000 * 14) / 26));
      expect(line.deductionPaisa).toBe(0);
    });

    /**
     * The most important test in this file. If both salary and target are
     * prorated, the hourly rate becomes independent of d: S / (D x 8). If only
     * the target were prorated, this rate would double, and no single number
     * would reveal it.
     */
    it('the hourly rate equals that of a full-month employee', () => {
      const partial = computePayroll({ ...HALF, creditedSec: 0 });
      const full = computePayroll({
        monthlySalary: 20000,
        targetSec: 208 * 3600,
        observedTargetSec: 208 * 3600,
        creditedSec: 0,
        workdays: 26,
        monthWorkdays: 26,
      });

      expect(partial.hourlyRatePaisa).toBe(full.hourlyRatePaisa);
    });

    it('working half in a half month deducts half of the prorated salary', () => {
      const line = computePayroll({ ...HALF, creditedSec: 56 * 3600 });

      const prorated = Math.round((2000000 * 14) / 26);
      expect(line.deductionPaisa).toBe(Math.round(prorated / 2));
    });

    /** Not there at all that month: target 0, salary 0, and no fuss. */
    it('with no day in the month, everything is zero', () => {
      const line = computePayroll({
        monthlySalary: 20000,
        targetSec: 0,
        observedTargetSec: 0,
        creditedSec: 0,
        workdays: 0,
        monthWorkdays: 26,
      });

      expect(line.payablePaisa).toBe(0);
      expect(line.deductionPaisa).toBe(0);
      expect(line.shortfallSec).toBe(0);
    });

    /**
     * Whole month is a holiday (D = 0). Nobody has workdays and a shortfall is
     * impossible; owner's decision: full salary.
     */
    it('a month that is all holiday gets full salary', () => {
      const line = computePayroll({
        monthlySalary: 20000,
        targetSec: 0,
        observedTargetSec: 0,
        creditedSec: 0,
        workdays: 0,
        monthWorkdays: 0,
      });

      expect(line.payablePaisa).toBe(2000000);
    });

    /** Even working over the target, the prorated salary is the maximum (ADR-023). */
    it('working over the target earns no extra money', () => {
      const line = computePayroll({ ...HALF, creditedSec: 200 * 3600 });

      expect(line.payablePaisa).toBe(Math.round((2000000 * 14) / 26));
      expect(line.overtimeSec).toBe(88 * 3600);
    });
  });

  it('paisa to taka conversion keeps the decimals right', () => {
    expect(paisaToTaka(0)).toBe('0.00');
    expect(paisaToTaka(5)).toBe('0.05');
    expect(paisaToTaka(100)).toBe('1.00');
    expect(paisaToTaka(123456)).toBe('1234.56');
  });

  it('none of the office\'s twelve people ever gets a negative payable', () => {
    const salaries = [13000, 10000, 15000, 14000, 13000, 10000, 14000, 10000, 10000, 10000, 10000, 10000];

    for (const salary of salaries) {
      for (const workedHours of [0, 50, 100, 207, 208, 250]) {
        const line = computePayroll({
          monthlySalary: salary,
          targetSec: TARGET,
          observedTargetSec: TARGET,
          creditedSec: workedHours * 3600,
          // Full month: proration changes nothing here
          workdays: 26,
          monthWorkdays: 26,
        });

        expect(line.payablePaisa).toBeGreaterThanOrEqual(0);
        expect(line.payablePaisa).toBeLessThanOrEqual(salary * 100);
        expect(line.deductionPaisa + line.payablePaisa).toBe(salary * 100);
      }
    }
  });
});

/**
 * Past salaries must not move.
 *
 * Payroll used to read `employees.monthly_salary` live, so raising someone's
 * salary also changed the payroll of closed months. This block guards against
 * that.
 */
describe('salaryForMonth: what the salary was in that month', () => {
  const slices = [
    { throughMonth: '2026-06', monthlySalary: '12000.00' },
    { throughMonth: '2026-08', monthlySalary: '13000.00' },
  ];

  it('an old month gets the old salary', () => {
    expect(salaryForMonth('2026-05', '15000.00', slices)).toBe('12000.00');
    expect(salaryForMonth('2026-06', '15000.00', slices)).toBe('12000.00');
  });

  /** July is outside the scope of the 2026-06 slice, so it gets the next slice */
  it('a middle month gets the next slice', () => {
    expect(salaryForMonth('2026-07', '15000.00', slices)).toBe('13000.00');
    expect(salaryForMonth('2026-08', '15000.00', slices)).toBe('13000.00');
  });

  it('the month after all slices gets the current salary', () => {
    expect(salaryForMonth('2026-09', '15000.00', slices)).toBe('15000.00');
  });

  /** An empty table means "the salary never changed": the current value for every month */
  it('with no history, the current salary', () => {
    expect(salaryForMonth('2026-01', '15000.00', [])).toBe('15000.00');
  });

  /** null means no salary is set at all, which is not zero */
  it('stays null when no salary is set', () => {
    expect(salaryForMonth('2026-01', null, [])).toBeNull();
  });

  /** Even with the order shuffled, the smallest matching slice wins */
  it('the result does not depend on row order', () => {
    const shuffled = [...slices].reverse();
    expect(salaryForMonth('2026-07', '15000.00', shuffled)).toBe('13000.00');
  });
});

describe('supersededThrough: until which month the old salary applied', () => {
  it('normally up to the previous month', () => {
    expect(supersededThrough('2026-08', false)).toBe('2026-07');
  });

  it('in January, December of the previous year', () => {
    expect(supersededThrough('2026-01', false)).toBe('2025-12');
  });

  /**
   * If the current month is closed, that month's salary has already been paid,
   * so the new figure cannot go there: the old one ran through the current
   * month. Without this, a closed month's payroll would move again.
   */
  it('if the current month is closed, through that month', () => {
    expect(supersededThrough('2026-08', true)).toBe('2026-08');
    expect(supersededThrough('2026-01', true)).toBe('2026-01');
  });
});
