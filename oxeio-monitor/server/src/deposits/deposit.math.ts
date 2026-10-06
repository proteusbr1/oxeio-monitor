/**
 * Pure security-deposit calculations. No I/O.
 *
 * In its own file like `payroll.math.ts`, for the same reason: a mistake here
 * lands directly in someone's pocket, and mixed with the database it could not
 * be tested quietly.
 */

/** '2026-08' — year-month, in the Dhaka calendar. */
export type YearMonth = string;

export const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isYearMonth(value: string): boolean {
  return YEAR_MONTH.test(value);
}

/**
 * `2026-08` → `2026-09`.
 *
 * Careful: this is **not** done with `new Date()` — JS Date pulls in the time
 * zone when adding or subtracting months, and on the 31st "next month" can
 * jump two months ahead. Here it is just two numbers.
 */
export function nextMonth(ym: YearMonth): YearMonth {
  const [y, m] = ym.split('-').map(Number);
  return m === 12
    ? `${y + 1}-01`
    : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Every month from start to end, **both ends included**. */
export function monthsBetween(from: YearMonth, to: YearMonth): YearMonth[] {
  if (!isYearMonth(from) || !isYearMonth(to)) {
    throw new RangeError('Months must be in YYYY-MM format');
  }

  const out: YearMonth[] = [];
  let cursor = from;

  // Careful: string comparison is enough — 'YYYY-MM' sorts lexicographically in
  // time order, because both fields are zero-padded.
  while (cursor <= to) {
    out.push(cursor);
    cursor = nextMonth(cursor);

    // Careful: a ceiling. If `to` were mistakenly the year 2300, the loop would
    // run thousands of times and eat memory — and it would be found when the
    // server fell over, not by rejecting the bad input.
    if (out.length > 600) {
      throw new RangeError('The month range is too long (over 50 years)');
    }
  }

  return out;
}

/**
 * Days between two dates — the last one is **counted**.
 *
 * Careful: notice given on 31 July with the last day 30 August = 30 days, not
 * 29. That is what people mean by "30 days' notice", and a one-day difference
 * could withhold someone's 5,000 taka.
 */
export function daysBetween(from: Date, to: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

export interface NoticeCheck {
  /** How many days' notice was given — `null` if either date is missing */
  daysGiven: number | null;
  /** How many days the rule requires */
  daysRule: number;
  /**
   * Whether a refund is due under the rule.
   *
   * Careful: this is **not the last word** — the decision is the owner's
   * (ADR-028). This value only shows "what the rule says" on screen and picks
   * which button is the default.
   */
  meetsRule: boolean;
}

/**
 * Careful: if a date is unknown, `meetsRule` is **false** — treating "don't
 * know" as "yes" would silently waive the rule. The owner can still refund,
 * but then it is their conscious decision.
 */
export function checkNotice(
  noticeGivenOn: Date | null,
  lastWorkingDay: Date | null,
  daysRule: number,
): NoticeCheck {
  if (!noticeGivenOn || !lastWorkingDay) {
    return { daysGiven: null, daysRule, meetsRule: false };
  }

  const daysGiven = daysBetween(noticeGivenOn, lastWorkingDay);
  return { daysGiven, daysRule, meetsRule: daysGiven >= daysRule };
}

/**
 * **From which month this employee's deposit deductions start** — one definition.
 *
 * Careful: it was first **written in two places** — `ensureLedger()` when
 * filling the ledger, and `balances()` when showing the screen. If the two
 * drifted apart, the screen would show one month and the ledger record
 * another, and nobody could spot the difference — both would look "right",
 * they just would not match each other.
 *
 * Careful: the order is the rule:
 *   1. If the owner picked a month, **that is final** — even over `joined_on`.
 *      One is a guess, the other a statement.
 *   2. Otherwise, whichever is **later** of the joining month and the policy's month.
 */
export function effectiveDepositStart(input: {
  /** Chosen by the owner, `null` if not given */
  override: string | null;
  /** Month of `joined_on`, `null` if unknown */
  joinedMonth: string | null;
  /** The policy's general start month */
  policyStart: string;
}): string {
  if (input.override) return input.override;

  const joined = input.joinedMonth ?? input.policyStart;
  return joined > input.policyStart ? joined : input.policyStart;
}
