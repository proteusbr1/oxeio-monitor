import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { localMidnightOf, nextLocalMidnight } from '../src/agent/util/work-time';
import {
  MAX_ISSUED_PER_DAY,
  POOL_PER_DESIGNER,
} from '../src/targets/targets.rules';
import { TargetsService } from '../src/targets/targets.service';
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
 * After 30 designs have been distributed to someone in a day (complete +
 * skip), top up their hand so they can still hit the daily target of 25. And
 * no designer may complete more than 25 designs in a day.
 *
 * Careful: the two rules pull in opposite directions, and that is the most
 * important claim in this file: once the target is reached the top-up must
 * stop. Otherwise the limit would say "don't finish any more" while the
 * top-up kept pouring in more work, filling the hand with work that can never
 * be touched today.
 *
 * This file has no pinned dates; everything is relative to `dhakaNoon()`.
 */
let h: Harness;
let targets: TargetsService;

const TARGET = 25;

beforeAll(async () => {
  h = await createHarness();
  targets = h.app.get(TargetsService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

async function person(
  code: string,
  staffType: 'designer' | 'manager',
  dailyDesignTarget: number | null = null,
): Promise<number> {
  const { employeeId } = await createEmployeeWithCode(h.prisma, code);

  /**
   * The policy is attached deliberately — the harness policy has
   * `dailyDesignTarget = 25`.
   *
   * Without it the manager claim would pass for the wrong reason: with no
   * policy, `designTargetOf()` returns 0 anyway, and removing
   * `hasDesignTarget()` would go unnoticed by the test. Sabotage testing
   * caught exactly that, so the claim was vacuous.
   */
  const policy = await h.prisma.workPolicy.findFirstOrThrow();

  await h.prisma.employee.update({
    where: { id: employeeId },
    data: { staffType, dailyDesignTarget, policyId: policy.id },
  });

  return employeeId;
}

let asinSeq = 0;
const nextAsin = () => `B${String(++asinSeq).padStart(9, '0')}`;

/** `n` targets in the pool — the top-up draws from here */
async function pool(n: number): Promise<void> {
  const owner = await h.prisma.user.findFirstOrThrow();

  await h.prisma.designTarget.createMany({
    data: Array.from({ length: n }, () => ({
      asin: nextAsin(),
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
    const row = await h.prisma.designTarget.create({
      data: {
        asin: nextAsin(),
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

/** `n` already finished in today's Dhaka day */
async function alreadyDone(employeeId: number, n: number, at: Date): Promise<void> {
  const owner = await h.prisma.user.findFirstOrThrow();

  for (let i = 0; i < n; i++) {
    await h.prisma.designTarget.create({
      data: {
        asin: nextAsin(),
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
  h.prisma.designTarget.count({
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
    const emp = await person('OX-Q1', 'designer', TARGET);

    await alreadyDone(emp, TARGET, now);
    const [id] = await inHand(emp, 1, now);

    await expect(targets.markDone(emp, id, 1, now)).rejects.toThrow(/already marked 25/i);

    const after = await h.prisma.designTarget.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('assigned');
    expect(after.completedAt).toBeNull();
  });

  it('serializes concurrent completions when only one daily slot remains', async () => {
    const now = workNoon();
    const emp = await person('OX-Q-RACE', 'designer', TARGET);
    const owner = await h.prisma.user.findFirstOrThrow();
    await alreadyDone(emp, TARGET - 1, now);
    const ids = await inHand(emp, 2, now);
    const results = await Promise.allSettled(
      ids.map((id) => targets.markDone(emp, id, owner.id, now)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await h.prisma.designTarget.count({
      where: { assignedToId: emp, status: 'done' },
    })).toBe(TARGET);
    expect(await openCountOf(emp)).toBe(1);
  });

  it('at 24, the 25th goes through', async () => {
    const now = workNoon();
    const emp = await person('OX-Q2', 'designer', TARGET);

    await alreadyDone(emp, TARGET - 1, now);
    const [id] = await inHand(emp, 1, now);

    await expect(targets.markDone(emp, id, 1, now)).resolves.toEqual({ ok: true });
  });

  /**
   * The manager has no limit.
   *
   * In the field OX-01 does up to 44 a day and has no target at all. A limit
   * would silently block their work, and no screen would say so.
   */
  it('someone with no target has no limit either', async () => {
    const now = workNoon();
    const emp = await person('OX-Q3', 'manager');

    await alreadyDone(emp, 40, now);
    const [id] = await inHand(emp, 1, now);

    await expect(targets.markDone(emp, id, 1, now)).resolves.toEqual({ ok: true });
  });

  /** A target of 0 means "target off", not a penalty — no limit applies either */
  it('with a target of 0 there is no limit', async () => {
    const now = workNoon();
    const emp = await person('OX-Q4', 'designer', 0);

    await alreadyDone(emp, 40, now);
    const [id] = await inHand(emp, 1, now);

    await expect(targets.markDone(emp, id, 1, now)).resolves.toEqual({ ok: true });
  });

  /**
   * The day is the Dhaka day, not the UTC day — the most repeated mistake in
   * this repo.
   *
   * If yesterday's 25 counted toward today, a designer would be blocked in
   * the morning. The fixture is placed at yesterday's Dhaka noon, and the
   * claim is that nothing is blocked today.
   */
  it('yesterday\'s "done" does not count toward today\'s limit', async () => {
    const now = workNoon();
    const yesterday = new Date(localMidnightOf(now).getTime() - 12 * 3600_000);
    const emp = await person('OX-Q5', 'designer', TARGET);

    await alreadyDone(emp, TARGET, yesterday);
    const [id] = await inHand(emp, 1, now);

    await expect(targets.markDone(emp, id, 1, now)).resolves.toEqual({ ok: true });
  });

  /**
   * The last hour of the Dhaka day is still today — by UTC it would fall on
   * tomorrow.
   *
   * 11 PM in Dhaka is 5 PM UTC of the same day; but if the `workDateOf()`
   * label were used directly as the boundary, the day would start at 6 AM and
   * work done at 11 PM would fall on the next day.
   */
  it('work at 11 PM Dhaka time falls within today\'s limit', async () => {
    const now = workNoon();
    const lateTonight = new Date(nextLocalMidnight(now).getTime() - 3600_000);
    const emp = await person('OX-Q6', 'designer', TARGET);

    await alreadyDone(emp, TARGET, lateTonight);
    const [id] = await inHand(emp, 1, lateTonight);

    await expect(targets.markDone(emp, id, 1, lateTonight)).rejects.toThrow(
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
    const emp = await person('OX-Q7', 'designer', TARGET);
    const owner = await h.prisma.user.findFirstOrThrow();

    await alreadyDone(emp, TARGET, now);
    const [id] = await inHand(emp, 1, now);

    await targets.update(id, 'done', now, owner.id);

    const after = await h.prisma.designTarget.findUniqueOrThrow({ where: { id } });
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
    const emp = await person('OX-Q8', 'designer', TARGET);

    await pool(50);
    await alreadyDone(emp, 9, now);
    const [last] = await inHand(emp, 1, now);

    await targets.markDone(emp, last, 1, now);

    // 10 done, 15 remaining -> ceil(15 x 30 / 25) = 18
    expect(await openCountOf(emp)).toBe(18);
  });

  /** Skipping also empties the hand — "complete + skip" in the owner's words */
  it('skipping the last target also refills the hand', async () => {
    const now = workNoon();
    const emp = await person('OX-Q9', 'designer', TARGET);

    await pool(50);
    const [last] = await inHand(emp, 1, now);

    await targets.skip(emp, last, 'not_found', now);

    expect(await openCountOf(emp)).toBe(POOL_PER_DESIGNER);
  });

  /**
   * Nothing is given when there is enough in hand — and in the field this is
   * the normal state: on 7 and 8 September everyone had 17-29 in hand.
   */
  it('no top-up when the hand is full', async () => {
    const now = workNoon();
    const emp = await person('OX-QA', 'designer', TARGET);

    await pool(50);
    const ids = await inHand(emp, POOL_PER_DESIGNER, now);

    await targets.markDone(emp, ids[0], 1, now);

    // One finished, 29 remain in hand — 29 is enough for the remaining 24
    expect(await openCountOf(emp)).toBe(POOL_PER_DESIGNER - 1);
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
    const emp = await person('OX-QB', 'designer', TARGET);

    await pool(50);
    await alreadyDone(emp, TARGET - 1, now);
    const [last] = await inHand(emp, 1, now);

    await targets.markDone(emp, last, 1, now);

    expect(await openCountOf(emp)).toBe(0);
  });

  /** The manager has no target — the morning distribution is enough for them */
  it('someone with no target gets no top-up either', async () => {
    const now = workNoon();
    const emp = await person('OX-QC', 'manager');

    await pool(50);
    const [last] = await inHand(emp, 1, now);

    await targets.markDone(emp, last, 1, now);

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
    const emp = await person('OX-QD', 'designer', TARGET);

    const [last] = await inHand(emp, 1, now);

    await expect(targets.markDone(emp, last, 1, now)).resolves.toEqual({ ok: true });
    expect(await openCountOf(emp)).toBe(0);
  });


  /**
   * Early morning — the hours when the limit would silently switch off.
   *
   * `workDateOf()` writes the Dhaka day as a UTC midnight, i.e. 6 AM Dhaka
   * time. Using that as the boundary, between 12 AM and 6 AM the start of the
   * count would fall in the future, the number would come out zero, and the
   * limit would be completely off — anyone could finish as many as they liked
   * in those six hours.
   */
  it('the count for today is still right at 3 AM Dhaka time', async () => {
    const now = workNoon();
    const at3am = new Date(localMidnightOf(now).getTime() + 3 * 3600_000);
    const emp = await person('OX-QF', 'designer', TARGET);

    await alreadyDone(emp, TARGET, at3am);
    const [id] = await inHand(emp, 1, at3am);

    await expect(targets.markDone(emp, id, 1, at3am)).rejects.toThrow(
      /already marked 25/i,
    );
  });

  /**
   * The daily ceiling holds in the field too — skipping one after another
   * must not let the pool be mined without limit.
   */
  it('once 60 have been issued, there is no more top-up', async () => {
    const now = workNoon();
    const emp = await person('OX-QG', 'designer', TARGET);

    await pool(50);
    // Already issued today up to the ceiling
    const ids = await inHand(emp, MAX_ISSUED_PER_DAY, now);
    await h.prisma.designTarget.updateMany({
      where: { id: { in: ids.slice(1) } },
      data: { status: 'skipped', dropReason: 'not_found' },
    });

    await targets.skip(emp, ids[0], 'not_found', now);

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
    const emp = await person('OX-QH', 'designer', TARGET);

    await pool(50);
    expect(await openCountOf(emp)).toBe(0);

    await targets.topUpAll(now);

    expect(await openCountOf(emp)).toBe(POOL_PER_DESIGNER);
  });

  /** The tick is idempotent — with a full hand a second run changes nothing */
  it('however often the tick runs, the hand never exceeds 30', async () => {
    const now = workNoon();
    const emp = await person('OX-QI', 'designer', TARGET);

    await pool(80);
    await targets.topUpAll(now);
    await targets.topUpAll(now);
    await targets.topUpAll(now);

    expect(await openCountOf(emp)).toBe(POOL_PER_DESIGNER);
  });

  /** Only as many as the pool has — the rest are not silently created */
  it('with a short pool, only as many as exist', async () => {
    const now = workNoon();
    const emp = await person('OX-QE', 'designer', TARGET);

    await pool(4);
    const [last] = await inHand(emp, 1, now);

    await targets.markDone(emp, last, 1, now);

    expect(await openCountOf(emp)).toBe(4);
  });
});
