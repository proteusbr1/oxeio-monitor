import { hasDesignTarget } from '../summary/design.rules';

import { UserRole } from '@prisma/client';

/**
 * Design targets: pure rules, no I/O.
 *
 * Researchers submit about 500 Amazon T-shirt URLs a day. These are randomly
 * distributed among designers, and each designer takes one and makes a new
 * design.
 *
 * Important: the identity is the ASIN, not the URL. The whole system rests on
 * this.
 */

/**
 * ASIN: Amazon's product identity, exactly 10 characters.
 *
 * Careful: one product has countless URLs:
 * ```
 * https://www.amazon.com/dp/B0DJBD22LW
 * https://www.amazon.com/Funny-Cat-Shirt/dp/B0DJBD22LW/ref=sr_1_3?keywords=cat
 * https://www.amazon.com/gp/product/B0DJBD22LW?th=1
 * ```
 * All three are the same item. Deduplicating by URL would treat them as three,
 * and three designers would design the same product, wasting three days of
 * work. The owner's requirement was that ASINs must be unique.
 */
const ASIN_PATTERNS = [
  /\/dp\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/gp\/product\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/product\/([A-Z0-9]{10})(?:[/?#]|$)/i,
];

/** Pasting a bare ASIN also works; people sometimes do that */
const BARE_ASIN = /^([A-Z0-9]{10})$/i;

export type RejectReason =
  | 'not_amazon'
  | 'short_link'
  | 'no_asin'
  | 'duplicate_in_paste';

export interface ParsedTarget {
  asin: string;
  /** Line number in the input, used to point out mistakes */
  line: number;
}

/**
 * URLs are built from the ASIN; the URL itself is not stored.
 *
 * We first considered keeping the original URL too ("where it came from"),
 * but that would put two forms of the same thing in the table: one person
 * pastes it with `?th=1` and that is what shows forever, another with
 * `ref=sr_1_3`. The ASIN is the same in every country and form, so one
 * canonical address is enough.
 */
export function amazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}`;
}

export interface RejectedLine {
  line: number;
  text: string;
  reason: RejectReason;
}

/**
 * Extracts the ASIN from one line.
 *
 * Careful: the ASIN cannot be extracted from `amzn.to`/`a.co` short links.
 * The only way is to ask Amazon, which means a server call to an outside
 * site, and this product deliberately does not do that. So they are rejected
 * with their own reason: not "something is wrong" but "open this link and give
 * the real URL".
 */
export function asinOf(raw: string): { asin: string } | { reason: RejectReason } {
  const text = raw.trim();
  if (text.length === 0) return { reason: 'no_asin' };

  const bare = BARE_ASIN.exec(text);
  if (bare) return { asin: bare[1].toUpperCase() };

  if (/(^|\/\/)(amzn\.to|a\.co)\//i.test(text)) return { reason: 'short_link' };

  // Any amazon domain (.com, .co.uk, .de): the TLD is not pinned, because
  // the same ASIN is the same in every country
  if (!/(^|\/\/|\.)amazon\.[a-z.]{2,}\//i.test(text)) {
    return { reason: 'not_amazon' };
  }

  for (const pattern of ASIN_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { asin: match[1].toUpperCase() };
  }

  return { reason: 'no_asin' };
}

/**
 * Up to 500 lines at once: the researcher's daily job.
 *
 * Careful: duplicates inside the paste are caught too (`duplicate_in_paste`),
 * not only those in the database. The same ASIN twice in one list is common
 * (the same product from two different searches), and without this
 * `createMany` itself would stall.
 *
 * Rejected lines are returned with their reason, not dropped. If 7 of 500 are
 * rejected, the researcher needs to know which 7, or could not collect them
 * again.
 */
export function parseBulk(text: string): {
  accepted: ParsedTarget[];
  rejected: RejectedLine[];
} {
  const accepted: ParsedTarget[] = [];
  const rejected: RejectedLine[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    // Blank lines are skipped silently: not an error, and a 500-line paste has them
    if (raw.length === 0) continue;

    const result = asinOf(raw);

    if ('reason' in result) {
      rejected.push({ line: i + 1, text: raw, reason: result.reason });
      continue;
    }

    if (seen.has(result.asin)) {
      rejected.push({ line: i + 1, text: raw, reason: 'duplicate_in_paste' });
      continue;
    }

    seen.add(result.asin);
    accepted.push({ asin: result.asin, line: i + 1 });
  }

  return { accepted, rejected };
}

/**
 * New serial numbers start at 1,000,000, a measured number.
 *
 * Designers already put numbers in file names (`37933-...T-Shirt.ai`). Counted
 * in the field: 78% are five digits (10,008 to 93,041) and the largest is
 * 973,065 (six digits, probably a stock file ID). None has seven digits.
 *
 * Starting at 1,000,000 therefore makes a collision practically impossible,
 * and no old file will be wrongly detected as "finished".
 */
export const JOB_NUMBER_START = 1_000_000;

/**
 * How many targets one designer holds at a time.
 *
 * It is higher than their daily target (owner's choice): someone with a target
 * of 25 still gets 30. This leaves room to choose, and a few unwanted ones do
 * not block the work. Giving exactly the target would make "choosing"
 * meaningless.
 */
export const POOL_PER_DESIGNER = 30;

/**
 * Who receives the daily distribution.
 *
 * Important: managers are on the list, and that is the only decision made
 * here. The office manager (OX-01) designs too, 1-2 days a week. The condition
 * used to be just `staffType === 'designer'`, so they got nothing and had to
 * pick by hand.
 *
 * Their name is not written in the code: the rule goes by kind of work, like
 * every other rule in the project. (A `can_proofread` checkbox was once
 * written per person and had to be removed within a day.)
 *
 * It is safe even if they do not work every day: at 23:55 `returnUnworked()`
 * sends designs nobody opened back to the pool. So no one accumulates a pile
 * and others' shares are not blocked. The pool holds about 52 days of work
 * today, and a tenth person would use about 47 days of it.
 *
 * Careful: even so, a manager has no daily target. `hasDesignTarget()` still
 * checks only `designer`, on purpose. They design 1-2 days a week, so showing
 * them "behind" on the other days would be false. Receiving work and being
 * held to a work standard are separate questions with separate answers. Their
 * completed count still shows on every screen, as a plain count (the middle
 * row of `designView`).
 */
export const DESIGN_WORK_STAFF_TYPES = ['designer', 'manager'] as const;

/**
 * The day the "waiting for upload" queue starts counting from.
 *
 * Careful: why a cut-off date is needed. The import brought in 27,509 old
 * `done` rows (the oldest from January 2025). They went to Amazon long ago,
 * but the Uploaded button did not exist then, so the field is empty. Without
 * a limit the queue would stand at 27,641, which is a mountain, not a queue,
 * and nobody starts on a mountain.
 *
 * 23 August was chosen because that is the day the Complete button started
 * being used in the field (0 presses on 22 August, 53 on 23 August). Every
 * "done" after that was really pressed by someone, and those are the ones
 * whose upload can still be pending.
 *
 * This is only a queue filter: it has no effect on counts or reports. The old
 * rows are intact, and can be marked by hand by looking up the ASIN.
 */
export const UPLOAD_QUEUE_FROM = '2026-08-23';

/**
 * File trace: three states, not two.
 *
 * | Returns | When | Shown as |
 * |---|---|---|
 * | `> 0` | the file with that number was open this long | `18m` |
 * | `0` | said "done", yet the file was never opened | `no trace` |
 * | `null` | cannot tell, not marked done yet, or no number | `—` |
 *
 * Careful: the last two must not be merged; that is the whole reason for this
 * function. `app_usage` started on 13 August 2026, but finished targets go
 * back to 2025. Merging them would show those 27 thousand old rows as "file
 * never opened", a false accusation, silently, on every row.
 *
 * This is the flip side of the rule in
 * [09-Build-Log section 4](../../../docs/09-Build-Log.md): "unknown is never
 * 0". Here the 0 is a real measurement, so "unknown" needs its own value.
 *
 * Which moment is judged: `completedAt ?? assignedAt`. For a finished row it
 * is the completion time, for a row in hand the assignment time. Both are the
 * row's own time, and a row still in the pool has no job number, so it gets
 * `null` anyway.
 *
 * Careful, known limit: if a row finished between 13 and 23 August had its
 * file opened before the 13th, it will wrongly show `0`. The queue (`no_file`)
 * starts after `UPLOAD_QUEUE_FROM`, so those ten days never appear in the
 * list; they do appear in the column, where the number is context, not a
 * verdict.
 */
export function fileSecOf(
  row: { jobNumber: number | null; completedAt: Date | null; assignedAt: Date | null },
  seconds: ReadonlyMap<number, number>,
  since: Date | null,
): number | null {
  if (row.jobNumber === null || since === null) return null;

  const at = row.completedAt ?? row.assignedAt;
  if (at === null || at < since) return null;

  const sec = seconds.get(row.jobNumber);
  if (sec !== undefined && sec > 0) return sec;

  /**
   * Careful: zero is only news on a row that was marked "done".
   *
   * A file in hand not having been opened yet is normal, and there is nothing
   * to say there (the `Stage` column already says "given"). But if both came
   * out as `0` on screen, every row assigned in the morning would show
   * "no trace", an accusation where no claim was ever made.
   */
  return row.completedAt === null ? null : 0;
}

/**
 * The most targets one person can be issued in a day.
 *
 * Careful: without this, top-up would have no ceiling and skipping could
 * refill forever. The calculation looks only at the current state: 30 in
 * hand, nothing finished means want 30, so give 0. Skip one and there are 29
 * in hand, so give 1 again. Skip again, give 1 again. Every Skip would be
 * replaced one for one, and someone could churn through the whole pool in a
 * day.
 *
 * 60 is twice 30. In the field the skip rate is 4-18%, so finishing 25 never
 * needs 60 targets. The limit therefore never affects honest work and only
 * stops the endless loop.
 */
export const MAX_ISSUED_PER_DAY = POOL_PER_DESIGNER * 2;

/**
 * How many more targets to put in hand today. 0 means nothing to give.
 *
 * The owner's rule: when complete + skip add up to 30, the person has no
 * designs left to work on, so give more so they can reach the daily target of
 * 25.
 *
 * Careful: the condition is not "hand is empty" but "can the target still be
 * reached". Measured in the field, the difference matters. "All 30 finished
 * or skipped" practically never happens, because started-but-unfinished
 * targets stay in hand (`returnUnworked` does not take them back). On 7 and 8
 * September, when the manager ran two distributions by hand, nobody's hand
 * was empty: everyone held between 17 and 29.
 *
 * So the condition follows the owner's intent, not the sentence: if finishing
 * everything in hand still cannot reach 25, give more. An empty hand
 * (`openCount === 0`) falls inside this, so the owner's stated rule is not
 * lost; it is caught earlier.
 *
 * Careful: the same 30:25 ratio (`POOL_PER_DESIGNER / dailyTarget`) is used,
 * to leave room to choose, as in the morning distribution. The skip rate is
 * 4-18%, so giving exactly that many would leave many people stuck again.
 *
 * A target of 0 or less gives nothing. For people without a target, such as
 * the manager, the morning distribution is enough.
 */
export function topUpSize(
  state: {
    /**
     * Careful: the kind of work is checked here, not in the caller.
     *
     * `DESIGN_WORK_STAFF_TYPES` includes the manager, so they also receive the
     * morning distribution, yet `designTargetOf()` returns the policy's 25 for
     * them too (`hasDesignTarget()` is a separate question). With the gate in
     * the caller, someone would eventually forget it, and the manager would
     * silently become a designer with a 25 target. `dailyCompletionCap()`
     * keeps its gate inside for exactly this reason; this does the same.
     */
    staffType: string | null | undefined;
    /** How many were marked done in today's Dhaka day */
    completedToday: number;
    /** How many `assigned` targets are in hand now */
    openCount: number;
    /** The total number issued to them in today's Dhaka day */
    issuedToday: number;
    /** Their daily design target (`designTargetOf`) */
    dailyTarget: number;
  },
  perDesigner = POOL_PER_DESIGNER,
  maxPerDay = MAX_ISSUED_PER_DAY,
): number {
  if (!hasDesignTarget(state.staffType)) return 0;
  /**
   * Careful: a target of 0 also switches top-up off. This is a trap worth
   * writing down: if the owner sets someone's target to 0 to lift their limit,
   * they silently switch off their top-up too. The morning distribution of 30
   * still runs (`allocationSizes` does not look at the target), so nobody is
   * left without work.
   */
  if (state.dailyTarget <= 0) return 0;

  const remaining = state.dailyTarget - state.completedToday;
  // Today's target is already reached; nothing more to give
  if (remaining <= 0) return 0;

  const want = Math.ceil((remaining * perDesigner) / state.dailyTarget);
  const budget = Math.max(0, maxPerDay - state.issuedToday);

  return Math.min(Math.max(0, want - state.openCount), budget);
}

export interface DesignerNeed {
  employeeId: number;
  /** How many `assigned` targets are in hand now */
  openCount: number;
}

/**
 * How many each person should get: pure arithmetic, before the random pick.
 *
 * The count excludes targets already in hand. Giving 30 every day would pile
 * up two hundred on someone within a week and drain the pool for nothing.
 *
 * If the pool is short, give as many as exist; who goes first follows the
 * order of `needs`. The caller supplies that order by staff code, so a
 * shortage day is still predictable, not random.
 */
export function allocationSizes(
  needs: readonly DesignerNeed[],
  poolSize: number,
  perDesigner = POOL_PER_DESIGNER,
): Map<number, number> {
  const out = new Map<number, number>();
  let left = poolSize;

  for (const need of needs) {
    if (left <= 0) break;

    const want = Math.max(0, perDesigner - need.openCount);
    if (want === 0) continue;

    const give = Math.min(want, left);
    out.set(need.employeeId, give);
    left -= give;
  }

  return out;
}

/**
 * Who can use the targets section: owner, manager, researcher.
 *
 * Careful: the formula lives in one place, and that is the whole reason for
 * this function. The same question is asked in three places: the server guard
 * (`assertCanUse`), the session flags (`canAddTargets`, `canProofread`), and
 * the sidebar list. Written by hand in three places, one would change one day
 * and not the others. That is exactly what happened on 24 August, only then
 * the split was across two tables (ADR-038).
 *
 * `employee` is deliberately excluded: a designer sees their own 30 in
 * `/me/targets`, and the whole team's pool is not theirs to see.
 *
 * Pure function, no database call: `UserRole` is already in the session, and
 * `JwtAuthGuard` refreshes it from the database every 5 minutes.
 */
export function canUseTargets(role: UserRole): boolean {
  return (
    role === UserRole.owner ||
    role === UserRole.manager ||
    role === UserRole.researcher
  );
}

/**
 * Why a target went out of work.
 *
 * Careful: both paths use the same three reasons, and that is the real
 * decision here. A designer presses Skip and the owner presses Delete, but the
 * question is the same: "why was this dropped?" Two lists in two places would
 * eventually get a new reason in one and not the other, and counting would
 * become impossible.
 *
 * Careful: the value is machine-readable, not screen text: `not_found` is
 * stored, not `"Not Found"`. Changing screen text is cheap; changing the
 * meaning of thousands of stored rows is not.
 *
 * The reason is mandatory (on screen the button is the reason). If optional,
 * everyone would leave it blank and the field would sit NULL on 93 rows, like
 * `skipped_reason` today.
 */
export const DROP_REASONS = ['not_found', 'copyright', 'events'] as const;

export type DropReason = (typeof DROP_REASONS)[number];

/** Validates a raw string from outside; the DTO and the service both call this */
export function isDropReason(raw: unknown): raw is DropReason {
  return (
    typeof raw === 'string' && (DROP_REASONS as readonly string[]).includes(raw)
  );
}
