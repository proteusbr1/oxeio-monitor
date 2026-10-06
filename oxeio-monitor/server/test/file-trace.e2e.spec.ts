import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import {
  DESIGN_APPS_SQL,
  DESIGN_ID_SQL_EXPR,
  designIdOf,
} from '../src/summary/design.rules';
import { FileTraceService } from '../src/targets/file-trace.service';
import { TargetsService } from '../src/targets/targets.service';
import {
  createEmployeeWithCode,
  createHarness,
  workNoon,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * Measuring beside the claim (9 September 2026) — the target's "done" mark
 * is the staff member's own click, and until now there was nothing next to it.
 *
 * What this file guards is not a bug but a risk. The answer to "how much time
 * went into the file for this job number" has to be computed in the database,
 * so the `DESIGN_ID` rule is written in two languages, TypeScript and SQL.
 * This repo's most familiar failure is exactly that: changing one place and
 * not the other.
 *
 * So the first two tests below block the two ways the copy can break:
 *   a. whether the two rules give the same result on the same list
 *   b. whether the SQL text matches the index in `migration.sql`
 *      (if not there is no error — every page just takes 1.5 seconds)
 */
let h: Harness;
let trace: FileTraceService;
let targets: TargetsService;

const HOUR_MS = 3600_000;
/** Dhaka is UTC+6 — subtract this to go from the label to the real instant */
const WORK_OFFSET_MS = 6 * HOUR_MS;

const INDEX = 'app_usage_design_id_idx';

beforeAll(async () => {
  h = await createHarness();
  trace = h.app.get(FileTraceService);
  targets = h.app.get(TargetsService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

const today = () => workDateOf(workNoon());
const dayBefore = (label: Date, days: number): Date =>
  new Date(label.getTime() - days * 86_400_000);
const atWorkHour = (dayLabel: Date, hour: number): Date =>
  new Date(dayLabel.getTime() - WORK_OFFSET_MS + hour * HOUR_MS);

async function designer(code = 'OX-FT1'): Promise<{
  employeeId: number;
  deviceId: number;
}> {
  const { employeeId } = await createEmployeeWithCode(h.prisma, code);

  await h.prisma.employee.update({
    where: { id: employeeId },
    data: { staffType: 'designer' },
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
  process = 'Illustrator.exe',
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

async function target(
  employeeId: number,
  jobNumber: number,
  asin: string,
  when: { assignedAt: Date; completedAt?: Date },
): Promise<number> {
  const owner = await h.prisma.user.findFirstOrThrow();

  const row = await h.prisma.designTarget.create({
    data: {
      asin,
      jobNumber,
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
 * Hard titles taken from the field — each one has a comment saying why it is here.
 *
 * This list is the judge between the two rules, so no easy cases are kept:
 * every row is some boundary.
 */
const CORPUS: readonly string[] = [
  // The real pattern — an old five-digit job number
  '37933-Woodcock Bird Vintage Illustration T-Shirt.ai @ 54 % (RGB/Preview)',
  // Seven digits, two side by side — without the boundary both would become `100004`
  '1000042-Bird.ai',
  '1000043-Cat.ai',
  // An eight-digit stock id — dropped by the boundary check
  '10163372_181.eps',
  // One digit — dropped by the "not fewer than three" rule
  '4 [Converted].eps',
  // Two digits are dropped too
  '12-Something.ai',
  // Three digits — exactly at the boundary, so it is kept
  '123-Small Job.ai',
  // Does not start with a digit
  'Untitled-20* @ 66.67 % (RGB/Preview)',
  'Template.ai',
  // Known false positive — it takes the year as a number. Both rules must
  // be wrong in the same way, otherwise the two counts would diverge.
  '2026 Calendar Design.ai',
  // Leading blanks — `.trim()` in TS, `btrim()` in SQL
  '   1050968-Trim Me.ai',
  // Seven digits then an underscore — the boundary is not a digit, so the number is kept
  '1050918_OL5I.psd',
];

/**
 * Numbers that only a broken rule could produce.
 *
 * No title in the list above should produce these — if one does, the SQL
 * rule has drifted:
 *   - `100004`  — cutting `1000042` to six digits when there is no boundary check
 *   - `1016337` — from `10163372_181.eps`, without `(?![0-9])`
 *   - `4`, `12` — if the "not fewer than three" rule is loosened
 */
const WRONG_IDS: readonly number[] = [100004, 1016337, 105091, 4, 12];

describe('file mark — SQL and TypeScript use the same rule', () => {
  /**
   * The most important test in this file.
   *
   * `DESIGN_ID` (TypeScript) and `DESIGN_ID_SQL` (Postgres): change one and
   * not the other and the credit count and the file mark silently diverge.
   * No error is raised; two screens just say two different things.
   */
  it('the two rules give exactly the same result on the hard-title list', async () => {
    const who = await designer();
    const day = today();

    for (const title of CORPUS) await saw(who, day, title, 60);

    // ── TypeScript's answer
    const fromTs = new Set<number>();
    for (const title of CORPUS) {
      const id = designIdOf('Illustrator.exe', title);
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
    const fromSql = new Set((await trace.secondsFor(probe)).keys());

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
   * character, Postgres stops using the index, silently and with no error. In
   * the field that cost 1.47 seconds per page.
   *
   * `enable_seqscan = off` is needed because the test table is small —
   * Postgres would otherwise pick a sequential scan on cost and the test
   * would prove nothing. With it off, the question becomes simply whether
   * the index works for this expression, which is what we want to know.
   */
  it('the query text matches the index text (EXPLAIN)', async () => {
    const who = await designer();
    await saw(who, today(), '1000042-Bird.ai', 60);

    const plan = await h.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');

      /**
       * The query is built from the two constants, not written by hand. If
       * it were handwritten the test would verify its own text, not the
       * code's, and would stay green even when `DESIGN_ID_SQL` changed.
       * Sabotage testing caught exactly that (9 September).
       */
      const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT sum(duration_sec) FROM app_usage
         WHERE ${DESIGN_APPS_SQL} AND ${DESIGN_ID_SQL_EXPR} IN ('1000042')`,
      );

      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });

    expect(plan).toContain(INDEX);

    /**
     * Seeing the index name is not enough — `Index Cond` must be checked.
     *
     * The index is partial (`WHERE lower(process_name) IN ...`), so whether
     * or not the expression matches, Postgres can use it as just a row
     * filter — the name then appears in the plan while `substring(...)` is
     * still recomputed from the heap.
     *
     * The only sign that the expression really sits in the index is
     * `Index Cond`; if it does not match, `Filter` appears there instead.
     * At first this test only looked at the name and stayed green under
     * sabotage (9 September) — the claim was vacuous.
     */
    expect(plan).toContain('Index Cond');
  });
});

describe('file mark — how much time', () => {
  it('all rows of the same number add up, across several days too', async () => {
    const who = await designer();
    const day = today();

    await saw(who, day, '1000042-Bird.ai', 300);
    await saw(who, day, '1000042-Bird.ai @ 200 %', 120);
    await saw(who, dayBefore(day, 1), '1000042-Bird.ai', 60);
    // A different number — must not mix in
    await saw(who, day, '1000043-Cat.ai', 999);

    const secs = await trace.secondsFor([1_000_042, 1_000_043]);

    expect(secs.get(1_000_042)).toBe(480);
    expect(secs.get(1_000_043)).toBe(999);
  });

  /**
   * The allow-list applies here too — browser titles are not counted.
   *
   * Otherwise one day someone's browser tab name would enter this
   * calculation, which is exactly the content reading the README says is "never" done.
   */
  it('titles from apps other than design apps are not counted', async () => {
    const who = await designer();
    const day = today();

    await saw(who, day, '1000042-Bird.ai', 300, 'chrome.exe');
    await saw(who, day, '1000042-Bird.ai', 300, 'Photoshop.exe');

    const secs = await trace.secondsFor([1_000_042]);

    expect(secs.get(1_000_042)).toBe(300);
  });

  it('a number never seen is not in the map — zero is not set', async () => {
    const who = await designer();
    await saw(who, today(), '1000042-Bird.ai', 300);

    const secs = await trace.secondsFor([1_000_042, 1_000_099]);

    expect(secs.has(1_000_099)).toBe(false);
  });
});

describe('file mark — three states in the list', () => {
  /**
   * The three states stay distinct — and the middle one is the reason for this work.
   */
  it('measured, never opened, cannot say — three distinct states', async () => {
    const who = await designer();
    const day = today();

    await saw(who, day, '1000042-Bird.ai', 420);

    // a. has a mark
    await target(who.employeeId, 1_000_042, 'B000000042', {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    // b. no mark, though it should have been known
    await target(who.employeeId, 1_000_043, 'B000000043', {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    // c. finished before title collection began — cannot say
    const old = dayBefore(day, 5);
    await target(who.employeeId, 1_000_044, 'B000000044', {
      assignedAt: atWorkHour(old, 8),
      completedAt: atWorkHour(old, 17),
    });

    const page = await targets.list({});
    const byJob = new Map(page.rows.map((r) => [r.jobNumber, r.fileSec]));

    expect(byJob.get(1_000_042)).toBe(420);
    expect(byJob.get(1_000_043)).toBe(0);
    // The real claim: `null`, not `0` — otherwise 2025's rows would silently
    // stand as "never opened", which is a false accusation
    expect(byJob.get(1_000_044)).toBeNull();

    expect(page.traceSince).toBe(day.toISOString().slice(0, 10));
  });

  /**
   * No "no trace" on work still in hand.
   *
   * The first version set it, which was an accusation where no claim had been
   * made — next to every one of the 30 rows assigned in the morning.
   */
  it('in hand, not yet opened — `null`, not `0`', async () => {
    const who = await designer();
    const day = today();

    await saw(who, day, '1000042-Bird.ai', 60);
    await target(who.employeeId, 1_000_043, 'B000000043', {
      assignedAt: atWorkHour(day, 8),
    });

    const page = await targets.list({ status: 'assigned' });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].fileSec).toBeNull();
  });

  /** A row in hand can also show measured time — that is information */
  it('a row in hand shows its time if it has any', async () => {
    const who = await designer();
    const day = today();

    await saw(who, day, '1000043-Cat.ai', 240);
    await target(who.employeeId, 1_000_043, 'B000000043', {
      assignedAt: atWorkHour(day, 8),
    });

    const page = await targets.list({ status: 'assigned' });

    expect(page.rows[0].fileSec).toBe(240);
  });

  /**
   * No design title at all, yet `app_usage` is not empty.
   *
   * `seenJobNumbers()` then returns an empty list, which goes to Prisma as
   * `notIn: []` — a different path, so a different claim.
   */
  it('no known number ever appeared on screen — the list still does not break', async () => {
    const who = await designer();
    const day = today();

    await saw(who, day, 'Untitled-20* @ 66.67 %', 300);
    await target(who.employeeId, 1_000_043, 'B000000043', {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    const page = await targets.list({ stage: 'no_file' });

    expect(page.rows.map((r) => r.jobNumber)).toEqual([1_000_043]);
  });

  it('a pool row has no job number — its mark is `null` too', async () => {
    const who = await designer();
    await saw(who, today(), '1000042-Bird.ai', 300);

    const owner = await h.prisma.user.findFirstOrThrow();
    await h.prisma.designTarget.create({
      data: { asin: 'B000000077', status: 'pool', addedById: owner.id },
    });

    const page = await targets.list({ status: 'pool' });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].fileSec).toBeNull();
  });
});

describe('file mark — the "said done but never opened" list', () => {
  /**
   * The list the owner asked for (9 September: "make list kha").
   */
  it('the row with no mark appears, the one with a mark does not', async () => {
    const who = await designer();
    const day = today();

    await saw(who, day, '1000042-Bird.ai', 420);

    await target(who.employeeId, 1_000_042, 'B000000042', {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });
    await target(who.employeeId, 1_000_043, 'B000000043', {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    const page = await targets.list({ stage: 'no_file' });

    expect(page.rows.map((r) => r.jobNumber)).toEqual([1_000_043]);
    expect(page.rows[0].fileSec).toBe(0);
  });

  /**
   * A row not said to be done does not appear in the list.
   *
   * It is normal for the file of work in hand not to be opened yet — that is
   * not the question. The list is only about claimed work.
   */
  it('a row in hand (assigned) does not appear in the list', async () => {
    const who = await designer();
    const day = today();

    await saw(who, day, '1000042-Bird.ai', 60);
    await target(who.employeeId, 1_000_043, 'B000000043', {
      assignedAt: atWorkHour(day, 8),
    });

    const page = await targets.list({ stage: 'no_file' });

    expect(page.rows).toHaveLength(0);
  });

  /**
   * The boundary is what keeps the list honest.
   *
   * If rows finished before title collection began came in here, the field's
   * 27 thousand old imported rows would all become "no proof" — a list not
   * worth reading and, worse, a false accusation.
   */
  it('rows from before title collection began do not appear in the list', async () => {
    const who = await designer();
    const day = today();

    await saw(who, day, '1000042-Bird.ai', 60);

    const old = dayBefore(day, 5);
    await target(who.employeeId, 1_000_055, 'B000000055', {
      assignedAt: atWorkHour(old, 8),
      completedAt: atWorkHour(old, 17),
    });

    const page = await targets.list({ stage: 'no_file' });

    expect(page.rows).toHaveLength(0);
  });

  /**
   * With no titles collected at all the list is empty — not "everyone is guilty".
   */
  it('when `app_usage` is entirely empty nothing is said against anyone', async () => {
    const who = await designer();
    const day = today();

    await target(who.employeeId, 1_000_043, 'B000000043', {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    const page = await targets.list({ stage: 'no_file' });

    expect(page.traceSince).toBeNull();
    expect(page.rows).toHaveLength(0);
  });

  /**
   * The per-designer filter applies here too — the same list, for one person.
   */
  it('works together with the staff filter', async () => {
    const a = await designer('OX-FT1');
    const b = await designer('OX-FT2');
    const day = today();

    await saw(a, day, '1000042-Bird.ai', 60);

    await target(a.employeeId, 1_000_043, 'B000000043', {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });
    await target(b.employeeId, 1_000_044, 'B000000044', {
      assignedAt: atWorkHour(day, 8),
      completedAt: atWorkHour(day, 17),
    });

    const page = await targets.list({
      stage: 'no_file',
      staffId: b.employeeId,
    });

    expect(page.rows.map((r) => r.jobNumber)).toEqual([1_000_044]);
  });
});
