/**
 * All the **pure calculations** for summaries. No I/O, so they can be tested without a database.
 *
 * Why a separate file: the numbers in `daily_summary` and `monthly_summary`
 * are the system's **visible truth**: the heatmap, pace cards, "My hours" and
 * finally the payroll sheet all show numbers that come from here. Mixed into
 * DB queries, mistakes would show up only in real data, at month end.
 *
 * Source of the rules: [07-Technical-Spec section 2.1](../../../docs/07-Technical-Spec.md).
 * (The spec lettered its sub-sections in Bengali; here they are written a, b, c, d, e in order.)
 */

import { resolve, sep } from 'node:path';

import type { DayType, SegmentState } from '@prisma/client';

import { workPathParts, workDateOf } from '../agent/util/work-time';
import { isOffWeekday } from './weekly-off';

const MS_PER_DAY = 86_400_000;
const SEC_PER_HOUR = 3600;

// ============================= span union (spec 2.1-c) =========================

export interface Span {
  startedAt: Date;
  endedAt: Date;
}

/**
 * Joins overlapping spans together (spec 2.1-c).
 *
 * Careful: **a UNION, not a sum**; this is the most important distinction in
 * this file. When someone's desktop and laptop run together, both devices
 * send ACTIVE segments for the same wall-clock time; adding them would show
 * an 8-hour day as 16 and the monthly target would be "met" in half the time.
 *
 * Careful: the returned spans are **new objects**. Changing `endedAt` on the
 * input objects directly would really change Prisma rows, and a caller using
 * those rows later would silently get distorted times.
 */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans
    .filter((s) => s.endedAt.getTime() > s.startedAt.getTime())
    .slice()
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  const merged: Span[] = [];

  for (const s of sorted) {
    const last = merged[merged.length - 1];

    // `<=`: two spans exactly touching (end of one = start of the next) are
    // one continuous piece of work. Keeping them apart would lose nothing at
    // the boundary, but counts like "how many sittings" would be wrong.
    if (last && s.startedAt.getTime() <= last.endedAt.getTime()) {
      if (s.endedAt.getTime() > last.endedAt.getTime()) last.endedAt = s.endedAt;
    } else {
      merged.push({ startedAt: s.startedAt, endedAt: s.endedAt });
    }
  }

  return merged;
}

/**
 * Total length of the UNION, in seconds.
 *
 * Careful: add the milliseconds first, then round once. Rounding each span
 * separately would let half-second errors pile up to minutes over a few
 * hundred spans a day.
 */
export function unionSec(spans: readonly Span[]): number {
  const ms = mergeSpans(spans).reduce(
    (total, s) => total + (s.endedAt.getTime() - s.startedAt.getTime()),
    0,
  );
  return Math.round(ms / 1000);
}

/** All of one device's ACTIVE spans for that day. */
export interface DeviceSpans {
  deviceId: number;
  spans: readonly Span[];
}

/**
 * **G32**: how many seconds one employee's two devices ran at the same wall-clock time.
 *
 * <b>The calculation is a subtraction, but the choice of the two numbers is careful:</b>
 *
 * ```
 * overlap = sum(each device's own UNION) - (UNION across all devices)
 * ```
 *
 * Careful: **not** `active_sec - worked_sec`, although that was at hand and
 * the comment in `summarizeDay` calls it the "raw material". `active_sec`
 * comes from the agent's monotonic clock (`duration_sec`), while `worked_sec`
 * is measured with the wall clock's `started_at`-`ended_at`. Even on one
 * machine the two never match exactly: wake from sleep, clock corrections,
 * small gaps. Treating that difference as overlap would raise an alert even
 * for **an employee with a single device**, and that would be the worst kind
 * of falsehood: about someone's honesty at work.
 *
 * Here both sides use the same yardstick (wall-clock UNION), so with one
 * device the result is mathematically exactly zero.
 *
 * Careful: each device's own UNION is taken, not the raw sum. If two
 * segments of the same machine touch each other (a retry, a reopened
 * session), that would be counted as overlap between two devices.
 */
export function overlapSec(devices: readonly DeviceSpans[]): number {
  // A single device means no overlap question at all; it also saves query cost.
  if (devices.length < 2) return 0;

  const perDevice = devices.reduce((total, d) => total + unionSec(d.spans), 0);
  const together = unionSec(devices.flatMap((d) => d.spans));

  // Careful: clamp at 0. If floating-point or rounding gives something like
  // -1, that is not a "negative overlap", it is zero.
  return Math.max(0, perDevice - together);
}

// ========================= daily summary (K06) =========================

export interface DaySegment extends Span {
  state: SegmentState;
  /** From the agent's monotonic clock; unaffected if the PC's clock changes. */
  durationSec: number;
}

export interface DayInput {
  /** **All** segments of that work day: active, idle, locked, everything. */
  segments: readonly DaySegment[];
  /** Number of screenshots not yet deleted. */
  screenshotCount: number;
  /** Sum of time_adjustments.delta_sec (excluding revoked ones), spec 2.1-e. */
  adjustmentSec: number;
  /** app_usage spans in the productive category. */
  productiveSpans: readonly Span[];
  unproductiveSpans: readonly Span[];
  /** Is that date a weekly off day or a calendar holiday? */
  isOffDay: boolean;
}

export interface DayNumbers {
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
  activeSec: number;
  idleSec: number;
  workedSec: number;
  adjustmentSec: number;
  creditedSec: number;
  earliestHour: number | null;
  latestHour: number | null;
  productiveSec: number;
  unproductiveSec: number;
  productivityPct: number | null;
  screenshotCount: number;
  dayType: DayType;
}

/**
 * A person's full summary for one day: a single pure function.
 *
 * The service only fetches and writes rows; **all decisions about which
 * numbers go in are here**, so every edge can be tested without a database.
 */
export function summarizeDay(input: DayInput): DayNumbers {
  const active = input.segments.filter((s) => s.state === 'active');

  // Careful: `active_sec` is a raw sum and `worked_sec` is a UNION, and they
  // differ on purpose. Working on two devices at once makes active > worked.
  //
  // Careful: that difference is **not** the raw material for `device_overlap`
  // (this comment used to say so): `active_sec` comes from the agent's
  // monotonic clock and `worked_sec` from the wall clock, and even on one
  // machine the two never match exactly. G32's calculation is in
  // `overlapSec()`, which uses the same yardstick on both sides.
  const activeSec = sumDuration(active);

  // Careful: `locked` counts as idle too. The schema has no `locked_sec`
  // column; leaving it out would hide the "locked the PC and went to lunch"
  // time, and active + idle would no longer equal the day's total tracked time.
  const idleSec = sumDuration(
    input.segments.filter((s) => s.state === 'idle' || s.state === 'locked'),
  );

  const workedSec = unionSec(active);

  const firstActivityAt = active.length > 0 ? earliestStart(active) : null;
  const lastActivityAt = active.length > 0 ? latestEnd(active) : null;

  const productiveSec = unionSec(input.productiveSpans);
  const unproductiveSec = unionSec(input.unproductiveSpans);

  return {
    firstActivityAt,
    lastActivityAt,
    activeSec,
    idleSec,
    workedSec,
    adjustmentSec: input.adjustmentSec,

    // Careful: **not** clamped at 0 here. If the owner deducts more than the
    // time worked, the day will show negative, which is the instruction they
    // gave. The clamp is at month level; see `rollupMonth()` for why.
    creditedSec: workedSec + input.adjustmentSec,

    earliestHour: firstActivityAt === null ? null : workHourOf(firstActivityAt),
    latestHour: lastActivityAt === null ? null : workHourOf(lastActivityAt),

    productiveSec,
    unproductiveSec,
    productivityPct: productivityPct(productiveSec, unproductiveSec),
    screenshotCount: input.screenshotCount,
    dayType: dayTypeOf(workedSec, input.isOffDay),
  };
}

function sumDuration(segments: readonly DaySegment[]): number {
  return segments.reduce((total, s) => total + s.durationSec, 0);
}

function earliestStart(spans: readonly Span[]): Date {
  return spans.reduce((min, s) => (s.startedAt < min ? s.startedAt : min), spans[0].startedAt);
}

function latestEnd(spans: readonly Span[]): Date {
  return spans.reduce((max, s) => (s.endedAt > max ? s.endedAt : max), spans[0].endedAt);
}

/**
 * productive / (productive + unproductive), as a percentage.
 *
 * Careful: `neutral` is left out, deliberately. Time in Explorer, Notepad or
 * a terminal is neutral; putting it in the denominator would lower the score
 * the more work was done.
 *
 * Careful: **this number never enters salary calculation**: `worked_sec` and
 * `credited_sec` know nothing about categories. Categories are observation only.
 */
export function productivityPct(
  productiveSec: number,
  unproductiveSec: number,
): number | null {
  const total = productiveSec + unproductiveSec;
  // Careful: `null` when zero, not `0`. "No categorised app ran" and "everything
  // that ran was unproductive" are completely different statements, and the
  // second is an accusation about someone.
  if (total <= 0) return null;
  return Math.round((productiveSec / total) * 10000) / 100;
}

/**
 * Careful: `worked` is checked first. If someone works on a holiday, the
 * day is `worked`, not `holiday` (spec 2.1-b: hours on holidays count in
 * full). The other way round, that day's work would be hidden under the
 * holiday colour on the heatmap.
 */
export function dayTypeOf(workedSec: number, isOffDay: boolean): DayType {
  if (workedSec > 0) return 'worked';
  return isOffDay ? 'holiday' : 'no_activity';
}

/**
 * The work-zone hour (0-23).
 *
 * Careful: the zone's offset is not added here; the offset logic must live in one
 * place (`agent/util/work-time.ts`). It has no helper that returns the
 * hour, so the hour is cut from the `HHMMSS` of `workPathParts()`.
 */
export function workHourOf(instant: Date): number {
  return Number(workPathParts(instant).hhmmss.slice(0, 2));
}

// =============== workdays and pace: spec 2.1-b (K05/K06) ===============

/**
 * ISO weekday: Monday = 1 ... Sunday = 7.
 *
 * Careful: `getUTCDay()` cannot be used directly: there Sunday is **0**,
 * while `work_policies.weekly_off_day` follows ISO (Friday = 5). If someone
 * set Sunday (7) as the weekly off day, a direct comparison would never
 * match, the off day would silently be counted as a workday, and everyone's
 * pace would lag all month.
 *
 * Careful: the input must be a **UTC-midnight** date like `workDateOf()`
 * returns; only then is the UTC day the work day.
 */
export function isoWeekday(workDate: Date): number {
  const js = workDate.getUTCDay();
  return js === 0 ? 7 : js;
}

/** Spec 2.1-b: not a weekly off day, and not in the holidays table. */
export function isWorkday(
  workDate: Date,
  weeklyOffDays: readonly number[],
  holidays: ReadonlySet<number>,
): boolean {
  // null = every calendar day is a workday (schema rule)
  if (isOffWeekday(isoWeekday(workDate), weeklyOffDays)) {
    return false;
  }
  // Careful: Prisma `@db.Date` always gives a UTC-midnight Date, and so does
  // `workDateOf()`, so `getTime()` from both sides can be compared safely.
  return !holidays.has(workDate.getTime());
}

/** `from` and `to` are both included (spec 2.1-b: "including today"). */
export function countWorkdays(
  from: Date,
  to: Date,
  weeklyOffDays: readonly number[],
  holidays: ReadonlySet<number>,
): number {
  let count = 0;
  for (let t = from.getTime(); t <= to.getTime(); t += MS_PER_DAY) {
    if (isWorkday(new Date(t), weeklyOffDays, holidays)) count++;
  }
  return count;
}

/**
 * The work day immediately before `now`; day close (K05) closes exactly this one.
 *
 * Careful: first get the work-zone date, **then** subtract one day. The other
 * way round (subtract 24 hours first, then `workDateOf`), a job run at 00:15
 * would land on 00:15 of the previous work day. It would get the same date
 * but the result would no longer be reliable when called at other times of day.
 */
export function previousWorkDate(now: Date): Date {
  return new Date(workDateOf(now).getTime() - MS_PER_DAY);
}

export interface MonthBounds {
  start: Date;
  end: Date;
  /** '2026-08', matches `monthly_summary.year_month`. */
  yearMonth: string;
}

/** The month a work day belongs to, and that month's first and last dates. */
export function monthBounds(workDate: Date): MonthBounds {
  const year = workDate.getUTCFullYear();
  const month = workDate.getUTCMonth();

  return {
    start: new Date(Date.UTC(year, month, 1)),
    // "Day 0" of the next month = last day of this month; leap years handled automatically.
    end: new Date(Date.UTC(year, month + 1, 0)),
    yearMonth: `${year}-${String(month + 1).padStart(2, '0')}`,
  };
}

// ========== expectation window: from tracking start to yesterday ==========

/** Both ends included, same as `countWorkdays()`. */
export interface ElapsedWindow {
  from: Date;
  to: Date;
}

/**
 * **The only input to the question "how many days have elapsed" in this project.**
 *
 * Careful: this once had three separate versions: the monthly rollup, the
 * tray (`/me`) and the Live Board each counted their own way, and what an
 * employee saw on their own screen differed from what the owner saw by about
 * 89 hours. Two answers on two screens means the question of which is true
 * has no answer. Now **three paths** fill this one shape: `summary.service`,
 * `progress.service`, `reports.service`.
 *
 * Careful: `dashboard.service` is **not** in this list, and that is not a
 * mistake: the Live Board does not recount the month, it **reads**
 * `monthly_summary.expected_sec`, which is this function's own saved result.
 * Its seven-day strip does use its own `trendDayExpectation()`, which
 * **deliberately** keeps today (the strip's job is to show "what happened up
 * to today"); that difference is explained in that function's own note.
 */
export interface ElapsedWindowInput {
  /**
   * The outer bounds of the window.
   *
   * Careful: not named `monthStart`/`monthEnd`, because the monthly rollup is
   * not the only caller: reports (F01/F02) send the two ends of the requested
   * range. The rule is the same; the bounds belong to the caller.
   */
  periodStart: Date;
  periodEnd: Date;
  /** **Today's** work day (`workDateOf(now)`); itself lies outside the window. */
  today: Date;
  /** G37: `null` = has been there since before the period. */
  joinedOn: Date | null;
  leftOn: Date | null;
  /**
   * The oldest `daily_summary.work_date` of **this employee**.
   *
   * Careful: **this is not "when the agent was installed"**; it is "since
   * when the server has been computing for this employee". `refreshDate()`
   * writes a row for every **active** employee, with or without data
   * (`summary.service.ts`), so the date is normally the day they became active.
   *
   * Careful: what it covers and what it does not need to be known separately:
   * **Covers**: days before this server was installed (first install), and
   * any history the organisation has from before someone joined the system
   * (taking org-min would have started counting from July).
   * **Does not cover**: the 5 agentless days of an employee who became
   * active on 1 October and got the agent on 8 October. Their `no_activity`
   * row is written on the 1st, so this date is 1 October and those days stay
   * as a full shortfall.
   * Careful: this used to **claim the opposite**; the claim was false.
   *
   * The number is always equal to or later than org-min, so the two need not be compared.
   *
   * Careful: `null` or absent = unknown, and then this notion has **no effect
   * at all** on the window (it starts from the period start or the joining day).
   */
  trackingStartedOn?: Date | null;
}

export interface ElapsedInput extends ElapsedWindowInput {
  weeklyOffDays: readonly number[];
  holidays: ReadonlySet<number>;
}

/**
 * **The window the expectation is computed over: which days count.**
 *
 * Careful: **days before tracking started are not counted.** On this
 * installation the agent went in on 13 August 2026; we **do not know** how
 * much anyone worked before then. Counting from the 1st of the month would
 * silently turn those unseen days into "0 hours worked" and the Monthly page
 * would show everyone about 94 hours behind, for a time when the measuring
 * instrument did not exist. **Absent monitoring is not failure.**
 *
 * Careful: **today is excluded too**: the window ends at `today - 1 day`.
 * The Live Board caught exactly this mistake: counting today's full 8 hours
 * in the expectation made the team look "114 hours behind" at 6 am, and by
 * evening the number fixed itself, so the same team got two different
 * verdicts a day just because of the clock. So pace means: **where everyone
 * stands up to yesterday.**
 *
 * Both decisions are now **the same on every screen**, in two ways: the
 * monthly rollup (Monthly page and payroll pace), tray/`/me` and reports
 * **call** this function; the Live Board and daily digest **read** its saved
 * result (`monthly_summary.expected_sec`, `meta.expectedHours`). The answers
 * are therefore equal, and the definition is written in one place.
 * The one deliberate exception is the Live Board's seven-day strip
 * (`trendDayExpectation()`), which keeps today.
 * There used to be three definitions and two pages gave two numbers (Live
 * Board 42 h, Monthly 946 h). When two numbers say different things, the
 * question of which is true has no answer.
 *
 * Careful: a `null` return = the window itself is empty (the period has not
 * started, today is the 1st of the month, tracking starts today, or it is the
 * month after the person left): "0 workdays", which is no different from `0`
 * workdays, but stays explicit for the caller.
 */
export function elapsedWindow(input: ElapsedWindowInput): ElapsedWindow | null {
  // Careful: the **latest** of the three start bounds. If someone joined on
  // the 17th, their window starts from the 17th even if tracking began on the 13th.
  const from = maxDate(input.periodStart, input.joinedOn, input.trackingStartedOn ?? null);

  // Careful: the **earliest** of the three end bounds. Without `periodEnd`,
  // last month's `workdays_elapsed` would keep growing past the whole month forever.
  const to = minDate(
    new Date(input.today.getTime() - MS_PER_DAY),
    input.periodEnd,
    input.leftOn,
  );

  return from.getTime() > to.getTime() ? null : { from, to };
}

/**
 * **G111: "not yet observed" is not the same as "no shortfall".**
 *
 * Careful: someone for whom not a single **finished** workday has been
 * observed yet (today is the first day, or the agent was just installed) has
 * an expectation of 0, so a shortfall of 0 and a pace of 0. On screen that
 * looks **exactly like a person who met the target**. When two completely
 * opposite states look the same, the number answers no question any more.
 *
 * Careful: so this is a **state**, not a number. If screens looked at "0
 * shortfall" and decided for themselves, the rule would be written three
 * times in three places, this project's most familiar sin.
 *
 * The number is read from exactly where the expectation comes from
 * (`elapsedWorkdays()`), so "observed" and "has expectation" can never
 * disagree.
 *
 * Careful: **not `daysWithWork`**: that is "did they work", this is "did we
 * look". Someone who did not work an hour on an observed day **was
 * observed**, and their shortfall is a real shortfall.
 */
export function isObserved(input: { workdaysElapsed: number }): boolean {
  return input.workdaysElapsed > 0;
}

/**
 * Workdays in that window: `workdaysElapsed` of `rollupMonth()`.
 *
 * Careful: counted are **calendar workdays** (`isWorkday`), **not
 * `daily_summary` rows**. The Live Board once counted rows
 * (`day_type !== 'holiday'`) and that was silently wrong: if someone worked
 * an hour on a holiday, `dayTypeOf()` marks the day `worked`, so that holiday
 * became a full 8-hour **expectation**, a penalty for working on a holiday.
 */
export function elapsedWorkdays(
  input: ElapsedInput,
  /**
   * **The employee's own leave days**, optional.
   *
   * Careful: why it cannot be mixed into `holidays`: `holidays` belongs to
   * the organisation and D is also counted with it (`prorate`). If one
   * person's leave went in there, the denominator would change for the whole
   * team. Hence a separate argument.
   *
   * Careful: leave **must** be removed when counting expectation, otherwise
   * someone who was on leave would show as "behind" for exactly those days,
   * although the days are already removed from the target. Removing the
   * numerator but not the denominator would make the fraction itself false.
   */
  leaveDates?: ReadonlySet<number>,
): number {
  const window = elapsedWindow(input);
  if (window === null) return 0;

  const days = countWorkdays(
    window.from,
    window.to,
    input.weeklyOffDays,
    input.holidays,
  );
  const onLeave = countLeaveWorkdays(
    leaveDates,
    window.from,
    window.to,
    input.weeklyOffDays,
    input.holidays,
  );
  // Careful: never negative; zero if every day in the window is leave.
  return Math.max(0, days - onLeave);
}


/**
 * Leave days that fell on **workdays** within a window.
 *
 * Careful: filtering with `isWorkday` is this function's whole reason for
 * existing. A leave written on a Friday or public holiday, if not filtered,
 * would cut eight hours from the target although there was no target that
 * day. The failure would be silent: the number drops and nobody finds why.
 *
 * Three places call this: the target (`prorate`), the numerator of the
 * expectation (`elapsedWorkdays`) and the tray's seven-day target. Three
 * separately written loops, with one filtering and another not, would be
 * exactly this project's most familiar sin.
 */
/**
 * **How many workdays in the window we actually observed**: the owner's
 * decision: no deduction for unobserved days.
 *
 * Careful: **why `elapsedWorkdays()` is not enough:** it counts the window's
 * **calendar** workdays, so a day when neither server nor agent ran at all
 * would still be a full 8-hour expectation. In the field that was very
 * costly: tracking began on 13-15 August, yet the payroll target was the
 * whole month's 208 hours; the deduction for 12 people came to **79,788.00**,
 * of which **61,280.00** was for days the system never saw.
 *
 * "Observed" means **that day's `daily_summary` row was written**.
 * `refreshDate()` writes a row for every active employee, with or without
 * data, so the row's **existence** means "we were counting that day", and a
 * row with zero hours means "we were counting, but they did not work".
 * Careful: merging the two would also forgive absence, which is a mistake
 * in the opposite direction.
 *
 * Leave is removed here too, exactly like `elapsedWorkdays()`, otherwise the
 * numerator and denominator would be two different calculations.
 */
export function observedWorkdays(
  input: ElapsedInput,
  observedDates: ReadonlySet<number>,
  leaveDates?: ReadonlySet<number>,
): number {
  const window = elapsedWindow(input);
  if (window === null) return 0;

  let count = 0;
  for (let t = window.from.getTime(); t <= window.to.getTime(); t += MS_PER_DAY) {
    if (!observedDates.has(t)) continue;
    if (!isWorkday(new Date(t), input.weeklyOffDays, input.holidays)) continue;
    if (leaveDates?.has(t)) continue;
    count += 1;
  }
  return count;
}

export function countLeaveWorkdays(
  leaveDates: ReadonlySet<number> | undefined,
  from: Date,
  to: Date,
  weeklyOffDays: readonly number[],
  holidays: ReadonlySet<number>,
): number {
  if (!leaveDates || leaveDates.size === 0) return 0;
  if (from.getTime() > to.getTime()) return 0;

  let count = 0;
  for (const ms of leaveDates) {
    if (ms < from.getTime() || ms > to.getTime()) continue;
    if (isWorkday(new Date(ms), weeklyOffDays, holidays)) count += 1;
  }
  return count;
}

/** The three numbers for `proratedExpectedSec()`. */
export interface ExpectedInput {
  /** G37: **their own** monthly target (from `prorate()`), not the flat 208. */
  targetSec: number;
  /** G37: **their own** workdays (d). */
  expectedWorkdays: number;
  /** From `elapsedWorkdays()`; building it yourself would make the window differ again. */
  workdaysElapsed: number;
  /**
   * Their **approved leave workdays** in that month.
   *
   * Careful: this is removed **from the denominator**, not from
   * `expectedWorkdays`. `expectedWorkdays` (d) is the numerator of payroll's
   * `d / D` fraction; if leave touched it, paid leave would silently become
   * pay-cutting leave.
   *
   * Careful: the numerator (`workdaysElapsed`) also comes with leave removed
   * (the second argument of `elapsedWorkdays()`). **It must be removed on both
   * sides or on neither**: removing on one side only makes the fraction a bug,
   * not a deliberate decision.
   */
  leaveWorkdays?: number;
}

/**
 * **How many seconds are expected**: the only implementation of the spec 2.1-b formula.
 *
 * ```
 * expected_sec = target_sec × workdays_elapsed ÷ expected_workdays
 * ```
 *
 * Careful: both `rollupMonth()` (Monthly page, Live Board, payroll pace) and
 * `progress.math.ts` (tray, `/me`) go through here. The formula used to be
 * hand-written in two places; writing one formula twice means one day one of
 * them changes and the other does not.
 *
 * Careful: this **does not throw**, it returns 0. On the heartbeat path, a
 * misconfigured work policy would otherwise make every heartbeat of that
 * employee a 500, so one wrong number would be punished by tracking stopping
 * altogether. Strict validation sits separately where it is needed (`rollupMonth`).
 */
export function proratedExpectedSec(input: ExpectedInput): number {
  const { targetSec, expectedWorkdays, workdaysElapsed } = input;

  // Careful: with zero workdays we cannot divide (possible if a whole month
  // is declared a holiday). Without this guard `NaN` would go to the database
  // and the wire, and the agent's `System.Text.Json` does not understand
  // `NaN`, so the whole heartbeat reply (including the revoke command) would be unreadable.
  if (!Number.isFinite(targetSec) || targetSec <= 0) return 0;
  if (!Number.isFinite(expectedWorkdays) || expectedWorkdays <= 0) return 0;

  /**
   * The denominator is the **billable** workdays, not d.
   *
   * `targetSec` is also computed for exactly these days (`prorate()`), so the
   * quotient is "the target for one billable day", the same with or without leave.
   *
   * Careful: if every day of the month were leave the denominator would be 0;
   * then the expectation is 0 too, which is honest, since the target is 0 as well.
   */
  const billable = Math.max(0, expectedWorkdays - (input.leaveWorkdays ?? 0));
  if (billable <= 0) return 0;

  // Careful: clamp between 0 and the denominator. Called with an old date,
  // the expectation would otherwise exceed the target and everyone would show "behind".
  return Math.round((targetSec * clamp(workdaysElapsed, 0, billable)) / billable);
}

/** Careful: `null` means "this bound does not exist", so it never wins. */
function maxDate(base: Date, ...others: readonly (Date | null)[]): Date {
  return others.reduce<Date>(
    (best, d) => (d !== null && d.getTime() > best.getTime() ? d : best),
    base,
  );
}

function minDate(base: Date, ...others: readonly (Date | null)[]): Date {
  return others.reduce<Date>(
    (best, d) => (d !== null && d.getTime() < best.getTime() ? d : best),
    base,
  );
}

// ======================== monthly rollup (K05/K06) ========================

export interface MonthInput {
  /** Sum of daily worked_sec; why a plain sum is enough is in the `rollupMonth()` note. */
  workedSec: number;
  adjustmentSec: number;
  /** G37: **their workdays x daily target** (from `prorate()`), not the flat 208. */
  targetSec: number;
  /** G37: **their own** workdays (d). */
  expectedWorkdays: number;
  /** G37: total workdays in that month (D), the denominator of the salary fraction. */
  monthWorkdays: number;
  /** R2: approved leave workdays; touches neither d nor D, only lowers the target. */
  leaveWorkdays?: number;
  /**
   * How many workdays have **finished**, from `elapsedWorkdays()`.
   *
   * Careful: not "from the 1st of the month to today": days before tracking
   * started and today itself are outside it (because of `elapsedWindow()`).
   * Building the number yourself would make the Monthly page disagree with the Live Board again.
   */
  workdaysElapsed: number;
  /**
   * How many workdays had their row really written; the salary shortfall is
   * measured against this.
   */
  observedWorkdays: number;
  /** Days on which worked_sec > 0. */
  daysWithWork: number;
  /** the policy has no hours target (basis 'none'): target 0 is expected, pace stays 0 */
  noTarget?: boolean;
}

export interface MonthNumbers {
  workedSec: number;
  adjustmentSec: number;
  creditedSec: number;
  targetSec: number;
  expectedSec: number;
  paceSec: number;
  expectedWorkdays: number;
  monthWorkdays: number;
  leaveWorkdays: number;
  workdaysElapsed: number;
  /**
   * **How many workdays we actually observed.**
   *
   * Careful: the difference from `workdaysElapsed` is the whole point: that
   * one counts **calendar** days, this one counts days whose `daily_summary`
   * row was really written. The salary shortfall is now measured against
   * **this**, otherwise days the system was down would count as the
   * employee's shortfall.
   */
  observedWorkdays: number;
  daysWithWork: number;
  avgDailySec: number;
  overtimeSec: number;
  shortfallSec: number;
  targetMet: boolean;
}

/**
 * All of the month's numbers (spec 2.1-b, 2.1-e, 3.2.1).
 *
 * **Monthly worked = the plain sum of daily worked**; no second UNION is
 * needed. By spec 2.1-a no segment can span two `work_date`s, so segments of
 * two different days never overlap. That one guarantee is what avoids
 * running a merge over about a hundred thousand rows a month every 15 minutes.
 *
 * Careful: pace uses `credited`, not `worked`. The pseudocode in 3.2.1 says
 * `worked_sec - expected_sec`, but 2.1-b and 2.1-e (G35, added later) say
 * `credited_sec` is what matches the target. Using `worked`, an employee who
 * lost hours through a server fault would show "behind" all month even after
 * the owner's correction, defeating the whole purpose of the correction.
 */
export function rollupMonth(input: MonthInput): MonthNumbers {
  const {
    workedSec,
    adjustmentSec,
    targetSec,
    expectedWorkdays,
    monthWorkdays,
    leaveWorkdays = 0,
    workdaysElapsed,
    observedWorkdays,
    daysWithWork,
  } = input;

  /**
   * Careful: **a target of 0 is valid now, but for one reason only** (G37):
   * they have no workdays at all that month (joined after the month, left
   * before it, or the whole month is a holiday). Then a shortfall is impossible.
   *
   * Careful: a target of 0 **while workdays exist** means a wrongly set
   * policy, and accepting it would show someone as "target met" without
   * working a single hour. `payroll.math.ts` has exactly the same condition.
   */
  if (!Number.isFinite(targetSec) || targetSec < 0) {
    throw new RangeError('Monthly target cannot be negative');
  }
  /**
   * Careful: the condition uses **billable** days, not d. In R2 this was a
   * real crash. If someone is on leave for the whole month, `targetSec` is
   * correctly 0 (leave lowers the target) while `expectedWorkdays` (d) is
   * intact (leave is paid), so both conditions were true and the monthly
   * rollup itself fell into a `RangeError`, stopping the monthly rows being
   * written for **the whole team, not just that one person**.
   *
   * What it was here to catch (a policy with workdays but target 0) is still
   * caught: after removing leave, if days remain the target cannot be 0.
   */
  const billableWorkdays = Math.max(0, expectedWorkdays - leaveWorkdays);
  // a policy with no target (work-regime.ts, basis 'none') is the one
  // legitimate zero: hours are recorded, nobody is ahead or behind
  if (targetSec === 0 && billableWorkdays > 0 && !input.noTarget) {
    throw new RangeError('Monthly target cannot be zero when there are workdays');
  }

  /**
   * Careful: clamping at 0 here is **mandatory**. `payroll.math.ts` throws a
   * `RangeError` on negative `creditedSec`, and that is inside the payroll
   * sheet's loop; one person's one extra deduction would turn the whole
   * month's payroll request into a 500, with the error appearing somewhere
   * entirely different.
   */
  const creditedSec = Math.max(0, workedSec + adjustmentSec);

  // The formula is no longer written here but in `proratedExpectedSec()`,
  // because the tray calls exactly the same one. Written twice, one day one
  // would change and not the other.
  const expectedSec = proratedExpectedSec({
    leaveWorkdays,
    targetSec,
    expectedWorkdays,
    workdaysElapsed,
  });

  return {
    workedSec,
    adjustmentSec,
    creditedSec,
    targetSec,
    expectedSec,
    paceSec: input.noTarget ? 0 : creditedSec - expectedSec,
    expectedWorkdays,
    monthWorkdays,
    leaveWorkdays,
    workdaysElapsed,
    observedWorkdays,
    daysWithWork,
    // Careful: division by zero; if someone never worked a day all month, this would be Infinity.
    avgDailySec: daysWithWork > 0 ? Math.round(workedSec / daysWithWork) : 0,
    overtimeSec: input.noTarget ? 0 : Math.max(0, creditedSec - targetSec),
    shortfallSec: input.noTarget ? 0 : Math.max(0, targetSec - creditedSec),
    /**
     * Careful: with a target of 0, `creditedSec >= 0` is always true, so
     * someone who was not even there that month would show "target met" and
     * `target_met_at` would get a timestamp. Nothing happened there that
     * deserves to be claimed as an achievement.
     */
    targetMet: targetSec > 0 && creditedSec >= targetSec,
  };
}

/** Hours -> seconds (from the work policy's `Decimal` to `target_sec`). */
export function hoursToSec(hours: number): number {
  return Math.round(hours * SEC_PER_HOUR);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// =========================== retention (K01) ===========================

/**
 * Screenshots with a `work_date` **before** this are eligible for deletion.
 *
 * `days` is validated because it is the most destructive number in this
 * whole module. If `0` or a negative value arrived by mistake, the cutoff
 * would land on today or the future, and the 2 am job would silently delete
 * **the whole archive including today's photos**, files and rows both, with
 * no backup. So stop whenever in doubt.
 *
 * Careful: the comparison is `<` (not `<=`): a photo exactly 90 days old
 * **stays**; only older ones are cut. Keeping one day extra is the safe side of a mistake.
 */
export function retentionCutoff(now: Date, days: number): Date {
  if (!Number.isFinite(days) || days < 1) {
    throw new RangeError(
      `Retention days must be at least 1, got ${String(days)}`,
    );
  }
  return new Date(workDateOf(now).getTime() - Math.floor(days) * MS_PER_DAY);
}

/**
 * Is the file really inside the storage root?
 *
 * A path check in a "pure calculations" file may look odd, but this is the
 * module's third pure decision, and the only one where a mistake **can
 * delete files outside storage**. `screenshots.file_path` is a database
 * column; today the server builds it itself, but if a `..` slipped in, the
 * retention job would `unlink` any file on the D:\ drive. So check before deleting.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const absRoot = resolve(root);
  const absPath = resolve(root, candidate);
  return absPath === absRoot || absPath.startsWith(absRoot + sep);
}
