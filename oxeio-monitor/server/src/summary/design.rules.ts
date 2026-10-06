/**
 * **Daily design count**: pure rules, no I/O.
 *
 * Careful: **why this was possible at all.** oXeio measures time, not output,
 * so the owner's question *"how do we track a target of 25 designs?"* should
 * have meant "something new must be built". But the field data showed the
 * answer is **already being collected**: the agent keeps the window title,
 * and designers' file names start with the job number:
 *
 * ```
 * 37933-Woodcock Bird Vintage Illustration T-Shirt.ai @ 54 % (RGB/Preview)
 * ```
 *
 * So: no new agent, no extra work for staff, no button; just reading what is
 * already there.
 *
 * Careful: **the owner's condition:** the title may be read, but **only for
 * design apps** and **only the leading number**. The design name is stored
 * nowhere and never shown. No function in this file returns the name, and
 * that is not an accident.
 */

/**
 * Only the titles of these apps are looked at.
 *
 * Careful: an allowlist, not a blocklist; a new app does **not enter by
 * itself**. The other way round, someone's browser or chat title would one
 * day slip into this calculation, which is exactly the content-reading the
 * README says "never" about.
 */
export const DESIGN_APPS = ['illustrator.exe', 'photoshop.exe'] as const;

/**
 * Careful: 3-7 digits, and **no further digit may follow** (`(?!\d)`).
 *
 * **Not fewer than three**, deliberately: the field has files like
 * `4 [Converted].eps`, and those are not job numbers.
 *
 * Careful: **the boundary check is the heart of this rule.** It used to be
 * `/^(\d{3,6})/`, with no boundary. A seven-digit number then **had its first
 * six digits cut off**, which caused two big mistakes:
 *
 * | file | before | now |
 * |---|---|---|
 * | `1000042-Bird.ai` | `100004` (wrong) | `1000042` (right) |
 * | `1000043-Cat.ai` | `100004` (wrong, **the same**) | `1000043` (right) |
 * | `10163372_181.eps` *(stock)* | `101633` (wrong, counted) | skipped (right) |
 *
 * Careful: ten consecutive jobs (`1000040`-`1000049`) **were counted as one**.
 * Found in the field from 66 six-digit rows in `design_credits` (`101633`,
 * `104116`, `105091`), which were exactly the first six digits of stock file names.
 *
 * Careful: not more than seven: those would be dates or stock IDs
 * (`10163372_181`). Job numbers start at 1,000,000; at ~500 a day, seven
 * digits will last about 13 years.
 *
 * **A seven-digit stock ID (`1050918_OL5I`) still matches this rule.** It
 * will create an extra row in `design_credits`. But it **cannot put a wrong
 * mark on a target**, because targets are matched against **that designer's
 * own assigned numbers** (`markStartedByJobNumbers`).
 */
const DESIGN_ID = /^(\d{3,7})(?!\d)/;

/**
 * **The SQL twin of the rule above.**
 *
 * Careful: **one rule written in two languages, and this is exactly how bugs
 * are born in this repo.** There was no alternative, though: "how much time
 * went on files with this job number" has to be answered from the 154,000-row
 * `app_usage` **inside the database** (pulling it into TypeScript would bring
 * 53 MB on every page load).
 *
 * So the duplicate is not hidden but **placed side by side**, and an e2e test
 * runs both over the same list and compares them
 * ([file-trace.e2e.spec.ts](../../test/file-trace.e2e.spec.ts)). If one
 * changes without the other, the test goes red.
 *
 * Careful: Postgres ARE understands `(?!...)` (since 9.0), so the boundary
 * check is identical, and that is the heart of this rule (see the table above).
 */
export const DESIGN_ID_SQL = '^([0-9]{3,7})(?![0-9])';

/**
 * Careful: **these two strings must match the index in `migration.sql`
 * character for character**, otherwise Postgres will **not use the index at
 * all**: no error, only every query taking 1.5 seconds.
 *
 * A test catches that too: `EXPLAIN` is checked for the index name.
 */
export const DESIGN_ID_SQL_EXPR = `substring(btrim(window_title) FROM '${DESIGN_ID_SQL}')`;

/** The allowlist comes from here, so adding an app changes both paths together. */
export const DESIGN_APPS_SQL = `lower(process_name) IN (${DESIGN_APPS.map(
  (a) => `'${a}'`,
).join(', ')})`;

/**
 * Careful: the two strings above go straight into SQL (a bind parameter would
 * stop the index being used), so the path for a quote to slip in is closed.
 * Being constants it is impossible today, but this is for tomorrow's edits.
 */
if (`${DESIGN_ID_SQL_EXPR}${DESIGN_APPS_SQL}`.includes("';")) {
  throw new Error('DESIGN_ID_SQL: unexpected quote');
}

/**
 * The design number from a title; `null` if there is none.
 *
 * Careful: `Untitled-1*`, `Template.ai`, stock files and `.psd` layer files
 * drop out by themselves, since they do not start with a digit. Measured in
 * the field: about **47%** of design-app time is in numbered files; the rest
 * is preparation (upscale, stock, template), so numbered files are the final designs.
 *
 * Careful: **known false positive:** a name like `2026 Calendar Design.ai`
 * will take the year as a number. Business numbers are five digits (37933),
 * so this is rare, but if the count suddenly jumps, look here first.
 */
export function designIdOf(
  processName: string,
  windowTitle: string | null | undefined,
): string | null {
  if (!DESIGN_APPS.includes(processName.toLowerCase() as never)) return null;
  if (windowTitle == null) return null;

  const match = DESIGN_ID.exec(windowTitle.trim());

  return match === null ? null : match[1];
}

/**
 * **From this limit upward the number must be "assigned"**.
 *
 * Careful: why it was needed: `DESIGN_ID` accepts up to seven digits (job
 * numbers start at 1,000,000), but **seven-digit stock IDs exist too**:
 * `1536601_4406`, `5524618`, `9937760`. Four came in on a single day in the field.
 *
 * The reliable way to tell them apart is not guessing from digit count but
 * **checking whether it is in the list**. A seven-digit number is a design
 * only when it is really a job number handed to someone.
 *
 * Careful: six digits or fewer are **outside this condition**: older jobs
 * (the 37933 kind) have no target rows, and putting them under this
 * condition would silently zero the whole history.
 */
export const KNOWN_JOB_FROM = 1_000_000;

/**
 * At seven digits or more, **only known job numbers** survive.
 *
 * Careful: when `known` is empty (for example on days before targets went
 * live) every seven-digit number is dropped; that is right, since then they
 * could only have been stock IDs.
 */
export function keepKnownLongIds(
  ids: ReadonlySet<string>,
  known: ReadonlySet<string>,
): Set<string> {
  const kept = new Set<string>();

  for (const id of ids) {
    const n = Number.parseInt(id, 10);
    if (Number.isSafeInteger(n) && n >= KNOWN_JOB_FROM && !known.has(id)) {
      continue;
    }
    kept.add(id);
  }

  return kept;
}

/**
 * The **unique** design numbers from all of one day's titles, and beside
 * each the **earliest moment that day it appeared on screen**.
 *
 * Careful: the same design is revisited many times a day (in the field,
 * 1,553 distinct titles in 3,873 rows), so counting rows would give a
 * meaningless number.
 *
 * **The moment comes out here.**
 *
 * Careful: this function used to return only a `Set`, and the caller then
 * wrote **the work-day label** into `design_targets.started_at`, so every
 * target's "work started" became 6 am Asia/Dhaka time (the field zone). In the field **all 711 of
 * 711** sat at that one moment, and every one was **before** its own
 * `assigned_at` (assignment happens at 8 am).
 *
 * There was no need to guess: `app_usage.started_at` holds exactly that
 * moment, when the number first appeared in a title.
 * Careful: this also holds up <b>in a backfill</b>: recomputing an old day
 * still gives that day's number, not "today's".
 */
export function designFirstSeenInDay(
  rows: readonly {
    processName: string;
    windowTitle: string | null;
    startedAt: Date;
  }[],
): Map<string, Date> {
  const first = new Map<string, Date>();

  for (const row of rows) {
    const id = designIdOf(row.processName, row.windowTitle);
    if (id === null) continue;

    // Careful: the **earliest** moment; rows can arrive in any order.
    const known = first.get(id);
    if (known === undefined || row.startedAt < known) first.set(id, row.startedAt);
  }

  return first;
}

/**
 * **Targets are for designers only.**
 *
 * Careful: a `null` type means "not set yet" and is **skipped**, not treated
 * as zero. Otherwise, until types were set, everyone would show up daily as
 * "0/25" in the list, and that is an accusation, not information.
 */
export function hasDesignTarget(staffType: string | null | undefined): boolean {
  return staffType === 'designer';
}

/**
 * **What this employee's daily design target is.**
 *
 * ```
 * own number set           -> that
 * otherwise                -> the policy's number (25)
 * neither                  -> 0 (no target)
 * ```
 *
 * Careful: **`??` is used, not `||`, and the difference is real here.**
 * Setting **0** on an employee means *"switch this person's target off"*,
 * which is a valid decision (the schema says so too). With `||` that 0 would
 * silently fall back to the policy's 25, so the owner could not switch a
 * target off even if they wanted to.
 *
 * Careful: **`null` means "not set", not "zero"**: so leaving the field empty
 * applies the policy's number, and when the policy changes this person
 * changes with everyone else.
 *
 * **Written in one place, used in four** (Live Board, Telegram digest, the
 * employee's own page, attendance). The line `policy?.dailyDesignTarget ?? 0`
 * used to be **hand-written in three places**, while nobody read the
 * employee's own field: the column existed, but had neither a way to fill it
 * nor a way to read it.
 */
export function designTargetOf(
  own: number | null | undefined,
  policy: number | null | undefined,
): number {
  return own ?? policy ?? 0;
}

/**
 * **The maximum number of "done" marks allowed in a day** (the owner's rule:
 * no designer may complete more than 25 designs a day); `null` means **no limit**.
 *
 * Careful: the limit is `designTargetOf()`'s number itself, not a separate
 * constant. With two different numbers, someone's target could be raised to
 * 30 while the limit stayed at 25, and reaching the target would become impossible.
 *
 * | who | limit | why |
 * |---|---|---|
 * | designer, target 25 | **25** | the people the rule is for |
 * | designer, target **0** | none | 0 = *"this person's target is off"*, not a penalty |
 * | manager (OX-01) | none | has no target; in the field does up to 44 a day |
 *
 * Careful: **the limit applies only to the designer's own hand-pressed
 * button.** It does not apply when the owner or a manager marks on someone's
 * behalf, otherwise the way to correct mistakes would be closed, and the
 * audit (`completed_by_id`) records who did it anyway.
 *
 * Careful: measured in the field (23 August to 9 September): of 1,687 "done"
 * marks, this limit would have blocked **13** (0.8%), all OX-09 (9) and OX-08 (4).
 */
export function dailyCompletionCap(
  staffType: string | null | undefined,
  own: number | null | undefined,
  policy: number | null | undefined,
): number | null {
  if (!hasDesignTarget(staffType)) return null;

  const target = designTargetOf(own, policy);

  return target > 0 ? target : null;
}

export interface DesignView {
  done: number;
  /** Careful: `null` = **this employee has no design target**, which is not a zero target. */
  target: number | null;
  /** Always `false` when there is no target: "not applicable", not "failed". */
  met: boolean;
}

/**
 * What to show on screen: **three separate states**, not two (the owner's choice).
 *
 * | who | what is shown | why |
 * |---|---|---|
 * | designer with a target | `24 / 25` + tick | being measured |
 * | anyone else who still designed | just `43` | the number is **real**; hiding it loses data |
 * | someone who did no design | nothing | "0" reads like an accusation |
 *
 * Careful: **the middle row is the owner's decision.** The case was: the
 * manager (OX-01) also designs, **43** in three days. After the type was set
 * to `manager`, the number vanished from every screen although the work was
 * real. So "how many were done" and "did they reach the target" stay as two
 * separate questions.
 *
 * Careful: `met` is never `true` for someone without a target, deliberately:
 * the tick means "target reached", and with no target there is nothing to reach.
 */
export function designView(
  staffType: string | null | undefined,
  done: number,
  target: number,
): DesignView | null {
  if (hasDesignTarget(staffType) && target > 0) {
    return { done, target, met: done >= target };
  }

  return done > 0 ? { done, target: null, met: false } : null;
}
