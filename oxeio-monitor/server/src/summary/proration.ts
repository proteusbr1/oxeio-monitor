import { countLeaveWorkdays, countWorkdays } from './summary.math';

/**
 * **Proration (ADR-025)**: how much target and salary apply when someone
 * joins or leaves mid-month.
 *
 * Why a separate file: this is the only place that decides how much someone
 * is owed *for that month*. A mistake lands directly in people's pockets and
 * is noticed only at month end, so nothing from the DB or HTTP is allowed in.
 *
 * The rule (ADR-025):
 *
 * ```
 * D = workdays in that month       (excluding weekly off days and holidays)
 * d = the employee's own workdays  (those falling within joined_on ... left_on)
 *
 * daily target     = monthly_target / policy_workdays   (208 / 26 = 8 hours)
 * target           = d x daily target
 * applicable salary = monthly salary x d / D
 * ```
 *
 * Careful: **salary and target must both be prorated together.** Prorating
 * only the target would double the hourly rate: 13 workdays x 8 = 104 h, with
 * salary 20,000 -> 192 currency units/hour (should be 96). Doing both gives rate =
 * (S*d/D) / (d*8) = **S / (D*8)**, so someone who joined on the 15th and
 * someone who stayed the whole month have exactly the same hourly rate. That
 * equality is the foundation of the whole rule.
 */
export interface ProrationInput {
  /** First and last day of the month (from `monthBounds()`). */
  monthStart: Date;
  monthEnd: Date;

  /** The employee's joining date; `null` = already there before the month began. */
  joinedOn: Date | null;
  /** The employee's last day; `null` = still here. */
  leftOn: Date | null;

  /** ISO weekdays (Friday = 5); `null` = every day is a workday. */
  weeklyOffDays: readonly number[];
  /** The holidays in that month, matched by `getTime()`. */
  holidays: ReadonlySet<number>;

  /**
   * **The employee's own leave days** (`getTime()`), not organisation holidays.
   *
   * Careful: deliberately **not mixed into** `holidays`; that is the key
   * decision here. `holidays` is used to count **D**, the denominator of
   * payroll's `d / D`, the same for everybody. If one person's leave went in
   * there, **their leave would change the denominator for the whole team**.
   *
   * Leave reduces only the **hours target**, not the numerator **d**, so it is
   * **paid leave**. Reducing d would silently cut pay whenever someone took leave.
   */
  leaveDates?: ReadonlySet<number>;

  /** The policy's monthly target, in seconds (208 hours). */
  monthlyTargetSec: number;
  /**
   * The policy's `expected_workdays` column (26).
   *
   * Careful: **"8 hours" is hardcoded nowhere**; it comes out of dividing
   * these two columns. Right now it comes to exactly 8; if the contract later
   * changes to 240 h / 26, the rule changes with it, with no migration.
   */
  policyWorkdays: number;
}

export interface Proration {
  /** D: total workdays in that month. */
  monthWorkdays: number;
  /** d: the employee's own workdays. */
  employeeWorkdays: number;
  /** Target for one workday, in seconds (not rounded; see the note below). */
  dailyTargetSec: number;
  /**
   * How many of the d days the employee was on leave.
   * Careful: only leave that falls on a **workday** counts. Even if someone
   * marks leave on a Friday or a public holiday, there was no target that day anyway.
   */
  leaveWorkdays: number;
  /** (d - leave) x daily target; goes into `monthly_summary.target_sec`. */
  targetSec: number;
  /** Whether the employee is there the whole month. When `false` the web shows "prorated". */
  partial: boolean;
}

/**
 * Careful: `Date` comparison uses `getTime()`. Prisma's `@db.Date` always
 * gives UTC midnight, and so does `monthBounds()`.
 */
function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function earlierOf(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * The core calculation.
 *
 * Careful: `dailyTargetSec` is **not rounded**. For 26 days, 748800 / 26 =
 * 28800 divides exactly, but other policies may give fractions. Rounding each
 * day and then multiplying would not reach the real number at month end, so
 * someone who hit the target exactly would still see a shortfall on paper.
 * Round only at the very end.
 */
export function prorate(input: ProrationInput): Proration {
  const {
    monthStart,
    monthEnd,
    joinedOn,
    leftOn,
    weeklyOffDays,
    holidays,
    monthlyTargetSec,
    policyWorkdays,
    leaveDates,
  } = input;

  if (!Number.isFinite(monthlyTargetSec) || monthlyTargetSec < 0) {
    throw new RangeError('The monthly target cannot be negative or undefined');
  }
  if (!Number.isFinite(policyWorkdays) || policyWorkdays <= 0) {
    throw new RangeError('The policy workdays cannot be zero or negative');
  }

  const monthWorkdays = countWorkdays(monthStart, monthEnd, weeklyOffDays, holidays);

  // Intersection of the employment period with the month.
  const from = joinedOn === null ? monthStart : laterOf(joinedOn, monthStart);
  const to = leftOn === null ? monthEnd : earlierOf(leftOn, monthEnd);

  /**
   * Careful: the intersection can also be **empty**: joined after the month,
   * or left before it. `countWorkdays` would get a reversed range (`from > to`)
   * and the loop would return zero anyway, but it is blocked explicitly here,
   * because "zero since the loop did not run" and "zero since they were not
   * there that month" are two different things to a reader.
   */
  const employeeWorkdays =
    from.getTime() > to.getTime()
      ? 0
      : countWorkdays(from, to, weeklyOffDays, holidays);

  const dailyTargetSec = monthlyTargetSec / policyWorkdays;

  /**
   * Number of leave days that fall within the employment period **on workdays**.
   *
   * Careful: filtered with `isWorkday`, otherwise a leave written on a Friday
   * would cut eight hours from the target although there was no target that
   * day. The failure would be silent: the number drops and nobody finds why.
   */
  const leaveWorkdays = countLeaveWorkdays(
    leaveDates,
    from,
    to,
    weeklyOffDays,
    holidays,
  );

  const billableWorkdays = Math.max(0, employeeWorkdays - leaveWorkdays);

  return {
    monthWorkdays,
    employeeWorkdays,
    leaveWorkdays,
    dailyTargetSec,
    targetSec: Math.round(billableWorkdays * dailyTargetSec),
    partial: employeeWorkdays < monthWorkdays,
  };
}

/**
 * The salary fraction, **to be multiplied in paisa**, not on its own.
 *
 * Careful: the fraction is returned as a `number`, so **money must not be
 * computed from it directly**. `computePayroll()` multiplies and rounds once,
 * using d and D itself. Rounding in two places would make someone's salary
 * differ by a few paisa, caught only when reconciling at month end.
 *
 * **If D = 0 the result is 1**: the whole month is off (possible when Eid and
 * public holidays fall together). Nobody has any workday, so a shortfall is
 * impossible, and the owner's decision (O9) is **full salary**. Treating 0/0
 * as 0 would give everyone zero salary that month through no fault of theirs.
 */
export function salaryFraction(employeeWorkdays: number, monthWorkdays: number): number {
  if (monthWorkdays <= 0) return 1;
  if (employeeWorkdays <= 0) return 0;
  return Math.min(1, employeeWorkdays / monthWorkdays);
}
