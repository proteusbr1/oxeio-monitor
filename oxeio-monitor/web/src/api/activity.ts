import { api } from './client';
import { qs } from './query';

/**
 * D06–D09 — category rules, the daily productivity score, top apps/sites,
 * the team-wide site summary.
 *
 * Server source: `server/src/activity/` (activity.controller.ts ·
 * activity.service.ts · activity.math.ts · category.controller.ts).
 *
 * Careful: `/activity/*` is owner + manager. `/categories/*` is **owner-only**
 *    (changing a rule changes everyone's report numbers).
 *
 * **No number here feeds into pay.** Someone who is "unproductive" all day
 *    keeps all their hours (docs/09 section 4).
 */

export type Productivity = 'productive' | 'neutral' | 'unproductive';
export type MatchType = 'process' | 'domain' | 'title_regex';

/**
 * Four buckets of seconds.
 *
 * `unknownSec` is its own bucket, not part of `neutralSec`. "Unknown" and
 * "known, and neutral" are different — merging them would silently inflate the
 * score's denominator with every unrecognised app.
 */
export interface SecondBuckets {
  productiveSec: number;
  neutralSec: number;
  unproductiveSec: number;
  unknownSec: number;
}

export interface ProductivityScore extends SecondBuckets {
  /** productive + neutral + unproductive — the score's **denominator** */
  categorizedSec: number;
  /** categorized + unknown */
  totalSec: number;
  /**
   * **`null` when the denominator is zero, not zero.** Writing `0%` would
   * mean "was not productive at all", while the truth is "there is no data to
   * speak of". `formatPct()` handles this — do not write `?? 0` yourself.
   */
  scorePct: number | null;
  /**
   * What percentage of total time is unrecognised. Always show it **next to
   * the score** — if 90% of the time is unknown, even a 100% score means nothing.
   */
  unknownPct: number;
}

export interface DailyScore extends ProductivityScore {
  /** `YYYY-MM-DD` */
  workDate: string;
}

export interface EmployeeProductivity {
  employeeId: number;
  empCode: string;
  fullName: string;
  /**
   * Days with no rows at all are **left out of the list** — no zero rows are
   *    created. From here you cannot tell whether a gap is leave or absence.
   */
  days: DailyScore[];
  total: ProductivityScore;
}

/**
 * D07. `ProductivityReport` (F04) in `reports.ts` is a **different thing**:
 * that is the printed app/site-based report; this is the day-by-day score.
 */
export interface DailyProductivityReport {
  from: string;
  to: string;
  /** People with no rows at all are included too — otherwise "agent off" and "all fine" would look alike */
  employees: EmployeeProductivity[];
  /** See OVERLAP_CAVEAT below — the page must show it */
  caveat: string;
}

export interface UsageTally {
  /** The normalised key (lower case; for sites without `www.`) */
  key: string;
  /** Display name — the rule's name when it is certain, otherwise the key itself */
  label: string;
  seconds: number;
  /** Hours with two decimals, as a string — show it with `formatHoursAsDuration()` */
  hours: string;
  records: number;
  buckets: SecondBuckets;
  /** The largest **known** bucket; `null` when nothing is known */
  category: Productivity | null;
  /**
   * Several known categories are mixed together. `chrome.exe` contains both
   * youtube and github — showing a single category would then be false.
   */
  mixed: boolean;
  /** Share of the total time of **all** keys (not of the top-10 sum) */
  sharePct: number;
}

export interface UsageReport {
  rows: UsageTally[];
  /** Total over **all** keys in the range */
  totalSec: number;
  distinctKeys: number;
  /** Time that fell outside the top list — without showing it, "top 10" would look like everything */
  otherSec: number;
}

export interface TopReport {
  from: string;
  to: string;
  employeeId: number | null;
  apps: UsageReport;
  sites: UsageReport;
  /** App time and site time **cannot be added** — two different cuts of the same time */
  caveat: string;
}

export interface TeamSiteRow {
  domain: string;
  label: string;
  category: Productivity | null;
  mixed: boolean;
  totalSec: number;
  hours: string;
  /** How many employees — if `employees === 1`, this is one person's habit, not the team's */
  employees: number;
  topEmployeeId: number | null;
  topEmployeeSec: number;
  sharePct: number;
}

export interface TeamReport {
  rows: TeamSiteRow[];
  totalSec: number;
  distinctDomains: number;
  otherSec: number;
  from: string;
  to: string;
  employeesWithData: number;
  caveat: string;
}

export interface RangeQuery {
  /** Defaults to the 1st of the current month */
  from?: string;
  /** Defaults to today's date in the work zone */
  to?: string;
}

/**
 * D07 — `GET /api/v1/activity/productivity?employeeId=&from=&to=`
 *
 * Without `employeeId`, all active employees.
 */
export function getDailyProductivity(
  query: RangeQuery & { employeeId?: number } = {},
  signal?: AbortSignal,
): Promise<DailyProductivityReport> {
  return api<DailyProductivityReport>(`/activity/productivity${qs({ ...query })}`, {
    signal,
  });
}

/**
 * D08 — `GET /api/v1/activity/top?employeeId=&from=&to=&limit=`
 * Careful: `limit` is at most 50, default 10.
 */
export function getTopUsage(
  query: RangeQuery & { employeeId?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<TopReport> {
  return api<TopReport>(`/activity/top${qs({ ...query })}`, { signal });
}


// ── D06 · Category rules (owner-only) ────────────────────────────────────────

export interface CategoryRuleView {
  id: number;
  matchType: MatchType;
  pattern: string;
  displayName: string;
  category: Productivity;
  /** **The smaller number wins** — the browser's rule is 200, the rest 100 */
  priority: number;
}

export interface CategoryDeleteResult {
  deleted: CategoryRuleView;
  /** How many rows became "unknown" because of this delete — the screen should show it */
  orphanedRows: number;
  hint: string;
}

export function listCategories(
  signal?: AbortSignal,
): Promise<CategoryRuleView[]> {
  return api<CategoryRuleView[]>('/categories', { signal });
}

export interface CreateCategoryBody {
  matchType: MatchType;
  /** `code.exe` · `youtube.com` · regex. A full URL in a domain gives a 400 */
  pattern: string;
  displayName: string;
  category: Productivity;
  priority?: number;
}

export function createCategory(
  body: CreateCategoryBody,
): Promise<CategoryRuleView> {
  return api<CategoryRuleView>('/categories', { method: 'POST', body });
}

export function updateCategory(
  id: number,
  body: Partial<CreateCategoryBody>,
): Promise<CategoryRuleView> {
  return api<CategoryRuleView>(`/categories/${id}`, { method: 'PATCH', body });
}

export function deleteCategory(id: number): Promise<CategoryDeleteResult> {
  return api<CategoryDeleteResult>(`/categories/${id}`, { method: 'DELETE' });
}

/**
 * Re-apply the rules to old rows.
 *
 * After **adding** a rule, `onlyUnmatched: true` is enough (much faster).
 * After **changing or deleting** a rule, use `false`, otherwise rows that were
 *    already assigned would keep their old decision.
 */
export function recategorize(
  onlyUnmatched = true,
): Promise<{ scanned: number; changed: number }> {
  return api<{ scanned: number; changed: number }>('/categories/recategorize', {
    method: 'POST',
    body: { onlyUnmatched },
  });
}
