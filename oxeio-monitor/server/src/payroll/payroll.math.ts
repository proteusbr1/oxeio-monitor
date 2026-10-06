/**
 * Converting a shortfall in hours into money: pure functions, no I/O.
 *
 * Kept in a separate file because this is the only place where the system
 * **decides about someone's pay**. Mixed in with the database or HTTP it could
 * not be tested in isolation, yet a mistake lands directly in a person's pocket.
 */

/** Money is never computed in binary float: all arithmetic is in minor units (integers, hundredths). */
export const MINOR_PER_UNIT = 100;

export interface PayrollInput {
  /** Monthly salary, in the currency's whole units. */
  monthlySalary: number;
  /**
   * That employee's target for that month: **their work days × the daily
   * target** (from `prorate()`). Not the flat 208 any more.
   */
  targetSec: number;
  /** worked + adjustment; this is what is compared with the target. */
  creditedSec: number;

  /**
   * **How much of the target we actually observed** *(owner's decision: "no
   * deduction for days that were not observed")*.
   *
   * The bug this fixes: the shortfall was measured against the whole
   * `targetSec`, while `creditedSec` only comes from days the system was
   * running. In August tracking started on the 13th to 15th, so nearly half the
   * month silently became shortfall: the deduction for 12 people came to
   * **79,788.00**, of which **61,280.00** was for days nobody ever observed.
   *
   * The rate does not change. The hourly rate is still `salary ÷ targetSec`,
   * since the salary is for the whole month's work. What changes is **how much
   * of it is asked for**.
   *
   * Deliberately **not optional**, like `workdays`. With a default, a new
   * caller would silently fall back to the old (wrong) behaviour, and the
   * mistake would be found on someone's pay slip.
   */
  observedTargetSec: number;

  /**
   * **G37 · ADR-025**: their work days (d) and the month's work days (D).
   *
   * Deliberately **not optional.** With a default, a new caller would
   * silently compute pay without proration, so someone who joined on the 15th
   * would get a full month's salary, noticed only at month end. Making it
   * required lets the compiler stand guard.
   */
  workdays: number;
  monthWorkdays: number;

  // ── the work regime (src/calendar/work-regime.ts); the defaults are the original rule ──
  /** how the person is paid; default monthly */
  payBasis?: 'monthly' | 'hourly' | 'none';
  /** payBasis = hourly: the rate per hour */
  hourlyRate?: number;
  /** monthly: missing hours are deducted (default true) */
  deductShortfall?: boolean;
  /** overtime is paid at this multiple of the hourly rate; null/undefined = not paid */
  overtimeMultiplier?: number | null;
  /** the policy has no hours target: nothing is short, nothing is overtime */
  noTarget?: boolean;
  /** hourly: paid leave this month, in seconds (leave days × daily target) */
  paidLeaveSec?: number;
}

export interface PayrollLine {
  payBasis: 'monthly' | 'hourly' | 'none';
  /** money for overtime hours, in minor units (0 when overtime is not paid) */
  overtimePayMinor: number;
  /** Hourly rate, in minor units. */
  hourlyRateMinor: number;
  shortfallSec: number;
  overtimeSec: number;
  /** How much less is paid for the shortfall, in minor units. 0 if there is no shortfall. */
  deductionMinor: number;
  /** Salary minus deduction, in minor units. */
  payableMinor: number;
  /**
   * The **money for extra hours is not calculated**; only the hours are reported.
   * What the OT rate should be (1x, 1.5x, or nothing) is a business decision.
   *
   * The owner has decided there is **no** separate rate. So this field will
   * always show hours, and that is now **a known rule, not an unknown**.
   */
  overtimeNote: string;
}

/**
 * **O4 is settled**: the owner's answer is that overtime has
 * **no separate rate**. So the sentence no longer says "not decided", it says
 * "no rate".
 *
 * This same sentence used to be **hand-written in three places**. Thanks to the
 * literal type the compiler did catch mismatches, but changing it meant finding
 * all three, and that is exactly how in this project one would change and the
 * others not. Now there is one source, and the type comes from it (`typeof`).
 *
 * The report's `OVERTIME_NOTE` is a different sentence (different context
 * there), but it states the **same decision**, so if one changes, check the other.
 */
export const PAYROLL_OVERTIME_NOTE =
  'Not calculated — there is no separate overtime rate';

/** The note when the policy pays overtime */
export function overtimePaidNote(multiplier: number): string {
  return `Paid at ×${multiplier} the hourly rate`;
}

/**
 * Careful: you cannot divide by a zero or negative target. It should not happen
 * (208 is set in the work policy), but if it did, a quiet Infinity would come
 * out and work out as an infinite amount deducted from someone's salary.
 */
export function computePayroll(input: PayrollInput): PayrollLine {
  const {
    monthlySalary,
    targetSec,
    creditedSec,
    observedTargetSec,
    workdays,
    monthWorkdays,
  } = input;
  const payBasis = input.payBasis ?? 'monthly';
  const multiplier =
    input.overtimeMultiplier !== null && input.overtimeMultiplier !== undefined && input.overtimeMultiplier > 0
      ? input.overtimeMultiplier
      : null;
  const overtimeNote = multiplier === null ? PAYROLL_OVERTIME_NOTE : overtimePaidNote(multiplier);

  if (payBasis === 'none') {
    return {
      payBasis,
      overtimePayMinor: 0,
      hourlyRateMinor: 0,
      shortfallSec: 0,
      overtimeSec: 0,
      deductionMinor: 0,
      payableMinor: 0,
      overtimeNote,
    };
  }
  if (payBasis === 'hourly') return hourlyPay(input, multiplier, overtimeNote);


  if (!Number.isFinite(monthlySalary) || monthlySalary < 0) {
    throw new RangeError('Salary cannot be negative or undefined');
  }
  if (!Number.isFinite(creditedSec) || creditedSec < 0) {
    throw new RangeError('Credited time cannot be negative');
  }
  if (!Number.isFinite(workdays) || workdays < 0) {
    throw new RangeError('Workdays cannot be negative or undefined');
  }
  if (!Number.isFinite(monthWorkdays) || monthWorkdays < 0) {
    throw new RangeError('The month workdays cannot be negative or undefined');
  }

  const baseMinor = Math.round(monthlySalary * MINOR_PER_UNIT);

  /**
   * **Applicable salary = monthly × d ÷ D**: the core line of G37.
   *
   * Careful: multiply and divide **together**, not by computing the fraction
   * first. `salaryFraction()` is provided separately, but it is not used for
   * money: rounding twice would make a few cents of difference in someone's pay.
   *
   * D = 0 (the whole month off) → full salary (O9). A shortfall is then
   * impossible, since the target is 0 too.
   */
  const salaryMinor =
    monthWorkdays <= 0
      ? baseMinor
      : Math.round((baseMinor * Math.min(workdays, monthWorkdays)) / monthWorkdays);

  /**
   * **Target 0 is valid, but for one reason only.**
   *
   * If someone has no work days at all (joined after the month, or the whole
   * month off), a target of 0 is right, and a shortfall is impossible.
   *
   * But a target of 0 **despite having work days** means the policy was set
   * wrongly, and quietly accepting it has a terrible result: a shortfall is
   * impossible, so the deduction is zero too, i.e. **someone could work not one
   * hour and get the full salary**. So in that state it throws, as before.
   */
  if (!Number.isFinite(targetSec) || targetSec <= 0) {
    // a policy with no hours target (basis 'none') is the legitimate case:
    // the salary is paid, nothing is short, nothing is overtime
    if (workdays > 0 && !input.noTarget) {
      throw new RangeError('The monthly target cannot be zero or negative');
    }

    return {
      payBasis,
      overtimePayMinor: 0,
      hourlyRateMinor: 0,
      shortfallSec: 0,
      overtimeSec: input.noTarget ? 0 : Math.max(0, creditedSec),
      deductionMinor: 0,
      // 0 work days means d/D is 0 too, so this is 0; only D = 0 gives the full salary
      payableMinor: salaryMinor,
      overtimeNote,
    };
  }

  const targetHours = targetSec / 3600;

  // Careful: the rate is **not** rounded separately for the deduction; below it
  // goes directly salaryMinor × shortfall ÷ target. 13000 ÷ 208 = 62.5 currency units,
  // but 10000 ÷ 208 = 48.0769…. Rounding the rate first would multiply that
  // fraction by every hour and end up a few currency units off at month end.
  const hourlyRateMinor = Math.round(salaryMinor / targetHours);

  /**
   * **The shortfall is measured against the observed part, not the whole target.**
   *
   * Careful: `Math.min`: the observed part can never exceed the whole target.
   * If it did (in some corner of the calculation) a shortfall would be invented.
   */
  const billableSec = Math.min(observedTargetSec, targetSec);

  const deficitSec = Math.max(0, billableSec - creditedSec);

  /**
   * **Extra hours are still against the whole target**, on purpose. "Overtime"
   * means doing **more** than the month's due work; measured against the
   * observed part, someone whose tracking covered only half the month would
   * show "overtime" after working just a few days.
   */
  const surplusSec = Math.max(0, creditedSec - targetSec);

  // the policy may keep the salary whole and only report the missing hours
  const deductionMinor =
    deficitSec === 0 || input.deductShortfall === false
      ? 0
      : Math.round((salaryMinor * deficitSec) / targetSec);

  // overtime paid at the policy's multiple of the hourly rate, if it pays it
  const overtimePayMinor =
    multiplier === null || surplusSec === 0
      ? 0
      : Math.round((salaryMinor * surplusSec * multiplier) / targetSec);

  return {
    payBasis,
    overtimePayMinor,
    hourlyRateMinor,
    shortfallSec: deficitSec,
    overtimeSec: surplusSec,
    deductionMinor,
    // The deduction can never exceed the salary: if someone is absent the whole
    // month, deficit = target, so deduction = full salary, payable = 0. Never negative.
    payableMinor: Math.max(0, salaryMinor - deductionMinor) + overtimePayMinor,
    overtimeNote,
  };
}

/**
 * Paid by the hour: hours counted × rate, plus paid leave (leave is paid,
 * the same rule as for monthly salaries). With an overtime multiplier, the
 * hours above the month's target are paid at that multiple; without one,
 * every hour is paid at the normal rate. Nothing is ever deducted.
 */
function hourlyPay(
  input: PayrollInput,
  multiplier: number | null,
  overtimeNote: string,
): PayrollLine {
  const rate = input.hourlyRate ?? 0;
  if (!Number.isFinite(rate) || rate < 0) {
    throw new RangeError('The hourly rate cannot be negative or undefined');
  }
  if (!Number.isFinite(input.creditedSec) || input.creditedSec < 0) {
    throw new RangeError('Credited time cannot be negative');
  }
  const rateMinor = Math.round(rate * MINOR_PER_UNIT);
  const credited = input.creditedSec;
  const leaveSec = Math.max(0, input.paidLeaveSec ?? 0);
  const target = input.noTarget || !(input.targetSec > 0) ? 0 : input.targetSec;

  const overtimeSec = target > 0 ? Math.max(0, credited - target) : 0;
  const regularSec = credited - (multiplier === null ? 0 : overtimeSec) + leaveSec;
  const regularMinor = Math.round((rateMinor * regularSec) / 3600);
  const overtimePayMinor =
    multiplier === null ? 0 : Math.round((rateMinor * overtimeSec * multiplier) / 3600);

  return {
    payBasis: 'hourly',
    overtimePayMinor,
    hourlyRateMinor: rateMinor,
    // reported, never deducted: an hourly worker is simply paid for fewer hours
    shortfallSec:
      target > 0 ? Math.max(0, Math.min(input.observedTargetSec, target) - credited) : 0,
    overtimeSec,
    deductionMinor: 0,
    payableMinor: regularMinor + overtimePayMinor,
    overtimeNote,
  };
}

/** Minor → whole units for display (5 → "0.05"; two decimals). */
export function minorToAmount(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / MINOR_PER_UNIT)}.${String(abs % MINOR_PER_UNIT).padStart(2, '0')}`;
}

// ════════════════════════════════════════════════════════════════════════════
// What the salary was in each month, so the past does not move
// ════════════════════════════════════════════════════════════════════════════

/**
 * A slice of an **old** salary: "this was it up to this month".
 *
 * Careful: the figure is a `string`, not a `number`. Prisma's `Decimal` arrives
 * as a string, and converting to `Number` midway could silently round the amount.
 */
export interface SalarySlice {
  /** 'YYYY-MM': up to and including this month */
  throughMonth: string;
  monthlySalary: string;
}

/**
 * **The salary that was actually in force that month.**
 *
 * Why it is needed: payroll used to read `employees.monthly_salary` **live**,
 * so raising someone's salary **also changed the payroll of closed months**,
 * which then no longer matched the paper they were paid on.
 *
 * There is a single rule: **the smallest `throughMonth` that is equal to or
 * greater than that month**.
 *
 * ```
 * Requested: 2026-07
 * Rows: [2026-06 → 12000]  [2026-08 → 13000]
 *                            ↑ this one: July falls under it
 * ```
 *
 * If no row matches, **the current salary** is returned. An empty table means
 * "the salary never changed", and then the current value is true for every month.
 *
 * `null` means **no salary is set at all**: not zero, and the screen shows the
 * two differently (`monthlySalary` in `payroll.service.ts`).
 */
export function salaryForMonth(
  yearMonth: string,
  currentSalary: string | null,
  slices: readonly SalarySlice[],
): string | null {
  let best: SalarySlice | null = null;

  for (const slice of slices) {
    if (slice.throughMonth < yearMonth) continue;
    if (best === null || slice.throughMonth < best.throughMonth) best = slice;
  }

  return best === null ? currentSalary : best.monthlySalary;
}

/**
 * When a salary changes, **up to which month the old value ran**.
 *
 * The general rule: the new salary applies **from the current month**, so the
 * old one ran **up to the previous month**.
 *
 * The exception: **if the current month is already closed.** Then that month's
 * pay has already been paid, so the new figure cannot go there; the old one is
 * taken to have run **through the current month**, and the new one from the
 * next month. Without this, a closed month's payroll would move again, the very
 * disease this table was built to cure.
 */
export function supersededThrough(
  yearMonth: string,
  currentMonthClosed: boolean,
): string {
  if (currentMonthClosed) return yearMonth;

  const [y, m] = yearMonth.split('-').map((s) => Number.parseInt(s, 10));
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;

  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

/** How someone is paid in a month: the basis and its amount (strings, as stored) */
export interface PayTerms {
  payBasis: 'monthly' | 'hourly' | 'none';
  monthlySalary: string | null;
  hourlyRate: string | null;
}

export interface PayTermsSlice extends PayTerms {
  throughMonth: string;
}

/**
 * The pay terms that applied in `yearMonth` — the same rule as
 * `salaryForMonth()`: the earliest history slice that still covers the month,
 * otherwise today's terms. So changing someone from a salary to an hourly
 * rate in October does not rewrite September.
 */
export function payTermsForMonth(
  yearMonth: string,
  current: PayTerms,
  slices: readonly PayTermsSlice[],
): PayTerms {
  let best: PayTermsSlice | null = null;
  for (const slice of slices) {
    if (slice.throughMonth < yearMonth) continue;
    if (best === null || slice.throughMonth < best.throughMonth) best = slice;
  }
  return best === null
    ? current
    : { payBasis: best.payBasis, monthlySalary: best.monthlySalary, hourlyRate: best.hourlyRate };
}
