import { api } from './client';
import { qs } from './query';

/**
 * F01, F02, F03, F04, F05, F08: reports, Excel export and payroll.
 *
 * Server source: `server/src/reports/` and `server/src/payroll/`.
 *
 * Careful: `/reports/*` is owner + manager. `/payroll` is owner-only and a separate
 * module. Both live in this file, so do not forget: nothing from payroll may be
 * shown to a manager (section 4.3, ADR-023).
 *
 * Careful: `from` and `to` are required (unlike activity, where they are optional).
 * Omitting them gives a 400. `thisMonthRange()` in `lib/format.ts` gives a default range.
 */

export type ReportFormat = 'json' | 'xlsx';
export type GroupBy = 'week' | 'month';
export type DayType = 'workday' | 'weekly_off' | 'holiday';
export type DayStatus = 'worked' | 'no_activity';

export interface ReportMeta {
  from: string;
  to: string;
  /** What was requested; later than `to` when `clampedToToday` is set. */
  requestedTo: string;
  /**
   * If a future date is requested, the server quietly trims the range to today, but
   * it says so. When that happens the page must say it too: otherwise someone who
   * asked for "1-31 August" and sees data only up to the 11th would think everyone
   * is behind.
   */
  clampedToToday: boolean;
  days: number;
  generatedAt: string;
  /** Employees that could not be included, listed by name instead of silently dropped. */
  excludedEmployees: string[];

  /**
   * Each employee's monthly target hours as written in the policy (`employeeId` to
   * hours), i.e. "hours in 26 ideal workdays" (208).
   *
   * Careful: do not compute this yourself. It used to be computed on the client, and
   * because future public holidays were missed it showed 216 instead of 208.
   *
   * Office days x 8h: Fridays, public holidays and the employee's own leave are
   * excluded (the owner's rule). It is counted per office day, not per month, so
   * asking for half a month returns the half-month number.
   *
   * Careful: this used to be the policy's flat 208 (G117). In October there are 24
   * office days, i.e. 192h, so the page showed a phantom 16-hour shortfall.
   *
   * Careful: 0 is a valid answer: "this employee has no office days in this range"
   * (on leave the whole time, or joined right at the end). It is not a failure.
   */
  targetHoursInRange: Record<number, number>;

  /**
   * Per employee, how many hours were expected up to now (`employeeId` to hours).
   *
   * Careful: do not compute this yourself either. The reason is the biggest bug this
   * page had. The Monthly page used to build it by summing the day rows'
   * `targetHours`, from the 1st of the month through today. But the browser does not
   * know two things:
   *   1. When tracking of the employee started. In this installation the agent was
   *      installed on 13 August 2026; the days before that silently became "0 hours
   *      worked" and the page showed everyone about 94 hours behind.
   *   2. That today is not counted in the expectation; otherwise everyone would look
   *      "behind" in the morning and the number would fix itself by evening.
   *
   * The window is decided by `elapsedWindow()` in the server's `summary.math.ts`,
   * and the tray, the Live Board and the daily email use exactly the same function.
   * Writing the rule again on the client would breed the next mismatch.
   *
   * Careful: `targetHoursInRange` covers the whole range; this is the part of it
   * that was observed.
   */
  expectedHours: Record<number, number>;

  /**
   * G108: the holiday dates, in the months whose workdays this report's target
   * rests on, that are not final yet ('YYYY-MM-DD', sorted).
   *
   * Careful: the server sent this field long ago but it was not declared here, so
   * TypeScript said nothing and the page did not know the numbers rested on an
   * estimate. This half of the contract was the root of G108: "written down, nobody
   * reads it".
   *
   * Careful: when a lunar date moves, that month's workdays change, and with them the
   * denominator of the daily target and payroll's `d / D`, i.e. money.
   *
   * Careful: an empty list means "all dates are final", not "no holidays".
   */
  approximateHolidayDates: string[];

  /**
   * G111: per employee, whether any finished workday has been observed yet.
   *
   * Careful: when `false`, `expectedHours` is 0, so the shortfall is 0 too, which
   * looks exactly like someone who met the target. The flag comes from the server;
   * do not infer it from `expectedHours === 0` here, since that can also mean "every
   * day was a day off", and then the statement would be false.
   */
  observed: Record<number, boolean>;

  /**
   * G110: per employee, the date observation started, `YYYY-MM-DD`.
   *
   * Careful: only for drawing cells. Do not multiply expectations by this date: the
   * expectation is in `expectedHours`, in one place. Counting it again on the client
   * means rewriting the "exclude today" rule too, and that is exactly how the
   * earlier bug was born.
   */
  trackedFrom: Record<number, string | null>;
}

/**
 * Who arrived when is not here and never will be: late tracking does not exist in
 * this product (ADR-011). The report says how many hours were worked, not when.
 */
export interface AttendanceRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  department: string | null;
  date: string;
  dayType: DayType;
  status: DayStatus;
  /**
   * G130 (R2): whether that day was an approved leave day for this person.
   *
   * Careful: leave already reached the numbers (target 0, no shortfall), but the row
   * looked exactly like a workday with zero hours. The numbers were not lying, but
   * they did not give the reason either.
   *
   * Careful: not to be mixed up with `dayType`: `dayType` says what the day is in
   * the office calendar, this says what it is for that one person.
   */
  onLeave: boolean;
  /** Careful: hours (decimal), not seconds. Show with `formatHoursAsDuration()`. */
  /**
   * How many tasks were finished that day (Complete button); `null` when 0.
   * Careful: starts are not counted — only finished work.
   */
  tasksDone: number | null;
  workedHours: number;
  idleHours: number;
  adjustmentHours: number;
  creditedHours: number;
  /**
   * That day's target: 208 / 26 = 8 hours on a workday, 0 on a day off.
   * Careful: the denominator is the policy constant, not that month's workdays, so
   * the number does not vary by month and matches the tray exactly.
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
     * Careful: the sum of the Target column above, not "how many hours were expected
     * so far" (that is `meta.expectedHours`). Days before tracking started and the
     * unfinished current day are included, because those rows are in the list too. It
     * sits right under the column in the footer, so it could not use a different
     * window: a total that differs from the column sum would be worse. Do not use it
     * to infer a shortfall.
     */
    targetHours: number;
    daysWithWork: number;
  };
}

export interface SummaryRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  /** `'YYYY-MM'` for months, the week's start date for weeks. */
  bucket: string;
  /**
   * The part of the bucket inside the range and the employment period, not the whole month/week.
   */
  bucketStart: string;
  bucketEnd: string;
  workdays: number;
  daysWithWork: number;
  workedHours: number;
  adjustmentHours: number;
  creditedHours: number;
  /**
   * Sum of the targets of this bucket's days that fall in the range and the
   * employment period.
   * Careful: not the expectation; days before tracking started and today are
   * included. Do not build a shortfall from `targetHours - creditedHours`; that was
   * the earlier bug. `shortfallHours` below is already computed over the correct window.
   */
  targetHours: number;
  /**
   * `max(0, expected - counted hours)`; the denominator is the same window as
   * `meta.expectedHours` (tracking start through yesterday), cut down to this bucket.
   *
   * Careful: the target is calendar information, while a shortfall is a verdict about
   * a person, and a verdict can only rest on days that were observed and finished.
   * So this column will not match Target minus something, and that is correct.
   */
  shortfallHours: number;
  /**
   * `max(0, counted hours - targetHours)`; the denominator is the full target, not the expectation.
   * Careful: using the expectation would make today's worked hours "overtime" for
   * everyone while the monthly target has not even been reached. "Ahead" (pace) and
   * "worked extra" (overtime) are not the same thing.
   */
  overtimeHours: number;
}

export interface SummaryReport {
  meta: ReportMeta;
  groupBy: GroupBy;
  /**
   * Careful: O4: this system does not compute overtime pay, only hours. The sentence must be shown.
   */
  overtimeNote: string;
  rows: SummaryRow[];
}

export type UsageCategory =
  | 'productive'
  | 'neutral'
  | 'unproductive'
  | 'uncategorized';

export interface ProductivityItem {
  /** The domain for a browser, otherwise the process name. */
  key: string;
  kind: 'app' | 'site';
  category: UsageCategory;
  displayName: string | null;
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
   * Careful: the denominator includes uncategorized time, so it will not match
   * `daily_summary` exactly.
   */
  productiveSharePct: number;
}

/** F04. Careful: `DailyProductivityReport` in `activity.ts` (D07) is a different thing. */
export interface ProductivityReport {
  meta: ReportMeta;
  totalTrackedHours: number;
  uncategorizedHours: number;
  top: ProductivityItem[];
  byEmployee: ProductivityEmployeeRow[];
}

export interface ReportQuery {
  /** Required, `YYYY-MM-DD`. */
  from: string;
  to: string;
  /** When one person's report is wanted. */
  employeeId?: number;
}

/** F01 — `GET /api/v1/reports/attendance?from=&to=&employeeId=` */
export function getAttendanceReport(
  query: ReportQuery,
  signal?: AbortSignal,
): Promise<AttendanceReport> {
  return api<AttendanceReport>(`/reports/attendance${qs({ ...query })}`, {
    signal,
  });
}

/** F02 — `GET /api/v1/reports/summary?from=&to=&groupBy=week|month` */
export function getSummaryReport(
  query: ReportQuery & { groupBy?: GroupBy },
  signal?: AbortSignal,
): Promise<SummaryReport> {
  return api<SummaryReport>(`/reports/summary${qs({ ...query })}`, { signal });
}

/** F04: `GET /api/v1/reports/productivity?from=&to=&limit=` (limit at most 200) */
export function getProductivityReport(
  query: ReportQuery & { limit?: number },
  signal?: AbortSignal,
): Promise<ProductivityReport> {
  return api<ProductivityReport>(`/reports/productivity${qs({ ...query })}`, {
    signal,
  });
}

/**
 * F05: Excel download link.
 *
 * Open it with a plain `<a href={...} download>`, not with `fetch`. The server
 * sends `Content-Disposition: attachment`, the cookie goes along on its own
 * (same origin), and the browser's own download UI is the most familiar.
 *
 * Careful: the `/api/v1` prefix is hand-written into the path here. `api()` adds
 * it itself, but this string does not go through `api()`; it goes straight into
 * the href.
 */
export function reportXlsxUrl(
  kind: 'attendance' | 'summary' | 'productivity',
  query: ReportQuery & { groupBy?: GroupBy; limit?: number },
): string {
  return `/api/v1/reports/${kind}${qs({ ...query, format: 'xlsx' })}`;
}

// ── F03 · Payroll (owner-only) ───────────────────────────────────────────────
