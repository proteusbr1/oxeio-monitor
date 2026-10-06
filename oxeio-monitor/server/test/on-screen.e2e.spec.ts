import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import {
  startDetectionApps,
  TASK_NUMBER_SQL_EXPR,
  taskNumberOf,
} from '../src/summary/task-start.rules';
import { OnScreenService } from '../src/tasks/on-screen.service';
import { TASKS_SETTING_KEY } from '../src/tasks/tasks-settings.rules';
import { TasksService } from '../src/tasks/tasks.service';
import {
  createEmployeeWithCode,
  createHarness,
  workNoon,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * Measuring beside the claim — a task's "done" mark is the assignee's own
 * click, and the "On screen" column puts next to it how long a window whose
 * title starts with that task number was in front.
 *
 * What this file guards is not a bug but a risk. The answer to "how much time
 * did this number spend on screen" has to be computed in the database, so the
 * `TASK_NUMBER_IN_TITLE` rule is written in two languages, TypeScript and
 * SQL. This repo's most familiar failure is exactly that: changing one place
 * and not the other.
 *
 * So the first two tests below block the two ways the copy can break:
 *   a. whether the two rules give the same result on the same list
 *   b. whether the SQL text matches the index in `migration.sql`
 *      (if not there is no error — every page just gets slow)
 *
 * Only the apps listed for start detection count, and nothing is measured
 * while start detection is off.
 */
let h: Harness;
let onScreen: OnScreenService;
let tasks: TasksService;

const HOUR_MS = 3600_000;
/** The test zone is UTC+6 — subtract this to go from the label to the real instant */
const WORK_OFFSET_MS = 6 * HOUR_MS;

const INDEX = 'app_usage_task_number_idx';

/** What the owner typed in Settings → Tasks — deliberately mixed case */
const LISTED = ['Excel.exe', 'WINWORD.EXE'];
/** What the service is handed: the lower-cased set */
const APPS = startDetectionApps(LISTED);
const NO_APPS: ReadonlySet<string> = new Set();

beforeAll(async () => {
  h = await createHarness();
  onScreen = h.app.get(OnScreenService);
  tasks = h.app.get(TasksService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  // Start detection on for every test unless a test says otherwise
  await h.prisma.setting.create({
    data: { key: TASKS_SETTING_KEY, value: { startDetection: { apps: LISTED } } },
  });
});

const today = () => workDateOf(workNoon());
const dayBefore = (label: Date, days: number): Date =>
  new Date(label.getTime() - days * 86_400_000);
const atWorkHour = (dayLabel: Date, hour: number): Date =>
  new Date(dayLabel.getTime() - WORK_OFFSET_MS + hour * HOUR_MS);

async function assignee(code = 'OX-OS1'): Promise<{
  employeeId: number;
  deviceId: number;
}> {
  const { employeeId } = await createEmployeeWithCode(h.prisma, code);

  await h.prisma.employee.update({
    where: { id: employeeId },
    data: { receivesTasks: true },
  });

  const device = await h.prisma.device.create({
    data: {
      hostname: `PC-${code}`,
      windowsUsername: code.toLowerCase(),
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
      status: 'active',
    },
  });

  return { employeeId, deviceId: device.id };
}

/** An `app_usage` row — the title exactly as given */
async function saw(
  who: { employeeId: number; deviceId: number },
  day: Date,
  title: string,
  seconds: number,
  process = 'Excel.exe',
): Promise<void> {
  const startedAt = atWorkHour(day, 11);

  await h.prisma.appUsage.create({
    data: {
      employeeId: who.employeeId,
      deviceId: who.deviceId,
      clientUuid: randomUUID(),
      workDate: day,
      startedAt,
      endedAt: new Date(startedAt.getTime() + seconds * 1000),
      durationSec: seconds,
      processName: process,
      windowTitle: title,
    },
  });
}

async function task(
  employeeId: number,
  taskNumber: number,
  when: { assignedAt: Date; completedAt?: Date },
): Promise<number> {
  const owner = await h.prisma.user.findFirstOrThrow();

  const row = await h.prisma.task.create({
    data: {
      reference: `REF-${taskNumber}`,
      taskNumber,
      status: when.completedAt ? 'done' : 'assigned',
      assignedToId: employeeId,
      assignedAt: when.assignedAt,
      completedAt: when.completedAt ?? null,
      completedVia: when.completedAt ? 'manual' : null,
      addedById: owner.id,
    },
  });

  return row.id;
}

/**
 * Hard titles — each one has a comment saying why it is here.
 *
 * This list is the judge between the two rules, so no easy cases are kept:
 * every row is some boundary.
 */
const CORPUS: readonly string[] = [
  // An old five-digit number
  '37933 - Supplier contract.docx - Word',
  // Seven digits, two side by side — without the boundary both would become `100004`
  '1000042-Report.docx',
  '1000043-Invoice.xlsx',
  // An eight-digit id — dropped by the boundary check
  '10163372_181.xlsx',
  // One digit — dropped by the "not fewer than three" rule
  '4 [Compatibility Mode].docx',
  // Two digits are dropped too
  '12-Something.docx',
  // Three digits — exactly at the boundary, so it is kept
  '123-Small task.xlsx',
  // Does not start with a digit
  'Document1 - Word',
  'Book1.xlsx - Excel',
  // Known false positive — it takes the year as a number. Both rules must
  // be wrong in the same way, otherwise the two counts would diverge.
  '2026 Budget plan.xlsx',
  // Leading blanks — `.trim()` in TS, `btrim()` in SQL
  '   1050968-Trim Me.docx',
  // Seven digits then an underscore — the boundary is not a digit, so the number is kept
  '1050918_A1.xlsx',
];

/**
 * Numbers that only a broken rule could produce.
 *
 * No title in the list above should produce these — if one does, the SQL
 * rule has drifted:
 *   - `100004`  — cutting `1000042` to six digits when there is no boundary check
 *   - `1016337` — from `10163372_181.xlsx`, without `(?![0-9])`
 *   - `4`, `12` — if the "not fewer than three" rule is loosened
 */
const WRONG_IDS: readonly number[] = [100004, 1016337, 105091, 4, 12];

describe('on screen — SQL and TypeScript use the same rule', () => {
  /**
   * The most important test in this file.
   *
   * `TASK_NUMBER_IN_TITLE` (TypeScript) and `TASK_NUMBER_SQL` (Postgres):
   * change one and not the other and the started count and the "On screen"
   * column silently diverge. No error is raised; two screens just say two
   * different things.
   */
  it('the two rules give exactly the same result on the hard-title list', async () => {
    const who = await assignee();
    const day = today();

    for (const title of CORPUS) await saw(who, day, title, 60);

    // ── TypeScript's answer
    const fromTs = new Set<number>();
    for (const title of CORPUS) {
      const id = taskNumberOf('Excel.exe', title, APPS);
      if (id !== null) fromTs.add(Number.parseInt(id, 10));
    }

    /**
     * ── Postgres's answer, using the production code itself.
     *
     * Both the correct numbers and the ones the wrong rule would produce are
     * asked for together, so it is caught in both directions: if a correct
     * one is lost, and if a wrong one slips in.
     */
    const probe = [...new Set([...fromTs, ...WRONG_IDS])];
    const fromSql = new Set((await onScreen.secondsFor(probe, APPS)).keys());

    expect([...fromSql].sort((a, b) => a - b)).toEqual(
      [...fromTs].sort((a, b) => a - b),
    );

    // Check that the list really filtered something — otherwise two empty
    // sets would match and the test would pass for no reason
    expect(fromTs.size).toBeGreaterThan(3);
    expect(fromTs.size).toBeLessThan(CORPUS.length);
  });

  /**
   * Whether the index is actually used.
   *
   * If the query text differs from the `migration.sql` text by a single
   * character, Postgres stops using the index, silently and with no error.
   *
   * `enable_seqscan = off` is needed because the test table is small —
   * Postgres would otherwise pick a sequential scan on cost and the test
   * would prove nothing. With it off, the question becomes simply whether
   * the index works for this expression, which is what we want to know.
   */
  it('the query text matches the index text (EXPLAIN)', async () => {
    const who = await assignee();
    await saw(who, today(), '1000042-Report.docx', 60);

    const plan = await h.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');

      /**
       * The query is built from the constant, not written by hand, and has
       * the same shape as `secondsFor()` (the number filter plus the app
       * filter). If it were handwritten the test would verify its own text,
       * not the code's, and would stay green even when `TASK_NUMBER_SQL`
       * changed.
       */
      const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT sum(duration_sec) FROM app_usage
         WHERE ${TASK_NUMBER_SQL_EXPR} IN ('1000042')
           AND lower(process_name) = ANY(ARRAY['excel.exe', 'winword.exe']::text[])`,
      );

      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });

    expect(plan).toContain(INDEX);

    /**
     * Seeing the index name is not enough — `Index Cond` must be checked.
     *
     * The index is partial (`WHERE <expression> IS NOT NULL`), so Postgres
     * could in principle use it as just a row source while `substring(...)`
     * is still recomputed from the heap.
     *
     * The only sign that the expression really sits in the index is
     * `Index Cond`; if it does not match, `Filter` appears there instead.
     */
    expect(plan).toContain('Index Cond');
  });
});

describe('on screen — how much time', () => {
  it('all rows of the same number add up, across several days too', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000042-Report.docx', 300);
    await saw(who, day, '1000042-Report.docx [Read-Only]', 120);
    await saw(who, dayBefore(day, 1), '1000042-Report.docx', 60);
    // A different number — must not mix in
    await saw(who, day, '1000043-Invoice.xlsx', 999);

    const secs = await onScreen.secondsFor([1_000_042, 1_000_043], APPS);

    expect(secs.get(1_000_042)).toBe(480);
    expect(secs.get(1_000_043)).toBe(999);
  });

  /**
   * The allow-list applies here too — titles from apps that are not listed
   * (a browser tab, say) are not counted.
   */
  it('titles from apps that are not listed are not counted', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000042-Report.docx', 300, 'chrome.exe');
    await saw(who, day, '1000042-Report.docx', 300, 'WINWORD.EXE');

    const secs = await onScreen.secondsFor([1_000_042], APPS);

    expect(secs.get(1_000_042)).toBe(300);
  });

  /** Windows reports the process name in whatever case it likes */
  it('the process name is matched case-insensitively', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000042-Report.docx', 100, 'winword.exe');
    await saw(who, day, '1000042-Report.docx', 200, 'WinWord.Exe');
    await saw(who, day, '1000042-Budget.xlsx', 400, 'EXCEL.EXE');

    const secs = await onScreen.secondsFor([1_000_042], APPS);

    expect(secs.get(1_000_042)).toBe(700);
  });

  it('a number never seen is not in the map — zero is not set', async () => {
    const who = await assignee();
    await saw(who, today(), '1000042-Report.docx', 300);

    const secs = await onScreen.secondsFor([1_000_042, 1_000_099], APPS);

    expect(secs.has(1_000_099)).toBe(false);
  });

  /** With no apps nothing is asked at all — an empty answer, not every app */
  it('with no apps, nothing is measured', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000042-Report.docx', 300);
    await task(who.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    expect((await onScreen.secondsFor([1_000_042], NO_APPS)).size).toBe(0);
    expect(await onScreen.unseenTaskNumbers(dayBefore(day, 1), NO_APPS)).toEqual([]);
  });
});

describe('on screen — three states in the list', () => {
  /**
   * The three states stay distinct — and the middle one is the reason for this work.
   */
  it('measured, never on screen, cannot say — three distinct states', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000042-Report.docx', 420);

    // a. has time
    await task(who.employeeId, 1_000_042, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    // b. no time, though it should have been known
    await task(who.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    // c. finished before title collection began — cannot say
    const old = dayBefore(day, 5);
    await task(who.employeeId, 1_000_044, {
      assignedAt: atWorkHour(old, 8),
      completedAt: atWorkHour(old, 17),
    });

    const page = await tasks.list({});
    const byNumber = new Map(page.rows.map((r) => [r.taskNumber, r.onScreenSec]));

    expect(byNumber.get(1_000_042)).toBe(420);
    expect(byNumber.get(1_000_043)).toBe(0);
    // The real claim: `null`, not `0` — otherwise older rows would silently
    // stand as "never on screen", which is a false accusation
    expect(byNumber.get(1_000_044)).toBeNull();

    expect(page.startDetection).toBe(true);
    expect(page.traceSince).toBe(day.toISOString().slice(0, 10));
  });

  /**
   * No "no trace" on work still in hand — that would be an accusation where
   * no claim had been made, next to every row handed out in the morning.
   */
  it('in hand, not yet on screen — `null`, not `0`', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000042-Report.docx', 60);
    await task(who.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
    });

    const page = await tasks.list({ status: 'assigned' });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].onScreenSec).toBeNull();
  });

  /** A row in hand can also show measured time — that is information */
  it('a row in hand shows its time if it has any', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000043-Invoice.xlsx', 240);
    await task(who.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
    });

    const page = await tasks.list({ status: 'assigned' });

    expect(page.rows[0].onScreenSec).toBe(240);
  });

  /**
   * No numbered title at all, yet `app_usage` is not empty — a different
   * path through the `no_file` filter, so a different claim.
   */
  it('no known number ever appeared on screen — the list still does not break', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, 'Document1 - Word', 300);
    await task(who.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    const page = await tasks.list({ stage: 'no_file' });

    expect(page.rows.map((r) => r.taskNumber)).toEqual([1_000_043]);
  });

  it('a pool row has no task number — its time is `null` too', async () => {
    const who = await assignee();
    await saw(who, today(), '1000042-Report.docx', 300);

    const owner = await h.prisma.user.findFirstOrThrow();
    await h.prisma.task.create({
      data: { reference: 'REF-POOL', status: 'pool', addedById: owner.id },
    });

    const page = await tasks.list({ status: 'pool' });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].onScreenSec).toBeNull();
  });
});

describe('on screen — the "said done but never on screen" list', () => {
  it('the row with no time appears, the one with time does not', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000042-Report.docx', 420);

    await task(who.employeeId, 1_000_042, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });
    await task(who.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    const page = await tasks.list({ stage: 'no_file' });

    expect(page.rows.map((r) => r.taskNumber)).toEqual([1_000_043]);
    expect(page.rows[0].onScreenSec).toBe(0);
  });

  /**
   * Time spent in an app that is not listed proves nothing here: the number
   * counts as never seen, exactly as for the column.
   */
  it('a number seen only in an app that is not listed still appears', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000043-Invoice.xlsx', 420, 'chrome.exe');
    await task(who.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    const page = await tasks.list({ stage: 'no_file' });

    expect(page.rows.map((r) => r.taskNumber)).toEqual([1_000_043]);
  });

  /**
   * A row not said to be done does not appear in the list.
   *
   * Work in hand not yet on screen is normal — that is not the question.
   * The list is only about claimed work.
   */
  it('a row in hand (assigned) does not appear in the list', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000042-Report.docx', 60);
    await task(who.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
    });

    const page = await tasks.list({ stage: 'no_file' });

    expect(page.rows).toHaveLength(0);
  });

  /**
   * The boundary is what keeps the list honest: rows finished before title
   * collection began would otherwise all become "no proof" — a list not
   * worth reading and, worse, a false accusation.
   */
  it('rows from before title collection began do not appear in the list', async () => {
    const who = await assignee();
    const day = today();

    await saw(who, day, '1000042-Report.docx', 60);

    const old = dayBefore(day, 5);
    await task(who.employeeId, 1_000_055, {
      assignedAt: atWorkHour(old, 8),
      completedAt: atWorkHour(old, 17),
    });

    const page = await tasks.list({ stage: 'no_file' });

    expect(page.rows).toHaveLength(0);
  });

  /**
   * With no titles collected at all the list is empty — not "everyone is guilty".
   */
  it('when `app_usage` is entirely empty nothing is said against anyone', async () => {
    const who = await assignee();
    const day = today();

    await task(who.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    const page = await tasks.list({ stage: 'no_file' });

    expect(page.traceSince).toBeNull();
    expect(page.rows).toHaveLength(0);
  });

  /** The per-person filter applies here too — the same list, for one person */
  it('works together with the staff filter', async () => {
    const a = await assignee('OX-OS1');
    const b = await assignee('OX-OS2');
    const day = today();

    await saw(a, day, '1000042-Report.docx', 60);

    await task(a.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });
    await task(b.employeeId, 1_000_044, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    const page = await tasks.list({
      stage: 'no_file',
      staffId: b.employeeId,
    });

    expect(page.rows.map((r) => r.taskNumber)).toEqual([1_000_044]);
  });
});

describe('on screen — start detection off', () => {
  /**
   * With no apps listed there is nothing to measure: the column is hidden
   * (`startDetection: false`), every value is `null` rather than `0`, and the
   * `no_file` question has no answer, so it returns nothing.
   */
  it('no apps listed: no time, no trace date, and no "never on screen" list', async () => {
    await h.prisma.setting.update({
      where: { key: TASKS_SETTING_KEY },
      data: { value: { startDetection: { apps: [] } } },
    });

    const who = await assignee();
    const day = today();

    await saw(who, day, '1000042-Report.docx', 420);
    await task(who.employeeId, 1_000_042, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });
    await task(who.employeeId, 1_000_043, {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    const page = await tasks.list({});

    expect(page.startDetection).toBe(false);
    expect(page.traceSince).toBeNull();
    expect(page.rows.map((r) => r.onScreenSec)).toEqual([null, null]);

    const unseen = await tasks.list({ stage: 'no_file' });
    expect(unseen.rows).toHaveLength(0);
  });
});
