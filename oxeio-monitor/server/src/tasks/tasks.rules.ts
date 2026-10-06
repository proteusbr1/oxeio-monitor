import { UserRole } from '@prisma/client';

import { hasTaskTarget } from '../summary/task-start.rules';

/**
 * Tasks: pure rules, no I/O.
 *
 * Coordinators, managers or the owner paste work items into a pool; every
 * morning they are handed out at random to the people who receive tasks, and
 * each person works through their own list.
 *
 * Important: the identity is the `reference`, and it is unique. The whole
 * duplicate guard rests on this.
 */

/** The most lines one paste may hold */
export const BULK_MAX_LINES = 500;

/** `tasks.reference` is VARCHAR(200) */
export const REFERENCE_MAX = 200;

/** `tasks.link` is VARCHAR(500) */
export const LINK_MAX = 500;

export type RejectReason =
  | 'too_long'
  | 'bad_link'
  | 'duplicate_in_paste'
  | 'already_exists';

export interface ParsedTask {
  reference: string;
  /** An http(s) URL, or `null` */
  link: string | null;
  /** Line number in the input, used to point out mistakes */
  line: number;
}

export interface RejectedLine {
  line: number;
  text: string;
  reason: RejectReason;
}

const BARE_URL = /^https?:\/\/\S+$/i;

/**
 * A link is kept only when it is an absolute http(s) URL with no spaces.
 *
 * Careful: other schemes (`javascript:`, `file:`, `data:`) are refused: the
 * link is rendered as a clickable anchor on everyone's screen, so it must
 * never be anything but a web address.
 */
export function isWebLink(raw: string): boolean {
  if (!BARE_URL.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * One pasted line → one task.
 *
 * | line | reference | link |
 * |---|---|---|
 * | `INV-2041` | `INV-2041` | `null` |
 * | `INV-2041 \| https://crm.example/inv/2041` | `INV-2041` | the URL |
 * | `https://crm.example/inv/2041` | the URL | the URL |
 *
 * Careful: the split is at the **first** `|`, so a link containing `|` is
 * kept whole.
 */
export function taskOfLine(
  raw: string,
): { reference: string; link: string | null } | { reason: RejectReason } {
  const text = raw.trim();

  let reference: string;
  let link: string | null;

  const bar = text.indexOf('|');
  if (bar >= 0) {
    reference = text.slice(0, bar).trim();
    const right = text.slice(bar + 1).trim();
    link = right.length > 0 ? right : null;
    // "| https://…": the link is all there is, so it names the task too
    if (reference.length === 0 && link !== null) reference = link;
  } else if (BARE_URL.test(text)) {
    reference = text;
    link = text;
  } else {
    reference = text;
    link = null;
  }

  if (reference.length > REFERENCE_MAX) return { reason: 'too_long' };
  if (link !== null && link.length > LINK_MAX) return { reason: 'too_long' };
  if (link !== null && !isWebLink(link)) return { reason: 'bad_link' };
  if (reference.length === 0) return { reason: 'bad_link' };

  return { reference, link };
}

/**
 * Up to `BULK_MAX_LINES` lines at once.
 *
 * Careful: duplicates inside the paste are caught too (`duplicate_in_paste`),
 * not only those in the database (`already_exists`, decided by the caller).
 * Without this the insert would see the same reference twice.
 *
 * Rejected lines are returned with their reason, not dropped. If 7 of 500 are
 * rejected, whoever pasted needs to know which 7.
 */
export function parseBulk(text: string): {
  accepted: ParsedTask[];
  rejected: RejectedLine[];
} {
  const accepted: ParsedTask[] = [];
  const rejected: RejectedLine[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    // Blank lines are skipped silently: not an error
    if (raw.length === 0) continue;

    const result = taskOfLine(raw);

    if ('reason' in result) {
      rejected.push({ line: i + 1, text: raw, reason: result.reason });
      continue;
    }

    if (seen.has(result.reference)) {
      rejected.push({ line: i + 1, text: raw, reason: 'duplicate_in_paste' });
      continue;
    }

    seen.add(result.reference);
    accepted.push({ ...result, line: i + 1 });
  }

  return { accepted, rejected };
}

/** How many non-blank lines a paste has: the `BULK_MAX_LINES` ceiling counts these */
export function pastedLineCount(text: string): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) if (line.trim().length > 0) n++;
  return n;
}

/**
 * New task numbers start at 1,000,000 (`task_number_seq`).
 *
 * People often already put short numbers at the start of file names; seven
 * digits keep a new task number from ever matching one of those, so no old
 * window is wrongly read as "task started".
 */
export const TASK_NUMBER_START = 1_000_000;

/**
 * How many tasks one person holds at a time.
 *
 * It is higher than the daily target: someone with a target of 25 still gets
 * 30. This leaves room to choose, and a few unwanted ones do not block the
 * work. Giving exactly the target would make "choosing" meaningless.
 */
export const POOL_PER_ASSIGNEE = 30;

/**
 * On-screen time: three states, not two.
 *
 * | Returns | When | Shown as |
 * |---|---|---|
 * | `> 0` | a window with that number was in front this long | `18m` |
 * | `0` | said "done", yet the number was never seen on screen | `not seen` |
 * | `null` | cannot tell: detection off, not marked done yet, or no number | `—` |
 *
 * Careful: the last two must not be merged; that is the whole reason for this
 * function. Window titles are only stored since `since`; finished tasks from
 * before then would all show "never seen", a false accusation on every row.
 *
 * Which moment is judged: `completedAt ?? assignedAt`. For a finished row it
 * is the completion time, for a row in hand the assignment time.
 */
export function onScreenSecOf(
  row: { taskNumber: number | null; completedAt: Date | null; assignedAt: Date | null },
  seconds: ReadonlyMap<number, number>,
  since: Date | null,
): number | null {
  if (row.taskNumber === null || since === null) return null;

  const at = row.completedAt ?? row.assignedAt;
  if (at === null || at < since) return null;

  const sec = seconds.get(row.taskNumber);
  if (sec !== undefined && sec > 0) return sec;

  /**
   * Careful: zero is only news on a row that was marked "done".
   *
   * A task in hand not having been opened yet is normal, and there is nothing
   * to say there (the stage column already says "given").
   */
  return row.completedAt === null ? null : 0;
}

/**
 * The most tasks one person can be issued in a day.
 *
 * Careful: without this, top-up would have no ceiling and skipping could
 * refill forever: skip one, get one, skip again, get one again. 60 is twice
 * 30; honest work never needs it, it only stops the endless loop.
 */
export const MAX_ISSUED_PER_DAY = POOL_PER_ASSIGNEE * 2;

/**
 * How many more tasks to put in hand today. 0 means nothing to give.
 *
 * The rule: if finishing everything in hand still cannot reach today's
 * target, give more. An empty hand falls inside this.
 *
 * Careful: the same 30:25 ratio (`POOL_PER_ASSIGNEE / dailyTarget`) is used,
 * to leave room to choose, as in the morning hand-out.
 *
 * Careful: the "has a target" gate sits here, not in the caller: someone who
 * receives tasks with a target of 0 (a manager who helps out) gets the morning
 * hand-out but never a top-up. With the gate in the caller, someone would
 * eventually forget it.
 */
export function topUpSize(
  state: {
    /** `employees.receives_tasks` */
    receivesTasks: boolean;
    /** How many were marked done in today's work day */
    completedToday: number;
    /** How many `assigned` tasks are in hand now */
    openCount: number;
    /** The total number issued to them in today's work day */
    issuedToday: number;
    /** Their daily task target (`taskTargetOf`) */
    dailyTarget: number;
  },
  perAssignee = POOL_PER_ASSIGNEE,
  maxPerDay = MAX_ISSUED_PER_DAY,
): number {
  /**
   * Careful: a target of 0 also switches top-up off. The morning hand-out of
   * 30 still runs (`allocationSizes` does not look at the target), so nobody
   * is left without work.
   */
  if (!hasTaskTarget(state.receivesTasks, state.dailyTarget)) return 0;

  const remaining = state.dailyTarget - state.completedToday;
  // Today's target is already reached; nothing more to give
  if (remaining <= 0) return 0;

  const want = Math.ceil((remaining * perAssignee) / state.dailyTarget);
  const budget = Math.max(0, maxPerDay - state.issuedToday);

  return Math.min(Math.max(0, want - state.openCount), budget);
}

export interface AssigneeNeed {
  employeeId: number;
  /** How many `assigned` tasks are in hand now */
  openCount: number;
}

/**
 * How many each person should get: pure arithmetic, before the random pick.
 *
 * The count excludes tasks already in hand. Giving 30 every day would pile
 * up two hundred on someone within a week and drain the pool for nothing.
 *
 * If the pool is short, give as many as exist; who goes first follows the
 * order of `needs`. The caller supplies that order by staff code, so a
 * shortage day is still predictable, not random.
 */
export function allocationSizes(
  needs: readonly AssigneeNeed[],
  poolSize: number,
  perAssignee = POOL_PER_ASSIGNEE,
): Map<number, number> {
  const out = new Map<number, number>();
  let left = poolSize;

  for (const need of needs) {
    if (left <= 0) break;

    const want = Math.max(0, perAssignee - need.openCount);
    if (want === 0) continue;

    const give = Math.min(want, left);
    out.set(need.employeeId, give);
    left -= give;
  }

  return out;
}

/**
 * Who can use the task pool: owner, manager, coordinator.
 *
 * Careful: the formula lives in one place, and that is the whole reason for
 * this function. The same question is asked in three places: the server guard
 * (`assertCanUse`), the session flags (`canAddTasks`, `canCheckTasks`), and
 * the sidebar list.
 *
 * `employee` is deliberately excluded: they see their own list in
 * `/me/tasks`, and the whole team's pool is not theirs to see.
 */
export function canUseTasks(role: UserRole): boolean {
  return (
    role === UserRole.owner ||
    role === UserRole.manager ||
    role === UserRole.coordinator
  );
}

/**
 * Why a task went out of work.
 *
 * Careful: both paths use the same reasons: the assignee presses Skip and the
 * owner presses Delete, but the question is the same: "why was this dropped?"
 *
 * Careful: the value is machine-readable, not screen text: `not_needed` is
 * stored, not `"No longer needed"`. Changing screen text is cheap; changing
 * the meaning of thousands of stored rows is not.
 *
 * The reason is mandatory (on screen the button is the reason).
 */
export const DROP_REASONS = ['not_needed', 'cannot_do', 'duplicate', 'other'] as const;

export type DropReason = (typeof DROP_REASONS)[number];

/** Validates a raw string from outside */
export function isDropReason(raw: unknown): raw is DropReason {
  return (
    typeof raw === 'string' && (DROP_REASONS as readonly string[]).includes(raw)
  );
}

/**
 * The reason values written before the Tasks module → today's values. The
 * migration rewrote the stored rows with this same mapping; it is kept here
 * so the rule has one readable home (and a test).
 */
export const LEGACY_DROP_REASONS: Readonly<Record<string, DropReason>> = {
  not_found: 'not_needed',
  copyright: 'cannot_do',
  events: 'cannot_do',
};

export function dropReasonOf(raw: string | null): DropReason | null {
  if (raw === null) return null;
  if (isDropReason(raw)) return raw;
  return LEGACY_DROP_REASONS[raw] ?? 'other';
}
