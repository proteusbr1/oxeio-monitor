import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { localMidnightOf, nextLocalMidnight } from '../src/agent/util/work-time';
import {
  MAX_ISSUED_PER_DAY,
  POOL_PER_ASSIGNEE,
} from '../src/tasks/tasks.rules';
import { TasksService } from '../src/tasks/tasks.service';
import {
  createEmployeeWithCode,
  createHarness,
  workNoon,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * Two daily limits (the owner's rule).
 *
 * After 30 tasks have been handed to someone in a day (complete + skip),
 * top up their hand so they can still hit the daily target of 25. And nobody
 * held to a target may complete more than 25 tasks in a day.
 *
 * Careful: the two rules pull in opposite directions, and that is the most
 * important claim in this file: once the target is reached the top-up must
 * stop. Otherwise the limit would say "don't finish any more" while the
 * top-up kept pouring in more work, filling the hand with work that can never
 * be touched today.
 *
 * This file has no pinned dates; everything is relative to `workNoon()`.
 */
let h: Harness;
let tasks: TasksService;

const TARGET = 25;

beforeAll(async () => {
  h = await createHarness();
  tasks = h.app.get(TasksService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

/**
 * Someone who receives tasks (unless `receivesTasks` is false), with their
 * own daily target (`null` = the policy's 25).
 */
async function person(
  code: string,
  dailyTaskTarget: number | null = null,
  receivesTasks = true,
): Promise<number> {
  const { employeeId } = await createEmployeeWithCode(h.prisma, code);

  /**
   * The policy is attached deliberately — the harness policy has
   * `dailyTaskTarget = 25`.
   *
   * Without it the "no target" claims would pass for the wrong reason: with
   * no policy, `taskTargetOf()` returns 0 anyway, and removing
   * `hasTaskTarget()` would go unnoticed by the test. Sabotage testing
   * caught exactly that, so the claim was vacuous.
   */
  const policy = await h.prisma.workPolicy.findFirstOrThrow();

  await h.prisma.employee.update({
    where: { id: employeeId },
    data: { receivesTasks, dailyTaskTarget, policyId: policy.id },
  });

  return employeeId;
}

let refSeq = 0;
const nextRef = () => `REF-${String(++refSeq).padStart(5, '0')}`;

/** `n` tasks in the pool — the top-up draws from here */
async function pool(n: number): Promise<void> {
  const owner = await h.prisma.user.findFirstOrThrow();

  await h.prisma.task.createMany({
    data: Array.from({ length: n }, () => ({
      reference: nextRef(),
      status: 'pool' as const,
      addedById: owner.id,
    })),
  });
}

/** `n` in that staff member's hand — returns their ids */
async function inHand(employeeId: number, n: number, at: Date): Promise<number[]> {
  const owner = await h.prisma.user.findFirstOrThrow();
  const ids: number[] = [];

  for (let i = 0; i < n; i++) {
    const row = await h.prisma.task.create({
      data: {
        reference: nextRef(),
        status: 'assigned',
        assignedToId: employeeId,
        assignedAt: at,
        addedById: owner.id,
      },
    });
    ids.push(row.id);
  }

  return ids;
}

/** `n` already finished in today's work day */
async function alreadyDone(employeeId: number, n: number, at: Date): Promise<void> {
  const owner = await h.prisma.user.findFirstOrThrow();

  for (let i = 0; i < n; i++) {
    await h.prisma.task.create({
      data: {
        reference: nextRef(),
        status: 'done',
        assignedToId: employeeId,
        assignedAt: at,
        completedAt: at,
        completedVia: 'manual',
        completedById: owner.id,
        addedById: owner.id,
      },
    });
  }
}

const openCountOf = (employeeId: number) =>
  h.prisma.task.count({
    where: { assignedToId: employeeId, status: 'assigned' },
  });

describe('daily limit — cannot finish more than 25', () => {
  /**
   * The main claim of this file.
   *
   * The companion claim is just as important: the row stays in the hand. If
   * it were deleted or went back to the pool, real work done would be lost.
   */
  it('once 25 are done the 26th is blocked, and the row stays in the hand', async () => {
    const now = workNoon();
    const emp = await person('OX-Q1', TARGET);

    await alreadyDone(emp, TARGET, now);
    const [id] = await inHand(emp, 1, now);

    await expect(tasks.markDone(emp, id, 1, now)).rejects.toThrow(/already marked 25/i);

    const after = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('assigned');
    expect(after.completedAt).toBeNull();
  });

  it('serializes concurrent completions when only one daily slot remains', async () => {
    const now = workNoon();
    const emp = await person('OX-Q-RACE', TARGET);
    const owner = await h.prisma.user.findFirstOrThrow();
    await alreadyDone(emp, TARGET - 1, now);
    const ids = await inHand(emp, 2, now);
    const results = await Promise.allSettled(
      ids.map((id) => tasks.markDone(emp, id, owner.id, now)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await h.prisma.task.count({
      where: { assignedToId: emp, status: 'done' },
    })).toBe(TARGET);
    expect(await openCountOf(emp)).toBe(1);
  });

  it('at 24, the 25th goes through', async () => {
    const now = workNoon();
    const emp = await person('OX-Q2', TARGET);

    await alreadyDone(emp, TARGET - 1, now);
    const [id] = await inHand(emp, 1, now);

    await expect(tasks.markDone(emp, id, 1, now)).resolves.toEqual({ ok: true });
  });

  /**
   * Someone who receives tasks with a target of 0 (typically a manager who
   * takes work on the days they have time) has no limit.
   *
   * They may finish 40 in a day with no target at all. A limit would
   * silently block their work, and no screen would say so.
   */
  it('someone who receives tasks with a target of 0 has no limit', async () => {
    const now = workNoon();
    const emp = await person('OX-Q3', 0);

    await alreadyDone(emp, 40, now);
    const [id] = await inHand(emp, 1, now);

    await expect(tasks.markDone(emp, id, 1, now)).resolves.toEqual({ ok: true });
  });

  /**
   * Not receiving tasks means the measure is not theirs: the policy's 25
   * must not turn into a limit for them (`receivesTasks` gates the target).
   */
  it('someone who does not receive tasks has no limit, whatever the policy says', async () => {
    const now = workNoon();
    const emp = await person('OX-Q4', null, false);

    await alreadyDone(emp, 40, now);
    const [id] = await inHand(emp, 1, now);

    await expect(tasks.markDone(emp, id, 1, now)).resolves.toEqual({ ok: true });
  });

  /**
   * The day is the work day, not the UTC day — the most repeated mistake in
   * this repo.
   *
   * If yesterday's 25 counted toward today, a person would be blocked in
   * the morning. The fixture is placed at yesterday's local noon, and the
   * claim is that nothing is blocked today.
   */
  it('yesterday\'s "done" does not count toward today\'s limit', async () => {
    const now = workNoon();
    const yesterday = new Date(localMidnightOf(now).getTime() - 12 * 3600_000);
    const emp = await person('OX-Q5', TARGET);

    await alreadyDone(emp, TARGET, yesterday);
    const [id] = await inHand(emp, 1, now);

    await expect(tasks.markDone(emp, id, 1, now)).resolves.toEqual({ ok: true });
  });

  /**
   * The last hour of the work day is still today — by UTC it would fall on
   * tomorrow.
   *
   * 11 PM in the work zone (UTC+6) is 5 PM UTC of the same day; but if the `workDateOf()`
   * label were used directly as the boundary, the day would start at 6 AM and
   * work done at 11 PM would fall on the next day.
   */
  it('work at 11 PM work-zone time falls within today\'s limit', async () => {
    const now = workNoon();
    const lateTonight = new Date(nextLocalMidnight(now).getTime() - 3600_000);
    const emp = await person('OX-Q6', TARGET);

    await alreadyDone(emp, TARGET, lateTonight);
    const [id] = await inHand(emp, 1, lateTonight);

    await expect(tasks.markDone(emp, id, 1, lateTonight)).rejects.toThrow(
      /already marked 25/i,
    );
  });

  /**
   * The owner/manager path is not blocked (deliberate).
   *
   * Otherwise there would be no way to correct a mistake. Who pressed it is
   * recorded anyway in `completed_by_id`.
   */
  it('the limit does not apply on the owner\'s `update()` path', async () => {
    const now = workNoon();
    const emp = await person('OX-Q7', TARGET);
    const owner = await h.prisma.user.findFirstOrThrow();

    await alreadyDone(emp, TARGET, now);
    const [id] = await inHand(emp, 1, now);

    await tasks.update(id, 'done', now, owner.id);

    const after = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('done');
  });
});

describe('top-up — keeping enough work in hand to reach the target', () => {
  /**
   * The situation the owner described: everything in hand is done, yet 25 is
   * not reached.
   *
   * 10 done, nothing left in hand -> 18 for the remaining 15, at a 30:25 ratio.
   */
  it('finishing the last target refills the hand', async () => {
    const now = workNoon();
    const emp = await person('OX-Q8', TARGET);

    await pool(50);
    await alreadyDone(emp, 9, now);
    const [last] = await inHand(emp, 1, now);

    await tasks.markDone(emp, last, 1, now);

    // 10 done, 15 remaining -> ceil(15 x 30 / 25) = 18
    expect(await openCountOf(emp)).toBe(18);
  });

  /** Skipping also empties the hand — "complete + skip" in the owner's words */
  it('skipping the last target also refills the hand', async () => {
    const now = workNoon();
    const emp = await person('OX-Q9', TARGET);

    await pool(50);
    const [last] = await inHand(emp, 1, now);

    await tasks.skip(emp, last, 'not_needed', now);

    expect(await openCountOf(emp)).toBe(POOL_PER_ASSIGNEE);
  });

  /**
   * Nothing is given when there is enough in hand — and in the field this is
   * the normal state: on 7 and 8 September everyone had 17-29 in hand.
   */
  it('no top-up when the hand is full', async () => {
    const now = workNoon();
    const emp = await person('OX-QA', TARGET);

    await pool(50);
    const ids = await inHand(emp, POOL_PER_ASSIGNEE, now);

    await tasks.markDone(emp, ids[0], 1, now);

    // One finished, 29 remain in hand — 29 is enough for the remaining 24
    expect(await openCountOf(emp)).toBe(POOL_PER_ASSIGNEE - 1);
  });

  /**
   * This is where the clash of the two rules is settled.
   *
   * Once the target is reached the top-up stops — otherwise the limit would
   * say "don't finish any more" and the top-up would fill the hand with work
   * that can never be touched today.
   */
  it('after reaching 25, nothing more is given even when the hand is empty', async () => {
    const now = workNoon();
    const emp = await person('OX-QB', TARGET);

    await pool(50);
    await alreadyDone(emp, TARGET - 1, now);
    const [last] = await inHand(emp, 1, now);

    await tasks.markDone(emp, last, 1, now);

    expect(await openCountOf(emp)).toBe(0);
  });

  /** No target (0) — the morning distribution is enough for them */
  it('someone with a target of 0 gets no top-up either', async () => {
    const now = workNoon();
    const emp = await person('OX-QC', 0);

    await pool(50);
    const [last] = await inHand(emp, 1, now);

    await tasks.markDone(emp, last, 1, now);

    expect(await openCountOf(emp)).toBe(0);
  });

  /**
   * An empty pool must not make the "I finished" press fail.
   *
   * The top-up is a convenience, not a condition. If it threw, on the day the
   * pool ran out nobody could mark their work as done.
   */
  it('the pool is empty — the work is still completed', async () => {
    const now = workNoon();
    const emp = await person('OX-QD', TARGET);

    const [last] = await inHand(emp, 1, now);

    await expect(tasks.markDone(emp, last, 1, now)).resolves.toEqual({ ok: true });
    expect(await openCountOf(emp)).toBe(0);
  });


  /**
   * Early morning — the hours when the limit would silently switch off.
   *
   * `workDateOf()` writes the work-zone day as a UTC midnight, i.e. 6 AM
   * work-zone time. Using that as the boundary, between 12 AM and 6 AM the start of the
   * count would fall in the future, the number would come out zero, and the
   * limit would be completely off — anyone could finish as many as they liked
   * in those six hours.
   */
  it('the count for today is still right at 3 AM work-zone time', async () => {
    const now = workNoon();
    const at3am = new Date(localMidnightOf(now).getTime() + 3 * 3600_000);
    const emp = await person('OX-QF', TARGET);

    await alreadyDone(emp, TARGET, at3am);
    const [id] = await inHand(emp, 1, at3am);

    await expect(tasks.markDone(emp, id, 1, at3am)).rejects.toThrow(
      /already marked 25/i,
    );
  });

  /**
   * The daily ceiling holds in the field too — skipping one after another
   * must not let the pool be mined without limit.
   */
  it('once 60 have been issued, there is no more top-up', async () => {
    const now = workNoon();
    const emp = await person('OX-QG', TARGET);

    await pool(50);
    // Already issued today up to the ceiling
    const ids = await inHand(emp, MAX_ISSUED_PER_DAY, now);
    await h.prisma.task.updateMany({
      where: { id: { in: ids.slice(1) } },
      data: { status: 'skipped', dropReason: 'not_needed' },
    });

    await tasks.skip(emp, ids[0], 'not_needed', now);

    expect(await openCountOf(emp)).toBe(0);
  });

  /**
   * Someone with nothing in hand cannot press anything.
   *
   * A top-up run immediately on an event (after `markDone`/`skip`) cannot
   * reach exactly the person the owner described. In the field that happens
   * when the pool is short in the morning: `allocationSizes` goes in
   * staff-code order and the last person gets nothing. That is why the hourly
   * tick is needed separately.
   */
  it('with an empty hand, the hourly tick is the only hope', async () => {
    const now = workNoon();
    const emp = await person('OX-QH', TARGET);

    await pool(50);
    expect(await openCountOf(emp)).toBe(0);

    await tasks.topUpAll(now);

    expect(await openCountOf(emp)).toBe(POOL_PER_ASSIGNEE);
  });

  /** The hourly tick only looks at people who receive tasks */
  it('the hourly tick gives nothing to someone who does not receive tasks', async () => {
    const now = workNoon();
    const emp = await person('OX-QJ', null, false);

    await pool(50);
    await tasks.topUpAll(now);

    expect(await openCountOf(emp)).toBe(0);
  });

  /** The tick is idempotent — with a full hand a second run changes nothing */
  it('however often the tick runs, the hand never exceeds 30', async () => {
    const now = workNoon();
    const emp = await person('OX-QI', TARGET);

    await pool(80);
    await tasks.topUpAll(now);
    await tasks.topUpAll(now);
    await tasks.topUpAll(now);

    expect(await openCountOf(emp)).toBe(POOL_PER_ASSIGNEE);
  });

  /** Only as many as the pool has — the rest are not silently created */
  it('with a short pool, only as many as exist', async () => {
    const now = workNoon();
    const emp = await person('OX-QE', TARGET);

    await pool(4);
    const [last] = await inHand(emp, 1, now);

    await tasks.markDone(emp, last, 1, now);

    expect(await openCountOf(emp)).toBe(4);
  });
});
