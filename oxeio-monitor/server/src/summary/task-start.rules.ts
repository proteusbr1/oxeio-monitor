/**
 * **Task start detection and daily task numbers**: pure rules, no I/O.
 *
 * Every task gets a number when it is added (`tasks.task_number`). People
 * who put that number at the start of the document or file name make it show
 * at the start of the window title:
 *
 * ```
 * 1000042 - Quarterly report.docx - Word
 * ```
 *
 * The agent already keeps window titles, so "work on task 1000042 started"
 * can be read from what is already there: no new agent, no extra button.
 *
 * Careful: **the condition:** titles are looked at **only for the apps the
 * owner listed** (Settings → Tasks → start detection) and **only the leading
 * number** is taken. The title itself is stored nowhere and never shown. No
 * function in this file returns it, and that is not an accident.
 *
 * Careful: start detection is **off** when the list of apps is empty (the
 * default) or when the Apps & websites module is off: then no title is read
 * at all and `tasksStarted` stays 0.
 */

/**
 * The configured app list → the set titles are read for.
 *
 * Careful: process names are matched **case-insensitively** (`Excel.EXE` is
 * `excel.exe`), so everything is lowered once here; blanks and repeats drop
 * out.
 *
 * An allowlist, not a blocklist: an app that is not listed **never enters by
 * itself**, so a browser or chat title can never slip into this calculation.
 */
export function startDetectionApps(apps: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const app of apps) {
    const name = app.trim().toLowerCase();
    if (name.length > 0) out.add(name);
  }
  return out;
}

/**
 * Careful: 3-7 digits, and **no further digit may follow** (`(?!\d)`).
 *
 * **Not fewer than three**, deliberately: titles like `4 [Converted].eps`
 * are not task numbers.
 *
 * Careful: **the boundary check is the heart of this rule.** Without it a
 * seven-digit number **had its first six digits cut off**:
 *
 * | title | without boundary | now |
 * |---|---|---|
 * | `1000042-Report.docx` | `100004` (wrong) | `1000042` (right) |
 * | `1000043-Invoice.xlsx` | `100004` (wrong, **the same**) | `1000043` (right) |
 * | `10163372_181.eps` *(a stock id)* | `101633` (wrong, counted) | skipped (right) |
 *
 * Careful: not more than seven: those would be dates or stock IDs. Task
 * numbers start at 1,000,000; at ~500 a day, seven digits last about 13 years.
 *
 * **A seven-digit stock ID still matches this rule.** It cannot put a wrong
 * mark on a task, though: tasks are matched against **that person's own
 * assigned numbers** (`markStartedByTaskNumbers`), and long numbers are kept
 * only when they are real task numbers (`keepKnownLongNumbers`).
 */
export const TASK_NUMBER_IN_TITLE = /^(\d{3,7})(?!\d)/;

/**
 * **The SQL twin of the rule above.**
 *
 * Careful: **one rule written in two languages.** There was no alternative:
 * "how long was a window with this number in front" has to be answered from
 * `app_usage` **inside the database** (pulling every title into TypeScript
 * would bring tens of MB on every page load).
 *
 * So the duplicate is not hidden but **placed side by side**, and an e2e test
 * runs both over the same list and compares them
 * ([on-screen.e2e.spec.ts](../../test/on-screen.e2e.spec.ts)). If one
 * changes without the other, the test goes red.
 *
 * Careful: Postgres ARE understands `(?!...)` (since 9.0), so the boundary
 * check is identical.
 */
export const TASK_NUMBER_SQL = '^([0-9]{3,7})(?![0-9])';

/**
 * Careful: **this string must match the `app_usage_task_number_idx` index
 * in `migration.sql` character for character**, otherwise Postgres will
 * **not use the index at all**: no error, only every query getting slow.
 *
 * A test catches that too: `EXPLAIN` is checked for the index name.
 */
export const TASK_NUMBER_SQL_EXPR = `substring(btrim(window_title) FROM '${TASK_NUMBER_SQL}')`;

/**
 * Careful: the string above goes straight into SQL (a bind parameter would
 * stop the index being used), so the path for a quote to slip in is closed.
 * Being a constant it is impossible today, but this is for tomorrow's edits.
 */
if (TASK_NUMBER_SQL_EXPR.includes("';")) {
  throw new Error('TASK_NUMBER_SQL: unexpected quote');
}

/**
 * The task number from a title; `null` if there is none, or if the app is
 * not one of the start-detection apps.
 *
 * Careful: **known false positive:** a title like `2026 Plan.docx` takes the
 * year as a number. Long numbers are checked against real task numbers
 * (`keepKnownLongNumbers`), and four-digit ones never match an assigned task,
 * so this only shows in the plain "started" count.
 */
export function taskNumberOf(
  processName: string,
  windowTitle: string | null | undefined,
  apps: ReadonlySet<string>,
): string | null {
  if (!apps.has(processName.toLowerCase())) return null;
  if (windowTitle == null) return null;

  const match = TASK_NUMBER_IN_TITLE.exec(windowTitle.trim());

  return match === null ? null : match[1];
}

/**
 * **From this limit upward the number must be a real task number**.
 *
 * Careful: why it was needed: the title rule accepts up to seven digits
 * (task numbers start at 1,000,000), but **seven-digit stock IDs exist
 * too**. The reliable way to tell them apart is not guessing from digit
 * count but **checking whether it is in the list**.
 *
 * Careful: six digits or fewer are **outside this condition**: numbers
 * people used before tasks existed have no task rows, and putting them under
 * this condition would silently zero the whole history.
 */
export const KNOWN_NUMBER_FROM = 1_000_000;

/**
 * At seven digits or more, **only known task numbers** survive.
 *
 * Careful: when `known` is empty every seven-digit number is dropped; that is
 * right, since then they could only have been stock IDs.
 */
export function keepKnownLongNumbers(
  numbers: ReadonlySet<string>,
  known: ReadonlySet<string>,
): Set<string> {
  const kept = new Set<string>();

  for (const id of numbers) {
    const n = Number.parseInt(id, 10);
    if (Number.isSafeInteger(n) && n >= KNOWN_NUMBER_FROM && !known.has(id)) {
      continue;
    }
    kept.add(id);
  }

  return kept;
}

/**
 * The **unique** task numbers from all of one day's titles, and beside each
 * the **earliest moment that day it appeared on screen**.
 *
 * Careful: the same task is brought to the front many times a day, so
 * counting rows would give a meaningless number.
 *
 * Careful: the moment comes from `app_usage.started_at`, the instant the
 * number first appeared in a title. Using the work-day label instead would
 * give every task the same "started" time (the zone's midnight). It also
 * holds up in a backfill: recomputing an old day gives that day's moment.
 */
export function taskNumbersFirstSeenInDay(
  rows: readonly {
    processName: string;
    windowTitle: string | null;
    startedAt: Date;
  }[],
  apps: ReadonlySet<string>,
): Map<string, Date> {
  const first = new Map<string, Date>();

  for (const row of rows) {
    const id = taskNumberOf(row.processName, row.windowTitle, apps);
    if (id === null) continue;

    // Careful: the **earliest** moment; rows can arrive in any order.
    const known = first.get(id);
    if (known === undefined || row.startedAt < known) first.set(id, row.startedAt);
  }

  return first;
}

/**
 * **What this employee's daily task target is.**
 *
 * ```
 * own number set           -> that
 * otherwise                -> the policy's number (25)
 * neither                  -> 0 (no target)
 * ```
 *
 * Careful: **`??` is used, not `||`, and the difference is real here.**
 * Setting **0** on an employee means *"switch this person's target off"*,
 * which is a valid decision. With `||` that 0 would silently fall back to the
 * policy's 25.
 *
 * Careful: **`null` means "not set", not "zero"**: so leaving the field empty
 * applies the policy's number, and when the policy changes this person
 * changes with everyone else.
 */
export function taskTargetOf(
  own: number | null | undefined,
  policy: number | null | undefined,
): number {
  return own ?? policy ?? 0;
}

/**
 * **Is this person held to a daily task target?**
 *
 * Receiving tasks and having a target are two questions: a manager may
 * receive tasks on the days they have time, with a target of 0, and showing
 * them "behind" on the other days would be false.
 */
export function hasTaskTarget(
  receivesTasks: boolean | null | undefined,
  target: number,
): boolean {
  return receivesTasks === true && target > 0;
}

/**
 * **The maximum number of "done" marks allowed in a day**; `null` means
 * **no limit**.
 *
 * Careful: the limit is `taskTargetOf()`'s number itself, not a separate
 * constant. With two different numbers, someone's target could be raised to
 * 30 while the limit stayed at 25, and reaching the target would become
 * impossible.
 *
 * | who | limit | why |
 * |---|---|---|
 * | receives tasks, target 25 | **25** | the people the rule is for |
 * | receives tasks, target **0** | none | 0 = *"this person's target is off"* |
 * | does not receive tasks | none | the measure is not theirs |
 *
 * Careful: **the limit applies only to the assignee's own button.** It does
 * not apply when the owner or a manager marks on someone's behalf, otherwise
 * the way to correct mistakes would be closed, and `completed_by_id` records
 * who did it anyway.
 */
export function dailyCompletionCap(
  receivesTasks: boolean | null | undefined,
  own: number | null | undefined,
  policy: number | null | undefined,
): number | null {
  const target = taskTargetOf(own, policy);

  return hasTaskTarget(receivesTasks, target) ? target : null;
}

export interface TaskView {
  done: number;
  /** Careful: `null` = **this employee has no task target**, which is not a zero target. */
  target: number | null;
  /** Always `false` when there is no target: "not applicable", not "failed". */
  met: boolean;
}

/**
 * What to show on screen: **three separate states**, not two.
 *
 * | who | what is shown | why |
 * |---|---|---|
 * | has a target | `24 / 25` + tick | being measured |
 * | anyone else who still finished tasks | just `43` | the number is **real**; hiding it loses data |
 * | someone who finished none | nothing | "0" reads like an accusation |
 *
 * Careful: `met` is never `true` for someone without a target, deliberately:
 * the tick means "target reached", and with no target there is nothing to reach.
 */
export function taskView(
  receivesTasks: boolean | null | undefined,
  done: number,
  target: number,
): TaskView | null {
  if (hasTaskTarget(receivesTasks, target)) {
    return { done, target, met: done >= target };
  }

  return done > 0 ? { done, target: null, met: false } : null;
}
