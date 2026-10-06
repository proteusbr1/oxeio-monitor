import { workDateOf } from '../agent/util/work-time';
import { isOffWeekday } from '../summary/weekly-off';

/**
 * The **pure** part of the reports: date parsing, range limits (F08), counting
 * work days, working out the daily target, splitting into buckets (week/month).
 *
 * Kept in a separate file because mistakes in reports almost always happen
 * **here**: one day off, a holiday sneaking into the count, or forgetting to
 * change the target at a month boundary. Mixed with the DB or HTTP these could
 * not be tested in isolation, yet in the end people trust the printed report.
 *
 * All dates here run as **UTC-midnight Dates**, just as Prisma's `@db.Date`
 * columns (`work_date`, `holiday_date`) return them and `work-time.workDateOf()`
 * builds them. So comparisons match directly, with no timezone conversion.
 */

/** F08: the most days that can be requested in one request. */
export const MAX_RANGE_DAYS = 370;

const DAY_MS = 86_400_000;
const SEC_PER_HOUR = 3600;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 'YYYY-MM-DD' → UTC-midnight of that date.
 *
 * `new Date('2026-8-1')` parses in the local timezone, and `Date.UTC(2026, 1, 30)`
 * quietly makes it 2 March. Neither gives an error; the report's date just
 * shifts by a day. So the format is bound with a regex, and the resulting date
 * is checked again (round-trip).
 */
export function parseWorkDate(text: string): Date {
  const m = ISO_DATE_RE.exec(text);
  if (!m) {
    throw new RangeError(`Date must be in YYYY-MM-DD format — got "${text}"`);
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`No such date on the calendar — "${text}"`);
  }

  return date;
}

/**
 * UTC-midnight Date → 'YYYY-MM-DD'.
 * `toLocaleDateString()` or `getFullYear()` are not used: with the server
 * outside the work zone (or west of UTC in CI) they would be a day behind.
 */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Number of days between two dates, **both ends included** (1 if the same day). */
export function daysInclusive(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
}

/**
 * ISO day: Monday = 1 ... Sunday = 7.
 * `getUTCDay()`, not `getDay()`: the dates are UTC-midnight, so a local getter
 * on a machine with a negative offset would give the previous day (a Friday
 * holiday would move to Thursday). `work_policies.weekly_off_day` is an ISO number too.
 */
export function isoDayOf(date: Date): number {
  return ((date.getUTCDay() + 6) % 7) + 1;
}

/** 'YYYY-MM' — exactly the same format as `monthly_summary.year_month`. */
export function monthKeyOf(date: Date): string {
  return toIsoDate(date).slice(0, 7);
}

export function monthBoundsOf(date: Date): { first: Date; last: Date } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return {
    first: new Date(Date.UTC(year, month, 1)),
    // Day 0 of the next month = the last day of this month; leap years work out by themselves
    last: new Date(Date.UTC(year, month + 1, 0)),
  };
}

export function eachDate(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    out.push(new Date(t));
  }
  return out;
}

/**
 * For every month the range touches, that month's **whole** bounds.
 *
 * The **denominator of the daily target does not come from here**: it is the
 * policy's `expected_workdays` (see the note on `dailyTargetSec()`). This
 * function's reason used to be written as exactly the opposite, and that text
 * made the wrong denominator look valid.
 *
 * The whole month is still needed, for two reasons:
 *   1. `meta.approximateHolidayDates` tells the reader which dates in **these
 *      months** are not final. Trimming to the range would bury the uncertain
 *      26 August holiday in a report for 1-14 August.
 *   2. In payroll's `d ÷ D` fraction, D = **that month's** calendar work days,
 *      so if any holiday in the month moves, money moves, even outside the range.
 */
export function monthsIn(
  from: Date,
  to: Date,
): { key: string; first: Date; last: Date }[] {
  const out: { key: string; first: Date; last: Date }[] = [];
  let cursor = monthBoundsOf(from).first;

  while (cursor.getTime() <= to.getTime()) {
    const bounds = monthBoundsOf(cursor);
    out.push({ key: monthKeyOf(cursor), ...bounds });
    cursor = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    );
  }

  return out;
}

// ── Range validation (F08) ──────────────────────────────────────────────────

export interface ReportRange {
  from: Date;
  /** The effective end date: a future request is clamped to today */
  to: Date;
  /** What was requested; goes in the response to show whether it was clamped */
  requestedTo: Date;
  clampedToToday: boolean;
  /** The effective number of days */
  days: number;
}

export interface ParseRangeOptions {
  /** To set a fixed time in tests */
  now?: Date;
  maxDays?: number;
}

/**
 * F08: any from–to, but **with limits**.
 *
 * The limit is checked on the **requested** range, before clamping. The other
 * way round, `from=2000-01-01&to=2999-12-31` would be clamped to today and pass
 * as "11 days", so the server would answer a completely different question
 * without the user knowing.
 *
 * Future dates are **clamped, not rejected**, because on the dashboard picking
 * "this month" on 11 August asks for 1-31 August; that is not a mistake worth
 * an error. But the clamping is not silent: `clampedToToday` goes in the
 * response and is written on Excel's "Info" sheet too. Without clamping, the
 * targets of future work days would be added up and show everyone a huge shortfall.
 */
export function parseReportRange(
  fromText: string,
  toText: string,
  opts: ParseRangeOptions = {},
): ReportRange {
  const maxDays = opts.maxDays ?? MAX_RANGE_DAYS;
  const from = parseWorkDate(fromText);
  const requestedTo = parseWorkDate(toText);

  if (requestedTo.getTime() < from.getTime()) {
    throw new RangeError('The end date cannot be before the start date');
  }

  const requestedDays = daysInclusive(from, requestedTo);
  if (requestedDays > maxDays) {
    throw new RangeError(
      `The range can be at most ${maxDays} days — ${requestedDays} days were requested`,
    );
  }

  // Today's date in the work zone, through work-time rather than computing the offset ourselves
  const today = workDateOf(opts.now ?? new Date());

  if (from.getTime() > today.getTime()) {
    throw new RangeError(
      'The whole range is in the future — there is no data for those days',
    );
  }

  const clampedToToday = requestedTo.getTime() > today.getTime();
  const to = clampedToToday ? today : requestedTo;

  return {
    from,
    to,
    requestedTo,
    clampedToToday,
    days: daysInclusive(from, to),
  };
}

// ── Work days and the target (§ 2.1-b) ──────────────────────────────────────

export interface WorkdayRule {
  /** ISO days (Mon = 1 … Sun = 7). If null, every calendar day is a work day. */
  weeklyOffDays: readonly number[];
  /**
   * The `getTime()` of the holidays.
   * A Date object in a Set matches by reference, not value, hence epoch ms.
   */
  holidays: ReadonlySet<number>;
}

/**
 * This is **not a block**: if someone works on a holiday the hours count in
 * full (§ 2.1-b). This function only says whether that day has a **target**.
 */
export function isWorkday(date: Date, rule: WorkdayRule): boolean {
  if (rule.holidays.has(date.getTime())) return false;
  if (isOffWeekday(isoDayOf(date), rule.weeklyOffDays)) {
    return false;
  }
  return true;
}

export function countWorkdays(
  first: Date,
  last: Date,
  rule: WorkdayRule,
): number {
  let count = 0;
  for (const date of eachDate(first, last)) {
    if (isWorkday(date, rule)) count += 1;
  }
  return count;
}

/**
 * One work day's target, in seconds.
 *
 * **The denominator is the policy's `expected_workdays` (26), not that month's
 * calendar work days.** This is the single-day form of § 2.1-b's formula
 * `expected_sec = target_sec × workdays_elapsed ÷ expected_workdays`, and
 * `prorate()` in `summary/proration.ts` does exactly the same division.
 *
 * **Why not the calendar is the whole point of this function.** If the
 * denominator were the month's work days, more holidays would **raise** the
 * daily target while the month's total stayed at 208 hours: public holidays
 * would give staff no benefit, only make the remaining days heavier. Dividing
 * by the policy constant keeps the day at 8 hours and the total falls in a
 * holiday month (25 × 8 = 200), which matches what people expect.
 *
 * The result is **not rounded**. In a 22-work-day policy 748800 ÷ 22 =
 * 34036.36...; rounding each day and adding up would not reach the real
 * number at month end, so someone could hit the target exactly and still see a
 * shortfall on paper. Round only at the very end, when converting to hours.
 *
 * A zero denominator returns 0, not Infinity. In practice unreachable: the
 * `expected_workdays` column is non-null, default 26, and the DTO has
 * `@Min(1) @Max(31)` (`admin/dto.ts`).
 */
export function dailyTargetSec(
  monthlyTargetSec: number,
  /** The policy's `expected_workdays`, not a number counted from the calendar */
  expectedWorkdays: number,
): number {
  if (!Number.isFinite(monthlyTargetSec) || monthlyTargetSec < 0) {
    throw new RangeError('The monthly target cannot be negative or undefined');
  }
  if (expectedWorkdays <= 0) return 0;
  return monthlyTargetSec / expectedWorkdays;
}

// ── Spans and a span's target ───────────────────────────────────────────────

/**
 * A date span with both ends included.
 *
 * `summary.math.ts`'s `ElapsedWindow` has exactly this shape too, so it can be
 * passed straight in. It is deliberately not imported: this file must not take
 * in any notion of the DB or the rollup.
 */
export interface DateSpan {
  from: Date;
  to: Date;
}

/**
 * The overlap of two spans, `null` if they do not meet.
 *
 * `null` is kept distinct from "a 0-day span", so the caller can tell "zero
 * because there is no overlap" from "zero because those days have no work days".
 */
export function overlapOf(a: DateSpan, b: DateSpan): DateSpan | null {
  const from = a.from.getTime() >= b.from.getTime() ? a.from : b.from;
  const to = a.to.getTime() <= b.to.getTime() ? a.to : b.to;
  return from.getTime() > to.getTime() ? null : { from, to };
}

/**
 * The span's total target, in seconds = **work days × daily target**.
 *
 * This is exactly the same formula as `prorate()`'s `targetSec` (there:
 * `employeeWorkdays × dailyTargetSec`). Whether the two stay the same is
 * guarded by a test in `test/reports.target.spec.ts` that **compares hours**,
 * not just the work-day counts, because last round exactly that way a
 * 8.00 vs 8.32 hours difference slipped through a green test.
 *
 * Multiply, do not add day by day: the daily target is now the same in every
 * month (the denominator is the policy constant), so the two give the same
 * **hours**. When the denominator varied by month, multiplying across a range
 * touching two months would have been wrong. The report's columns are printed
 * day by day, so "sum = this number" must hold; there is a separate test for that too.
 */
export function targetSecIn(
  span: DateSpan,
  rule: WorkdayRule,
  /** The result of `dailyTargetSec()`, not rounded */
  perWorkdaySec: number,
): number {
  return countWorkdays(span.from, span.to, rule) * perWorkdaySec;
}

// ── Approximate holidays: carrying uncertainty down to the number ───────────

/** One holiday row, with just what is needed to count uncertainty */
export interface NamedHoliday {
  /** UTC-midnight: exactly how `holidays.holiday_date` comes back */
  date: Date;
  /**
   * `holidays.approximate`: the date is an estimate that may still move. The
   * owner clears it on Settings → Holidays once the date is confirmed, and
   * from that moment the reports and payroll stop listing it.
   */
  approximate: boolean;
}

/**
 * Of the holidays the calculation rests on, which **dates are not final yet**:
 * 'YYYY-MM-DD', sorted.
 *
 * **Pass exactly the rows the work days were counted with**: one number, one
 * definition. Counting from a separate query or a list file would make the
 * report's denominator and the report's warning come from two places, and one
 * day they would say different things.
 *
 * **Why it is needed:** when a holiday date moves, whether that day is a work
 * day changes, so **how many days** the report's target covers changes (not the
 * denominator; that is the policy constant), and payroll's `d ÷ D` fraction
 * changes too, i.e. **directly the money**. A holiday on a lunar calendar is
 * exactly such a date: it depends on moon sighting, yet once it is fixed the
 * month's work days drop and everyone's `target_sec` changes. Without this
 * list the uncertainty would sit only on the holidays page, not beside the
 * number, so the target would rest on an assumption with no warning.
 *
 * It does not say "how wrong", it says "where it could be wrong". An empty list
 * means every holiday in these months is final, not "no holidays".
 *
 * An approximate holiday that falls on a weekly off day is counted too. Today
 * it does not reduce work days, true, but the date **can move**, and if it
 * moves onto a work day the denominator will change. "No effect today" and "no
 * uncertainty" are not the same thing.
 */
export function approximateHolidayDates(
  rows: readonly NamedHoliday[],
): string[] {
  // A Set: `holiday_date` is unique, but when ranges of several months are
  // joined the caller may send the same row twice by mistake; the same date would
  // then be counted twice and say "2 probable dates" when there is only one.
  const out = new Set<string>();
  for (const row of rows) {
    if (row.approximate) out.add(toIsoDate(row.date));
  }
  return [...out].sort();
}

// ── Week / month buckets (F02) ──────────────────────────────────────────────

export type GroupBy = 'week' | 'month';

export interface Bucket {
  /** 'YYYY-MM' for months, the week's start date 'YYYY-MM-DD' for weeks */
  key: string;
  start: Date;
  end: Date;
}

/**
 * The day a week starts: **the day after the weekly off day**.
 *
 * Not hardcoded. If the off day is Friday (ISO 5) the week starts on Saturday,
 * so the off day falls at the end of the week and a work week is not split
 * across two buckets. Assuming Monday would cut every work week that ends on a Friday (a Saturday-to-Thursday week) in
 * the middle. With no off day (null), the international habit: Monday.
 */
export function weekStartIsoDay(weeklyOffDays: readonly number[]): number {
  if (weeklyOffDays.length === 0 || weeklyOffDays.length >= 7) return 1;

  // With several days off the week starts after the off block, so the block
  // sits at the end of the week: Fri → Sat (as before), Fri+Sat → Sun,
  // Sat+Sun → Mon. Days off that are not next to each other (e.g. Wed + Sun)
  // form more than one block; the longest wins, Monday-first on a tie.
  const off = new Set(weeklyOffDays);
  const prev = (d: number): number => ((d + 5) % 7) + 1;

  let best = 1;
  let bestLength = -1;
  for (let start = 1; start <= 7; start++) {
    // `start` must follow an off day without being one
    if (off.has(start) || !off.has(prev(start))) continue;

    let length = 0;
    for (let d = prev(start); off.has(d) && length < 7; d = prev(d)) length++;

    if (length > bestLength) {
      best = start;
      bestLength = length;
    }
  }
  return bestLength < 0 ? 1 : best;
}

export function bucketOf(
  date: Date,
  groupBy: GroupBy,
  weekStartIso: number,
): Bucket {
  if (groupBy === 'month') {
    const { first, last } = monthBoundsOf(date);
    return { key: monthKeyOf(date), start: first, end: last };
  }

  const back = (isoDayOf(date) - weekStartIso + 7) % 7;
  const start = addDays(date, -back);
  const end = addDays(start, 6);
  return { key: toIsoDate(start), start, end };
}

// ── Presentation ────────────────────────────────────────────────────────────

/**
 * Seconds → hours, two decimals, **as a number**.
 *
 * Not "7h 32m": in Excel that becomes text, and then summing or sorting the
 * column does not work, yet those are the first things people do on opening a
 * report. Building a formatted string is the frontend's job, not the report's.
 */
export function secondsToHours(sec: number): number {
  return Math.round(sec / (SEC_PER_HOUR / 100)) / 100;
}

/** A percentage, two decimals. 0 if the denominator is zero, not NaN. */
export function sharePct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10000) / 100;
}
