import type { MatchType, Productivity } from '@prisma/client';

import { MAX_REGEX_LENGTH } from './category-matcher';

/**
 * All the calculations for D07-D09: score, percentages, sorting, folding. Pure
 * functions with no I/O.
 *
 * It is in its own file for the same reason as
 * [payroll.math.ts](../payroll/payroll.math.ts): if any decision here were wrong,
 * **no error would appear anywhere**; some person's name would just carry a wrong
 * percentage. Mixed with the DB, these could not be tested in isolation.
 *
 * Careful: **categories never enter pay calculations.** No number in this file
 * goes anywhere near `payroll` or `credited_sec`. Someone who is "unproductive"
 * all day still keeps their hours ([09 § 4](../../../../docs/09-Build-Log.md)).
 */

/** D08 "top 10": the default, but the endpoint can change it. */
export const TOP_N = 10;

/** The longest date range per request; otherwise one typo would scan the whole table. */
export const MAX_RANGE_DAYS = 366;

const HOUR = 3600;

// ── Buckets and score (D07) ──────────────────────────────────────────────────

/**
 * The four buckets of seconds.
 *
 * **`unknownSec` is its own bucket, not part of `neutralSec`.** `categoryId = null`
 * means "we do not know", while neutral means "we know, and it is neutral". Merging
 * them would let every unknown app silently inflate the score's denominator: the
 * more unknown, the lower the score, with the reason visible nowhere.
 */
export interface SecondBuckets {
  productiveSec: number;
  neutralSec: number;
  unproductiveSec: number;
  /** No match found: "we do not know". It enters no denominator. */
  unknownSec: number;
}

export interface ProductivityScore extends SecondBuckets {
  /** productive + neutral + unproductive: this is the score's **denominator**. */
  categorizedSec: number;
  /** categorized + unknown */
  totalSec: number;
  /**
   * productive / categorized x 100.
   *
   * Careful: **`null` for a zero denominator, not zero.** 0% would say "this person
   * did nothing productive", whereas the truth is "there is no information to
   * report". On a day off or a day the agent was off, the difference changes the
   * meaning of the whole report.
   */
  scorePct: number | null;
  /**
   * What percentage of the total time is unknown.
   *
   * This **always** goes next to the score. If 90% of the time is unknown, even a
   * 100% score means nothing, but looking at the score alone it would look great.
   *
   * Careful: the threshold "at what percent unknown is the score no longer
   * trustworthy" is **not** assumed here. That is a business decision nobody has
   * made; putting in a number ourselves would silently become policy (like the OT
   * rule in payroll). The two numbers are given side by side, for whoever is making
   * the decision.
   */
  unknownPct: number;
}

export function emptyBuckets(): SecondBuckets {
  return { productiveSec: 0, neutralSec: 0, unproductiveSec: 0, unknownSec: 0 };
}

/**
 * Careful: negative time is not silently accepted. `duration_sec` is `@Min(0)` in
 * the DTO, so it should not happen, but if it did the score would exceed 100% or
 * go negative, and nobody could ever trace where the number came from.
 */
export function addSeconds(
  into: SecondBuckets,
  category: Productivity | null,
  seconds: number,
): void {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError('Time cannot be negative or undefined');
  }

  switch (category) {
    case 'productive':
      into.productiveSec += seconds;
      break;
    case 'neutral':
      into.neutralSec += seconds;
      break;
    case 'unproductive':
      into.unproductiveSec += seconds;
      break;
    default:
      // null: no match found
      into.unknownSec += seconds;
      break;
  }
}

export function mergeBuckets(into: SecondBuckets, from: SecondBuckets): void {
  into.productiveSec += from.productiveSec;
  into.neutralSec += from.neutralSec;
  into.unproductiveSec += from.unproductiveSec;
  into.unknownSec += from.unknownSec;
}

export function scoreOf(buckets: SecondBuckets): ProductivityScore {
  const categorizedSec =
    buckets.productiveSec + buckets.neutralSec + buckets.unproductiveSec;
  const totalSec = categorizedSec + buckets.unknownSec;

  return {
    ...buckets,
    categorizedSec,
    totalSec,
    scorePct:
      categorizedSec === 0
        ? null
        : round2((buckets.productiveSec * 100) / categorizedSec),
    // When the total is zero we say "0% unknown", because the unknown time really
    // is zero. The neighbouring `scorePct = null` prevents confusion by saying there is no data.
    unknownPct:
      totalSec === 0 ? 0 : round2((buckets.unknownSec * 100) / totalSec),
  };
}

// ── Category identity ────────────────────────────────────────────────────────

/** The part of `app_categories` needed to build reports. */
export interface CategoryMeta {
  displayName: string;
  category: Productivity;
  matchType: MatchType;
}

/**
 * Careful: `null` if the id is not in the map, i.e. "unknown", not a crash. The
 * foreign key means it should not happen, but it can between a rule being deleted
 * and the map being read, and then there is no reason for the whole report to
 * return 500.
 */
function categoryOf(
  meta: ReadonlyMap<number, CategoryMeta>,
  categoryId: number | null,
): Productivity | null {
  if (categoryId === null) return null;
  return meta.get(categoryId)?.category ?? null;
}

// ── Daily score (D07) ────────────────────────────────────────────────────────

/** One row of `groupBy(['employeeId','workDate','categoryId'])`. */
export interface DailyGroup {
  employeeId: number;
  /** `@db.Date`: the work-zone date, stored as a UTC midnight. */
  workDate: Date;
  categoryId: number | null;
  seconds: number;
}

export interface DailyScore extends ProductivityScore {
  /** YYYY-MM-DD */
  workDate: string;
}

export interface EmployeeDays {
  days: DailyScore[];
  total: ProductivityScore;
}

/**
 * Employee -> day -> score.
 *
 * Careful: days with no rows at all **are absent**; no row with a zero score is
 * made. "Did nothing that day" is not the same as "the agent did not run / it was a
 * day off", and app_usage gives no way to tell them apart. Whether an empty day is
 * leave or absence is the job of `day_type` in `daily_summary`.
 */
export function foldDailyScores(
  groups: readonly DailyGroup[],
  meta: ReadonlyMap<number, CategoryMeta>,
): Map<number, EmployeeDays> {
  const byEmployee = new Map<number, Map<string, SecondBuckets>>();

  for (const g of groups) {
    let days = byEmployee.get(g.employeeId);
    if (!days) {
      days = new Map<string, SecondBuckets>();
      byEmployee.set(g.employeeId, days);
    }

    const key = toDateKey(g.workDate);
    let bucket = days.get(key);
    if (!bucket) {
      bucket = emptyBuckets();
      days.set(key, bucket);
    }

    addSeconds(bucket, categoryOf(meta, g.categoryId), g.seconds);
  }

  const out = new Map<number, EmployeeDays>();

  for (const [employeeId, days] of byEmployee) {
    const total = emptyBuckets();
    const rows: DailyScore[] = [];

    // Sorted by date: in YYYY-MM-DD, lexicographic order is chronological order
    for (const key of [...days.keys()].sort()) {
      const bucket = days.get(key)!;
      mergeBuckets(total, bucket);
      rows.push({ workDate: key, ...scoreOf(bucket) });
    }

    out.set(employeeId, { days: rows, total: scoreOf(total) });
  }

  return out;
}

// ── Top apps and sites (D08) ─────────────────────────────────────────────────

/** One row of `groupBy(['processName'|'domain', 'categoryId'])`. */
export interface UsageGroup {
  /** The raw `process_name` or `domain`, as the agent sent it. */
  key: string;
  categoryId: number | null;
  seconds: number;
  records: number;
}

export interface UsageTally {
  /** The normalised key (lower case, without `www.` for sites). */
  key: string;
  /** The display name: the rule's `display_name` when sure, otherwise the key itself. */
  label: string;
  seconds: number;
  hours: string;
  /** How many `app_usage` rows matched it. */
  records: number;
  buckets: SecondBuckets;
  /**
   * The bucket with the most seconds; `null` if nothing is known.
   * When `mixed` is true this is only a hint, not a single truth.
   */
  category: Productivity | null;
  /**
   * Careful: whether more than one **known** category is mixed in.
   *
   * The category of `chrome.exe`'s rows comes from the **domain**: youtube.com
   * (unproductive) and github.com (productive) are both in the same process. So
   * giving `chrome.exe` a single category in the app list would be a lie.
   */
  mixed: boolean;
  /** What percentage of the total time of **all** keys (not of the top 10's sum; see below). */
  sharePct: number;
}

export interface UsageReport {
  rows: UsageTally[];
  /** The total across **all** keys in the range, not the top 10's sum. */
  totalSec: number;
  /** How many distinct apps/sites there were. */
  distinctKeys: number;
  /**
   * The time that fell outside the top list.
   *
   * Without it, the "top 10" looks like everything, yet the tail of 300 sites can
   * hold half the day's time. With this number visible, at least we know how much is
   * not being seen.
   */
  otherSec: number;
}

interface Accumulator {
  seconds: number;
  records: number;
  buckets: SecondBuckets;
  /** categoryId -> seconds; needed to choose the label. */
  byCategoryId: Map<number, number>;
}

/**
 * Normalise a process name.
 *
 * Careful: a Windows process name can arrive as `Chrome.exe` or `chrome.exe`.
 * Without lower-casing, one app would become two or three rows, wasting places in
 * the top 10, each showing a fraction of the real time.
 * ([category-matcher.ts](./category-matcher.ts) does the same when matching.)
 */
export function normalizeProcess(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Normalise a domain: lower case, trailing dot trimmed, and `www.` dropped.
 *
 * The agent (`DomainParser`) already lower-cases but keeps `www.`, which is right:
 * that is not the place to throw information away. But in the report, if
 * `www.youtube.com` and `youtube.com` were two rows, the top 10 would break.
 *
 * Careful: `www.` is trimmed **only when** the rest still contains a dot; otherwise
 * `www.com` (a real domain) would become `com`.
 *
 * This is **display-only** normalisation. It does not change category matching,
 * which already matches on label boundaries, so `www.youtube.com` and `youtube.com`
 * fall under the same rule.
 */
export function normalizeDomain(domain: string): string {
  const value = domain.trim().toLowerCase().replace(/\.+$/, '');
  if (value.startsWith('www.')) {
    const rest = value.slice(4);
    if (rest.includes('.')) return rest;
  }
  return value;
}

/** More seconds first; on a tie, alphabetical by key. */
function bySecondsDesc(a: { seconds: number; key: string }, b: { seconds: number; key: string }): number {
  return b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * D08 - the list of apps or sites.
 *
 * Careful: **`kind` is more than a label.** In the app list, `chrome.exe`'s category
 * can come from a **domain** rule; if the rule's `display_name` ("YouTube") were
 * used as the app's name, the list would say "YouTube - 3 hours" although that is
 * really the browser's total time. So the rule's name is used as the label **only
 * when** the rule's `match_type` matches the list's kind, and all that key's
 * seconds belong to a single rule.
 */
export function foldUsage(
  groups: readonly UsageGroup[],
  meta: ReadonlyMap<number, CategoryMeta>,
  kind: 'app' | 'site',
  limit: number = TOP_N,
): UsageReport {
  const wanted: MatchType = kind === 'app' ? 'process' : 'domain';
  const normalize = kind === 'app' ? normalizeProcess : normalizeDomain;

  const acc = new Map<string, Accumulator>();
  let totalSec = 0;

  for (const g of groups) {
    const key = normalize(g.key);
    if (key.length === 0) continue;

    let entry = acc.get(key);
    if (!entry) {
      entry = {
        seconds: 0,
        records: 0,
        buckets: emptyBuckets(),
        byCategoryId: new Map<number, number>(),
      };
      acc.set(key, entry);
    }

    addSeconds(entry.buckets, categoryOf(meta, g.categoryId), g.seconds);
    entry.seconds += g.seconds;
    entry.records += g.records;
    totalSec += g.seconds;

    if (g.categoryId !== null) {
      entry.byCategoryId.set(
        g.categoryId,
        (entry.byCategoryId.get(g.categoryId) ?? 0) + g.seconds,
      );
    }
  }

  const sorted = [...acc.entries()]
    .map(([key, entry]) => ({ key, entry, seconds: entry.seconds }))
    .sort(bySecondsDesc);

  const rows: UsageTally[] = [];
  let shown = 0;

  for (const { key, entry } of sorted.slice(0, Math.max(0, limit))) {
    shown += entry.seconds;

    const only =
      entry.byCategoryId.size === 1
        ? meta.get([...entry.byCategoryId.keys()][0])
        : undefined;

    rows.push({
      key,
      label: only && only.matchType === wanted ? only.displayName : key,
      seconds: entry.seconds,
      hours: toHours(entry.seconds),
      records: entry.records,
      buckets: entry.buckets,
      category: dominant(entry.buckets),
      mixed: knownKinds(entry.buckets) > 1,
      // Careful: the denominator is the **total** time, not the sum of the 10 shown.
      //    Otherwise the percentages would always add up to 100 and the tail would vanish.
      sharePct: totalSec === 0 ? 0 : round2((entry.seconds * 100) / totalSec),
    });
  }

  return {
    rows,
    totalSec,
    distinctKeys: acc.size,
    otherSec: totalSec - shown,
  };
}

/**
 * The largest **known** bucket; `null` if all known buckets are zero.
 *
 * The order is fixed (productive -> neutral -> unproductive) so even an exact tie
 * gives the same result every time; if opening the same report twice showed two
 * different things, nobody would trust the number. A tie is nearly impossible, and
 * if it happens the `mixed` flag is true anyway.
 */
function dominant(buckets: SecondBuckets): Productivity | null {
  const order: Array<[Productivity, number]> = [
    ['productive', buckets.productiveSec],
    ['neutral', buckets.neutralSec],
    ['unproductive', buckets.unproductiveSec],
  ];

  let best: Productivity | null = null;
  let bestSec = 0;

  for (const [name, sec] of order) {
    if (sec > bestSec) {
      best = name;
      bestSec = sec;
    }
  }

  return best;
}

function knownKinds(buckets: SecondBuckets): number {
  return (
    (buckets.productiveSec > 0 ? 1 : 0) +
    (buckets.neutralSec > 0 ? 1 : 0) +
    (buckets.unproductiveSec > 0 ? 1 : 0)
  );
}

// ── Per-team site summary (D09) ──────────────────────────────────────────────

/** One row of `groupBy(['domain','employeeId','categoryId'])`. */
export interface TeamGroup {
  domain: string;
  employeeId: number;
  categoryId: number | null;
  seconds: number;
}

export interface TeamSiteRow {
  domain: string;
  label: string;
  category: Productivity | null;
  mixed: boolean;
  totalSec: number;
  hours: string;
  /** How many employees spent time on that site. */
  employees: number;
  /**
   * The employee who spent the most time, and their seconds.
   *
   * Without it D09 is dangerous: one person's 6 hours would show as "the team's 6
   * hours", and the owner would think it was the whole team's habit. Seeing
   * `employees = 1` exposes it.
   */
  topEmployeeId: number | null;
  topEmployeeSec: number;
  sharePct: number;
}

export interface TeamSiteReport {
  rows: TeamSiteRow[];
  totalSec: number;
  distinctDomains: number;
  otherSec: number;
}

export function foldTeamSites(
  groups: readonly TeamGroup[],
  meta: ReadonlyMap<number, CategoryMeta>,
  limit: number = TOP_N,
): TeamSiteReport {
  interface TeamAcc extends Accumulator {
    byEmployee: Map<number, number>;
  }

  const acc = new Map<string, TeamAcc>();
  let totalSec = 0;

  for (const g of groups) {
    const key = normalizeDomain(g.domain);
    if (key.length === 0) continue;

    let entry = acc.get(key);
    if (!entry) {
      entry = {
        seconds: 0,
        records: 0,
        buckets: emptyBuckets(),
        byCategoryId: new Map<number, number>(),
        byEmployee: new Map<number, number>(),
      };
      acc.set(key, entry);
    }

    addSeconds(entry.buckets, categoryOf(meta, g.categoryId), g.seconds);
    entry.seconds += g.seconds;
    totalSec += g.seconds;
    entry.byEmployee.set(
      g.employeeId,
      (entry.byEmployee.get(g.employeeId) ?? 0) + g.seconds,
    );

    if (g.categoryId !== null) {
      entry.byCategoryId.set(
        g.categoryId,
        (entry.byCategoryId.get(g.categoryId) ?? 0) + g.seconds,
      );
    }
  }

  const sorted = [...acc.entries()]
    .map(([key, entry]) => ({ key, entry, seconds: entry.seconds }))
    .sort(bySecondsDesc);

  const rows: TeamSiteRow[] = [];
  let shown = 0;

  for (const { key, entry } of sorted.slice(0, Math.max(0, limit))) {
    shown += entry.seconds;

    let topEmployeeId: number | null = null;
    let topEmployeeSec = 0;
    // The smaller employeeId is looked at first, so a tie in time still gives a stable result.
    for (const employeeId of [...entry.byEmployee.keys()].sort((a, b) => a - b)) {
      const sec = entry.byEmployee.get(employeeId)!;
      if (sec > topEmployeeSec) {
        topEmployeeId = employeeId;
        topEmployeeSec = sec;
      }
    }

    const only =
      entry.byCategoryId.size === 1
        ? meta.get([...entry.byCategoryId.keys()][0])
        : undefined;

    rows.push({
      domain: key,
      label: only && only.matchType === 'domain' ? only.displayName : key,
      category: dominant(entry.buckets),
      mixed: knownKinds(entry.buckets) > 1,
      totalSec: entry.seconds,
      hours: toHours(entry.seconds),
      employees: entry.byEmployee.size,
      topEmployeeId,
      topEmployeeSec,
      sharePct: totalSec === 0 ? 0 : round2((entry.seconds * 100) / totalSec),
    });
  }

  return {
    rows,
    totalSec,
    distinctDomains: acc.size,
    otherSec: totalSec - shown,
  };
}

// ── Rule pattern validation (D06) ────────────────────────────────────────────

/**
 * Whether the pattern the owner wrote has a problem: a message if so, otherwise `null`.
 *
 * Careful: **this must be caught at write time.** `compile()` **silently drops** a
 * bad pattern (to stop ingest from breaking, and that is right). So without
 * validation the owner would add a rule, see it in the list, and it would **never do
 * anything**: no error anywhere, only one line in the service log.
 *
 * It stays here as a pure function because the limit (`MAX_REGEX_LENGTH`) must stay
 * **the same** as the matcher's; with two numbers in two places, one day one would
 * change, and then even a rule that passed validation would be dropped silently.
 */
export function patternProblem(
  matchType: MatchType,
  pattern: string,
): string | null {
  const value = pattern.trim();

  if (value.length === 0) {
    return 'The pattern cannot be empty';
  }

  switch (matchType) {
    case 'process':
      // A full path never matches; `app_usage` stores only the file name.
      if (value.includes('\\') || value.includes('/')) {
        return 'Give only the file name in a process pattern, not the full path (for example code.exe)';
      }
      if (value.includes(' ') && !value.toLowerCase().endsWith('.exe')) {
        return 'A process name must look like a file name (for example code.exe)';
      }
      return null;

    case 'domain':
      // Careful: a full URL is never stored (ADR-013), so a pattern containing '/'
      //    would never match, and the owner would think the rule was working
      if (value.includes('://') || value.includes('/')) {
        return 'Give the domain only, not the full URL (for example youtube.com)';
      }
      if (value.includes(' ')) {
        return 'A domain cannot contain spaces';
      }
      if (!value.includes('.') && value !== 'localhost') {
        return 'A domain must contain at least one dot (for example youtube.com)';
      }
      return null;

    case 'title_regex':
      if (pattern.length > MAX_REGEX_LENGTH) {
        return `A regex cannot be longer than ${MAX_REGEX_LENGTH} characters — a long regex can lock up the whole server`;
      }
      try {
        new RegExp(pattern, 'i');
      } catch {
        return 'The regex is not valid — JavaScript cannot compile it';
      }
      return null;
  }
}

// ── Date range ───────────────────────────────────────────────────────────────

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface WorkDateRange {
  from: Date;
  to: Date;
  /** How many days, counting both ends. */
  days: number;
}

/**
 * `work_date` (`@db.Date`) -> `YYYY-MM-DD`.
 *
 * Careful: **no timezone conversion.** The column is already the work-zone date, stored
 * as a UTC midnight (that is exactly what `workDateOf` in
 * [work-time.ts](../agent/util/work-time.ts) sets). Adding the zone's offset again here, or
 * using `toLocaleDateString`, would shift every date by a day depending on the
 * server's timezone, and that would show up only on some machines.
 */
export function toDateKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * `YYYY-MM-DD` -> that date's UTC midnight (comparable with `@db.Date`).
 *
 * Careful: like `new Date('2026-02-31')`, `Date.UTC(2026, 1, 31)` silently rolls over
 * to 3 March. So the result is checked by converting back; otherwise a report for
 * a wrong date would come back successfully.
 */
export function parseWorkDate(text: string): Date {
  if (!DATE_PATTERN.test(text)) {
    throw new RangeError(`Date must be in YYYY-MM-DD format — got "${text}"`);
  }

  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (toDateKey(date) !== text) {
    throw new RangeError(`"${text}" is not a real date`);
  }

  return date;
}

/**
 * Resolve the range. If nothing is given, **the 1st of the current month -> today**.
 *
 * `today` comes in as a parameter (from `workDateOf(new Date())`) so the function
 * stays pure and tests need not depend on the clock; clock-dependent tests break
 * every day after midnight ([09 § 3a.11](../../../../docs/09-Build-Log.md)).
 *
 * Careful: it throws `RangeError` on bad input, not `BadRequestException`; a pure
 * function knows nothing about HTTP (same as
 * [payroll.math.ts](../payroll/payroll.math.ts)). The service turns it into a 400.
 */
export function resolveRange(
  from: string | undefined,
  to: string | undefined,
  today: Date,
  maxDays: number = MAX_RANGE_DAYS,
): WorkDateRange {
  const end = to === undefined || to === '' ? today : parseWorkDate(to);
  const start =
    from === undefined || from === ''
      ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
      : parseWorkDate(from);

  if (start.getTime() > end.getTime()) {
    throw new RangeError('`from` can never be after `to`');
  }

  const days =
    Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;

  if (days > maxDays) {
    throw new RangeError(
      `The range can be at most ${maxDays} days — ${days} days were requested`,
    );
  }

  return { from: start, to: end, days };
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** Percentage to two decimals; otherwise JSON would carry 33.33333333333333. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Seconds -> hours for display (two decimals). */
export function toHours(seconds: number): string {
  return (seconds / HOUR).toFixed(2);
}
