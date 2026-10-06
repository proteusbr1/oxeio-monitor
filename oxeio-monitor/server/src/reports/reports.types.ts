import type { Productivity } from '@prisma/client';

import type { GroupBy } from './reports.range';

/**
 * Shapes of the report responses: the service builds them, the Excel view
 * (reports.sheets.ts) reads them, and the controller returns them.
 *
 * Why a separate file: the queries and the print layout both need the same
 * contract, but if one imported the other it would create a cycle.
 *
 * Careful: this file has **no money field and none may ever be added**.
 * Managers get these reports too (spec section 4.3); salary is for the owner
 * only (`src/payroll/`, ADR-023).
 */

export interface ReportMeta {
  from: string;
  to: string;
  /** What was asked for; later than `to` when `clampedToToday`. */
  requestedTo: string;
  clampedToToday: boolean;
  days: number;
  generatedAt: string;
  /**
   * Employees that could not be included (inactive, but no leaving date).
   * They are named instead of being dropped silently; otherwise people would
   * assume "everyone is here" and not cross-check.
   */
  excludedEmployees: string[];

  /**
   * Per employee, **the total target for this range**, in hours
   * (`employeeId` -> hours).
   *
   * Formula, the owner's rule:
   *
   * ```
   * target      = office days x daily target (8 h)
   * office days = days in range - Fridays - public holidays - their own leave
   * ```
   *
   * **Counted by office days, not by month.** So one month, half a month or
   * three months all mean the same thing, and the question of *"which
   * month's target"* never arises.
   *
   * Careful: **this used to be the policy's flat 208** (G117). That was right
   * only for a month with 26 office days; in October 2026 there are 24, so
   * the real target is 192 h. The report showed a **phantom 16-hour
   * shortfall**, while the tray said a different number for the same month.
   * Now the tray, Live Board, `monthly_summary` and reports all give one number.
   *
   * Careful: **personal leave is removed too**, because leave is paid (R2).
   * Without that, leave days would become shortfall. So two people can have
   * different targets in the same month: whoever took leave has less.
   *
   * Careful: trimmed to the period of employment (`joined_on` ... `left_on`).
   * An empty intersection gives **0**, and 0 is a valid answer: *"no office
   * day in this range for them"*, not a failure.
   *
   * Careful: `expectedHours` is a different thing: that is **the whole
   * range**'s, while this one is *"how much should have been done so far"*
   * (cut by `elapsedWindow()`).
   */
  targetHoursInRange: Record<number, number>;

  /**
   * Per employee, **hours that should have been done so far**
   * (`employeeId` -> hours).
   *
   * The window is decided by `elapsedWindow()` in `summary.math.ts`: one
   * definition for the whole system:
   * ```
   * start = max(range start, joined_on, **that employee's** tracking start)
   * end   = min(range end, yesterday, left_on)
   * ```
   *
   * Careful: **why it is sent from the server:** the Monthly page built this
   * number itself, adding each day's target from the 1st of the month
   * **including today**. Both were wrong:
   *   1. On this installation the agent went in on 13 August 2026; we **do
   *      not know** how much anyone worked before. Counting from the 1st
   *      silently turned those unseen days into "0 hours worked" and the
   *      page showed everyone about 94 hours behind. **Absent monitoring is
   *      not failure.**
   *   2. Today was counted too, so at dawn everyone showed "behind" and by
   *      evening the number fixed itself.
   *
   * The client does not know the tracking start date, so it cannot compute
   * this. Sending only the date and letting the client add up was possible,
   * but then the "exclude today" rule would be written in the client
   * **again**, which is exactly how this bug was born. If the server gives
   * the number, the client has no rules, only reading.
   *
   * Careful: **both depend on the range**, differing only in the window:
   * `targetHoursInRange` is for the whole range, and this is for the part of
   * it that was **really observed**. Shortfall is measured **only** against
   * this; an unobserved day is nobody's failure.
   */
  expectedHours: Record<number, number>;

  /**
   * The holiday dates **not yet final** in the months whose working days this
   * report's target rests on: 'YYYY-MM-DD', sorted.
   *
   * Careful: lunar and tithi-based holiday dates change after the moon is
   * sighted. When one changes, that month's working days change, and with
   * them the denominator of the daily target and payroll's `d / D` fraction,
   * i.e. **money**. Eid-e-Miladunnabi on 26 August 2026 is exactly such a
   * date. The mark used to exist only in the holiday's **name**, so these
   * numbers rested on a guess and nobody knew.
   *
   * Careful: an empty list means "all holiday dates in these months are
   * final", not "no holidays".
   * Careful: it is filled from exactly **those** holiday rows used to count
   * working days (`approximateHolidayDates` in `reports.range.ts`): one
   * number, one definition. Do not count again from somewhere else.
   */
  approximateHolidayDates: string[];

  /**
   * **G111**: per employee, whether even one **finished** workday of theirs
   * has been observed yet (`employeeId` -> bool).
   *
   * Careful: when `false`, `expectedHours` is 0, so the shortfall is 0 too,
   * and on screen that looks **exactly like a person who met the target**. It
   * happens in a new employee's first week, or when someone's agent
   * installation is late, and the news gets read as "all is well".
   *
   * **This is the server's verdict, not a client guess.** The page could look
   * at `expectedHours === 0` and decide itself, but then the rule would be
   * written in the client again, which is exactly how the expectation bug was
   * born. The flag comes from the same window the number comes from.
   */
  observed: Record<number, boolean>;

  /**
   * **G110**: per employee, since when they have been watched
   * ('YYYY-MM-DD'), or `null` if never.
   *
   * Careful: **this is for drawing only.** Heatmap cells have three states
   * where there is no row: the future, outside employment, and **before
   * tracking started**. The first two had their own look, the third did not,
   * so they got the reddish touch of "nothing happened on a workday". On the
   * same page the number said "no claim" while the picture said "slacking",
   * and people look at the picture first.
   *
   * Careful: **do not compute expectation from this.** That is exactly how
   * the earlier bug was born: if the client takes the date and adds up
   * itself, it must also rewrite the "exclude today" rule, and one day the
   * two rules diverge. Expectation lives in `expectedHours`, in one place.
   */
  trackedFrom: Record<number, string | null>;
}

/**
 * **A one-line sentence** about approximate holiday dates, identical in
 * Excel, PDF and on screen.
 *
 * Careful: this sentence could have been hand-written three times, and that
 * is exactly how O4's overtime note ended up different in three places (one
 * with an em dash, one with a hyphen, and three times in payroll). With one
 * source, changing one changes all.
 *
 * Careful: an empty list returns `null`; no sentence is placed to say "no
 * uncertainty". A warning that always hangs across the page makes people
 * stop reading it, and then nobody looks even on the real days.
 */
export function approximateHolidayNote(dates: readonly string[]): string | null {
  if (dates.length === 0) return null;
  const n = dates.length;
  return (
    `${n} holiday date${n > 1 ? 's' : ''} in this range ${n > 1 ? 'are' : 'is'} not final yet ` +
    `(${dates.join(', ')}). Lunar dates move after the moon is sighted; if one moves, ` +
    'the working days for that month change — and with them the target hours and the ' +
    'payroll day fraction.'
  );
}

export type DayType = 'workday' | 'weekly_off' | 'holiday';
export type DayStatus = 'worked' | 'no_activity';

/**
 * `first_activity_at` / `latest_hour` are **deliberately not here**. They
 * exist in `daily_summary`, but a "who sat down when" column in the
 * attendance sheet would effectively be a late report, and late tracking is
 * not part of this product (ADR-011). The report says only how many hours
 * were worked, not when.
 */
export interface AttendanceRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  /**
   * Kind of work: rules attach **only to this**.
   *
   * Careful: `department` below is **kept** deliberately: old rows have
   * values, and the PDF transliteration path checks that field. But the
   * field was removed from the form, so it **stays empty for new
   * employees**; rely on `staffType` for classification.
   */
  staffType: 'designer' | 'researcher' | 'manager' | null;
  department: string | null;
  date: string;
  dayType: DayType;
  status: DayStatus;
  /**
   * **G130 (R2)**: whether that day was their approved leave.
   *
   * Careful: leave reached the numbers long ago: target 0, expectation 0, no
   * shortfall. But the row looked exactly like **a public holiday**: zero
   * hours, zero target. The numbers were not lying, but they did not give
   * the reason either, and to answer "why did they not work that day" you
   * had to go to Settings > Leave.
   *
   * Careful: not mixed into `dayType`: `dayType` says what the day is in the
   * **office** calendar, and this says what it is for **that one person**.
   * Merged, "how many people took leave on a workday" could no longer be counted.
   *
   * Careful: it is not written to `daily_summary`; the `leaves` table is read
   * directly, and that is right: if a leave is deleted, the badge goes at
   * once and does not wait for the next rollup.
   *
   * Someone can work on a leave day too; then `status` stays `worked` and
   * both facts show side by side (spec section 4: work on any day counts).
   */
  onLeave: boolean;
  workedHours: number;
  idleHours: number;
  adjustmentHours: number;
  creditedHours: number;
  /**
   * Number of **new** designs on that day.
   *
   * Careful: `null` if not a designer, not zero. Writing zero would put "0
   * designs" in a researcher's row, which reads like an accusation; the measure is not theirs.
   */
  /**
   * How many designs were **completed** on that day: the Complete button. `null` if 0.
   *
   * Careful: merely **opening** a file is not counted (owner's decision):
   * that count cannot tell "the one who makes it" from "the one who looks at it".
   */
  designsDone: number | null;
  /**
   * That day's target: on a workday `monthly_target / expected_workdays`
   * (208 / 26 = 8 hours), 0 on weekly off days and public holidays.
   *
   * Careful: the denominator is the **policy's constant**, not that month's
   * calendar workdays; why is in `dailyTargetSec()` in `reports.range.ts`.
   * So the number does not change from month to month, and matches the
   * tray/`monthly_summary` exactly.
   */
  targetHours: number;
}

export interface AttendanceReport {
  meta: ReportMeta;
  rows: AttendanceRow[];
  totals: {
    employees: number;
    rows: number;
    workedHours: number;
    creditedHours: number;
    /**
     * Careful: **the sum of the `targetHours` column of the rows above**, not
     * "how much should have been done so far". Days before tracking started
     * and today's unfinished day are in it, because those rows are in the list.
     *
     * Deliberately **not** taken from the window of `meta.expectedHours`: the
     * web footer and the PDF's "Total target" sit right under that column, so
     * if the window changed, the total would no longer add up with the column.
     * A total that does not match its own column is worse than any wrong
     * number. The difference is therefore stated in the **label** ("Target -
     * days listed"), not by changing the number. To measure anyone's
     * shortfall, use `meta.expectedHours`.
     */
    targetHours: number;
    daysWithWork: number;
  };
}

export interface SummaryRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  /** 'YYYY-MM' for months; the week's start date for weeks. */
  bucket: string;
  /** The part of the bucket inside the range and the employment period; not the whole month/week. */
  bucketStart: string;
  bucketEnd: string;
  /** How many of those work-zone days are workdays. */
  workdays: number;
  daysWithWork: number;
  workedHours: number;
  adjustmentHours: number;
  creditedHours: number;
  /**
   * Sum of the targets of the days of this bucket that fall in the range and
   * the employment period.
   *
   * Careful: **not the expectation**: days before tracking started and
   * today's unfinished day are in it. Do not use it for shortfall;
   * `shortfallHours` is already computed over the right window.
   * Careful: the weekly digest (`digest/weekly.rules.ts`) adds this number
   * up to build its own expectation (subtracting the target of unobserved
   * days), so if its meaning changes, the Telegram numbers will silently change too.
   */
  targetHours: number;
  /**
   * **Shortfall = max(0, expectation - counted hours)**: the denominator is
   * not `targetHours` but the same window as `meta.expectedHours`
   * (`elapsedWindow()`), cut to just this bucket.
   *
   * Careful: **why:** the target is calendar information, but a shortfall is
   * a **verdict** about a person. A verdict can only rest on days we really
   * observed (after the agent went in) and that have finished (not today).
   * It used to be `targetHours`, so the Monthly page said "pace -2h" while
   * **the same month's** Excel/PDF said "shortfall 77.2h". People trust the
   * paper, and the paper was the one that was wrong.
   *
   * Once the period is over (last month) the window covers the whole bucket,
   * i.e. expectation = target, so old reports' numbers do not change under this rule.
   */
  shortfallHours: number;
  /**
   * **Overtime = max(0, counted hours - `targetHours`)**: its denominator is
   * deliberately the target, not the expectation.
   *
   * Careful: with expectation, today's worked hours would be printed as
   * "overtime" for everyone (today is not in the expectation), though the
   * month's target has not been reached. **"Ahead of pace" and "worked
   * more" are not the same thing**; the first should be checked against
   * `meta.expectedHours`.
   *
   * Careful: expectation <= target, so shortfall and overtime are never both positive.
   */
  overtimeHours: number;
}

export interface SummaryReport {
  meta: ReportMeta;
  groupBy: GroupBy;
  /** O4: this system does not calculate money for overtime, only hours. */
  overtimeNote: string;
  rows: SummaryRow[];
}

export type UsageCategory = Productivity | 'uncategorized';

export interface ProductivityItem {
  /**
   * The domain for a browser, otherwise the process name.
   * Careful: **normalised**: lower case, no `www.` in domains
   * (`normalizeProcess` / `normalizeDomain` in `activity.math.ts`). Otherwise
   * `Chrome.exe` and `chrome.exe` would become two rows, wasting space in
   * the top list, and each would show a fraction of the real time.
   */
  key: string;
  kind: 'app' | 'site';
  category: UsageCategory;
  /** The name given by the category rule, null if none matched. */
  displayName: string | null;
  /**
   * Careful: whether more than one **known** category is mixed in.
   *
   * The category of `chrome.exe` comes from the domain: youtube.com
   * (unproductive) and github.com (productive) are both in the same process.
   * When `true`, the adjacent `category` is only **the biggest share**, not a single truth.
   */
  mixed: boolean;
  hours: number;
  sharePct: number;
}

export interface ProductivityEmployeeRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  productiveHours: number;
  neutralHours: number;
  unproductiveHours: number;
  uncategorizedHours: number;
  trackedHours: number;
  /**
   * productive / **total** tracked time (uncategorised included).
   *
   * Careful: do not assume it matches `daily_summary.productivity_pct` or
   * `scorePct` of `/activity/productivity` exactly; there the denominator is
   * only **categorised** time. Here uncategorised time is in the denominator
   * too, so as rules get added the number rises by itself. If hidden, "95%
   * productive" would be shown while half the time is uncategorised.
   *
   * The relationship is
   * `productiveSharePct = scorePct x (100 - uncategorizedSharePct) / 100`,
   * and all three numbers now come from **the same** basket
   * (`scoreOf` in [activity.math.ts](../activity/activity.math.ts)).
   */
  productiveSharePct: number;
  /**
   * The single definition in `activity.math.ts`: productive / **categorised** time.
   *
   * Careful: `null` when categorised time is zero, not `0`. `0` would say
   * "this person did nothing productive", while the truth is "there is no
   * information to speak of". On a holiday or a day the agent was off, the
   * difference changes the meaning of the whole report.
   */
  productivityScorePct: number | null;
  /**
   * What percentage of total tracked time is unrecognised.
   * It **always** goes alongside the score: if 90% of the time is
   * unrecognised, even a 100% score means nothing, but the score alone would look great.
   */
  uncategorizedSharePct: number;
}

export interface ProductivityReport {
  meta: ReportMeta;
  totalTrackedHours: number;
  uncategorizedHours: number;
  top: ProductivityItem[];
  byEmployee: ProductivityEmployeeRow[];
}

/**
 * F05/F06: the generated file, with its name.
 *
 * Careful: `mime` is set in the service, not the controller. In the
 * controller we would have to remember again "which format was asked for",
 * and one day a `.pdf` file would go out with the `xlsx` MIME type; the
 * browser would then try to open it with Excel and say "file corrupt",
 * although the file was fine.
 */
export interface ReportFile {
  filename: string;
  mime: string;
  buffer: Buffer;
}

/**
 * **O4 is settled (23 August 2026):** the owner's answer: overtime has **no
 * separate rate**. So extra hours do not turn into money, and never will.
 *
 * Careful: this used to say *"no rate has been decided (open question O4)"*,
 * which is now **false**: the decision has been made, and the decision is
 * "no rate". The difference matters on printed paper: reading "not decided
 * yet", an employee would think money might come later, and our own paper
 * would create that false hope.
 *
 * Careful: `OVERTIME_NOTE_EN` in [reports.pages.ts](reports.pages.ts) says
 * the same thing (print-friendly form); change one and change the other.
 */
export const OVERTIME_NOTE =
  'Overtime pay is not calculated — there is no separate overtime rate';
