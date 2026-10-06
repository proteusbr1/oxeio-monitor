import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/dhaka-time';
import { TargetsService } from '../src/targets/targets.service';
import { JOB_NUMBER_START } from '../src/targets/targets.rules';
import {
  createHarness,
  hashPassword,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
  dhakaNoon,
} from './setup/harness';

/**
 * **Design targets — submission and allocation.**
 *
 * The two most important claims of this file:
 * 1. **A researcher can submit, an ordinary designer cannot** — and both have
 *    the portal role `employee`, so the ordinary role guard could not do this.
 * 2. **A target never lands in two people's hands** — otherwise two people
 *    would make the same design and nobody could tell.
 */

let h: Harness;

const URL_OF = (n: number) =>
  `https://www.amazon.com/dp/B${String(n).padStart(9, '0')}`;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

/** Employee + portal account — with the staff type */
/**
 * Employee + portal account.
 *
 * Both `staffType` and `role` are taken, and that is the whole point of this
 * helper: they are different things. `staffType` says **what work they do**,
 * `role` says **what they can see**. The tests below deliberately try the two
 * in matching and mismatching combinations.
 */
async function staff(
  empCode: string,
  staffType: 'designer' | 'researcher' | 'manager',
  email: string,
  role: 'employee' | 'researcher' = 'employee',
) {
  const employee = await h.prisma.employee.create({
    data: { empCode, fullName: empCode, staffType, status: 'active' },
  });

  await h.prisma.user.create({
    data: {
      email,
      fullName: empCode,
      passwordHash: await hashPassword('staff-password-123'),
      role,
      employeeId: employee.id,
      // Without `false` they would be stuck at the "change password" wall after login
      mustChangePw: false,
    },
  });

  return employee;
}

const post = (session: Session, path: string, body: object) =>
  session.http.post(path).set('X-CSRF-Token', session.csrf).send(body);

// ════════════════════════════════════════════════════════════════════════════

describe('POST /design-targets/bulk — who may submit', () => {
  /**
   * **This describe was flipped around, and the history is useful.**
   *
   * It used to say: *"Researcher and designer both have the portal role
   * `employee` — so letting one in and keeping the other out with `@Roles()` is
   * **impossible**. The permission follows the type of work."*
   *
   * The owner then removed that very foundation: researcher and designer do
   * different work, so their access should differ too. Now the researcher is a
   * **role**, and the permission follows the role.
   */
  it('a researcher (role) may', async () => {
    await staff('OX-R1', 'researcher', 'r1@test.local', 'researcher');
    const session = await loginReady(h, 'r1@test.local', 'staff-password-123');

    const res = await post(session, '/api/v1/design-targets/bulk', {
      text: [URL_OF(1), URL_OF(2)].join('\n'),
    }).expect(201);

    expect(res.body.added).toBe(2);
    expect(res.body.poolSize).toBe(2);
  });

  it('a designer may not', async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');
    const session = await loginReady(h, 'd1@test.local', 'staff-password-123');

    await post(session, '/api/v1/design-targets/bulk', {
      text: URL_OF(1),
    }).expect(403);
  });

  /**
   * **Type of work and right of access are not the same thing — this test is that boundary.**
   *
   * If someone's `staff_type` is "researcher" but their portal role is still
   * `employee`, they will **not** get in. That sounds harsh, but the opposite is
   * worse: the right would be split across two tables, and that is exactly what
   * made the mess possible (ADR-038).
   *
   * So the owner is not left in the dark: when the two do not match, Settings →
   * Staff shows a message — the screen does not stay silent.
   */
  it('type researcher but role staff — may not', async () => {
    await staff('OX-R2', 'researcher', 'r2@test.local', 'employee');
    const session = await loginReady(h, 'r2@test.local', 'staff-password-123');

    await post(session, '/api/v1/design-targets/bulk', {
      text: URL_OF(1),
    }).expect(403);
  });

  /** The reverse is true too — the role has the last word, not the type */
  it('role researcher but type designer — may', async () => {
    await staff('OX-D2', 'designer', 'd2b@test.local', 'researcher');
    const session = await loginReady(h, 'd2b@test.local', 'staff-password-123');

    await post(session, '/api/v1/design-targets/bulk', {
      text: URL_OF(1),
    }).expect(201);
  });

  it('the owner and manager may', async () => {
    for (const [email, password] of [
      [OWNER_EMAIL, OWNER_PASSWORD],
      [MANAGER_EMAIL, MANAGER_PASSWORD],
    ]) {
      const session = await loginReady(h, email, password);
      await post(session, '/api/v1/design-targets/bulk', {
        text: URL_OF(email === OWNER_EMAIL ? 10 : 20),
      }).expect(201);
    }
  });
});

describe('POST /design-targets/bulk — duplicates', () => {
  /**
   * **A single old ASIN among 500 would cancel the whole batch** — which is
   * exactly what happened without `skipDuplicates`, and the researcher's day of
   * work would not be submitted.
   */
  it('giving an ASIN already in an earlier batch saves the batch', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    await post(owner, '/api/v1/design-targets/bulk', {
      text: [URL_OF(1), URL_OF(2)].join('\n'),
    }).expect(201);

    const res = await post(owner, '/api/v1/design-targets/bulk', {
      text: [URL_OF(2), URL_OF(3)].join('\n'),
    }).expect(201);

    expect(res.body.added).toBe(1);
    expect(res.body.alreadyKnown).toBe(1);
    expect(res.body.poolSize).toBe(3);
  });

  /** Different URLs of the same product — caught as a duplicate */
  it('another form of the same ASIN does not make a new row', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    await post(owner, '/api/v1/design-targets/bulk', {
      text: 'https://www.amazon.com/dp/B0DJBD22LW',
    }).expect(201);

    const res = await post(owner, '/api/v1/design-targets/bulk', {
      text: 'https://www.amazon.co.uk/Funny-Cat/dp/B0DJBD22LW/ref=sr_1_3?th=1',
    }).expect(201);

    expect(res.body.added).toBe(0);
    expect(await h.prisma.designTarget.count()).toBe(1);
  });

  /** Rejected lines come back with the reason — otherwise nobody would know which were lost */
  it('rejected lines come back with the reason', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await post(owner, '/api/v1/design-targets/bulk', {
      text: [URL_OF(1), 'https://etsy.com/listing/9', 'https://amzn.to/x'].join('\n'),
    }).expect(201);

    expect(res.body.added).toBe(1);
    expect(res.body.rejected).toHaveLength(2);
    expect(res.body.rejected[0].reason).toBe('not_amazon');
    expect(res.body.rejected[1].reason).toBe('short_link');
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe('allocation', () => {
  async function seedPool(count: number) {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: Array.from({ length: count }, (_, i) => URL_OF(i + 1)).join('\n'),
    }).expect(201);
  }

  /**
   * **A target never lands in two people's hands.** If it did, two people
   * would make the same design — and it would be caught only at delivery.
   */
  it('30 each, and no target twice', async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');
    await staff('OX-D2', 'designer', 'd2@test.local');
    await seedPool(100);

    await h.app.get(TargetsService).distribute();

    const rows = await h.prisma.designTarget.findMany({
      where: { status: 'assigned' },
      select: { id: true, assignedToId: true, jobNumber: true },
    });

    expect(rows).toHaveLength(60);
    // Every row belongs to exactly one person — `id` is unique, so the count is the claim
    expect(new Set(rows.map((r) => r.id)).size).toBe(60);

    const perDesigner = new Map<number | null, number>();
    for (const r of rows) {
      perDesigner.set(r.assignedToId, (perDesigner.get(r.assignedToId) ?? 0) + 1);
    }
    expect([...perDesigner.values()]).toEqual([30, 30]);
  });

  /**
   * **Job numbers are above a million, and never repeated.** If they fell
   * lower, the designers' old files (the largest being 973,065) would wrongly
   * close a target.
   */
  it('job numbers are unique and above a million', async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');
    await seedPool(40);

    await h.app.get(TargetsService).distribute();

    const numbers = (
      await h.prisma.designTarget.findMany({
        where: { status: 'assigned' },
        select: { jobNumber: true },
      })
    ).map((r) => r.jobNumber!);

    expect(numbers).toHaveLength(30);
    expect(new Set(numbers).size).toBe(30);
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(JOB_NUMBER_START);
  });

  /** No more is given when the hand is full — otherwise two hundred would pile up in a week */
  it('running a second time adds nothing', async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');
    await seedPool(100);

    const targets = h.app.get(TargetsService);
    await targets.distribute();
    const second = await targets.distribute();

    expect(second.assigned).toBe(0);
    expect(await h.prisma.designTarget.count({ where: { status: 'assigned' } })).toBe(30);
  });

  /** No crash when the pool is empty — this is what happens when the researcher is on leave */
  it('when the pool is empty, quietly nothing happens', async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');

    expect((await h.app.get(TargetsService).distribute()).assigned).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe('detecting "work started" from the file name', () => {
  /**
   * With no button at all — as soon as the designer puts the assigned number
   * in the file name, the target is marked.
   */
  /**
   * **This is "start", not "finish"** — and that difference is the whole point
   * here (fixed 23 August). The number shows in the title at the moment the
   * file is **opened**; it used to be treated as "finish", so a target closed
   * the moment it was opened.
   */
  it('with their own number on their own target, a "started" mark is set, it does not close', async () => {
    const designer = await staff('OX-D1', 'designer', 'd1@test.local');
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', { text: URL_OF(1) }).expect(201);

    const targets = h.app.get(TargetsService);
    await targets.distribute();

    const row = await h.prisma.designTarget.findFirstOrThrow();
    const seenAt = new Date(dhakaNoon().getTime() + 37 * 60_000);
    const closed = await targets.markStartedByJobNumbers(
      designer.id,
      new Map([[String(row.jobNumber), seenAt]]),
    );

    expect(closed).toBe(1);
    const after = await h.prisma.designTarget.findFirstOrThrow();
    // Still in the designer's hands — they say "finished" themselves
    expect(after.status).toBe('assigned');
    expect(after.completedAt).toBeNull();

    /**
     * **Exactly the moment that was given is the one stored** (G163).
     *
     * This used to be just `not.toBeNull()` — and that weak claim hid the bug
     * for a year: the caller sent the working day's **label** (6 a.m. Dhaka)
     * and the test stayed green. In the field, all 711 of 711 were stored at that one moment.
     */
    expect(after.startedAt?.toISOString()).toBe(seenAt.toISOString());
  });

  /**
   * **One person's file cannot close another's target.** The number is not
   * supposed to be in two people's hands, but "not supposed to" is not the same as "cannot".
   */
  it("nothing is closed with someone else's number", async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');
    const other = await staff('OX-D2', 'designer', 'd2@test.local');
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', { text: URL_OF(1) }).expect(201);

    const targets = h.app.get(TargetsService);
    await targets.distribute();

    const row = await h.prisma.designTarget.findFirstOrThrow();
    // The row belongs to OX-D1 (first in employee-code order), but OX-D2 is
    //    the one trying to close it
    const closed = await targets.markStartedByJobNumbers(
      other.id,
      new Map([[String(row.jobNumber), dhakaNoon()]]),
    );

    expect(closed).toBe(0);
    // The mark was not even set — someone else's file cannot touch anything
    expect((await h.prisma.designTarget.findFirstOrThrow()).startedAt).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe('return to the pool at day end', () => {
  async function seed(count: number) {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: Array.from({ length: count }, (_, i) => URL_OF(i + 1)).join(BR),
    }).expect(201);
  }

  const TODAY = dhakaNoon();
  /** New lines — writing them directly gets the escaping wrong */
  const BR = String.fromCharCode(10);

  /**
   * The owner's rule: whatever designs are left at day end come back to the
   * main list — 30 given, 15 done, the remaining 15 return.
   */
  it('targets not done return to the pool', async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');
    await seed(40);

    const targets = h.app.get(TargetsService);
    await targets.distribute();
    expect(await h.prisma.designTarget.count({ where: { status: 'assigned' } })).toBe(30);

    const { returned } = await targets.returnUnworked(workDateOf(TODAY));

    expect(returned).toBe(30);
    expect(await h.prisma.designTarget.count({ where: { status: 'pool' } })).toBe(40);
    // Nobody has anything left in hand
    expect(
      await h.prisma.designTarget.count({ where: { assignedToId: { not: null } } }),
    ).toBe(0);
  });

  /**
   * **The most important test in this file.** Someone opened a design and
   * started work but could not finish today — under the simple rule that one
   * would go back too and land with someone else tomorrow. Two people's work
   * wasted, and nobody would understand why.
   */
  it('a target touched today is not returned', async () => {
    const designer = await staff('OX-D1', 'designer', 'd1@test.local');
    await seed(40);

    const targets = h.app.get(TargetsService);
    await targets.distribute();

    const mine = await h.prisma.designTarget.findMany({
      where: { assignedToId: designer.id },
      select: { id: true, jobNumber: true },
      take: 2,
    });

    // "Touched" = the file was opened, i.e. the number is in today's credit
    await h.prisma.designCredit.create({
      data: {
        employeeId: designer.id,
        designId: String(mine[0].jobNumber),
        firstWorkDate: workDateOf(TODAY),
      },
    });

    const { returned } = await targets.returnUnworked(workDateOf(TODAY));

    expect(returned).toBe(29);
    const kept = await h.prisma.designTarget.findUniqueOrThrow({
      where: { id: mine[0].id },
    });
    expect(kept.status).toBe('assigned');
    expect(kept.assignedToId).toBe(designer.id);
  });

  /**
   * **The job number is not erased.** The number belongs to the ASIN, not to
   * the allocation — erasing it would burn serials for nothing, and old file
   * names would never match anything again.
   */
  it('even when returned the number stays the same, and no new number is set the next time', async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');
    await seed(40);

    const targets = h.app.get(TargetsService);
    await targets.distribute();

    const before = await h.prisma.designTarget.findMany({
      where: { status: 'assigned' },
      select: { id: true, jobNumber: true },
      orderBy: { id: 'asc' },
    });

    await targets.returnUnworked(workDateOf(TODAY));
    await targets.distribute();

    const after = await h.prisma.designTarget.findMany({
      where: { id: { in: before.map((b) => b.id) } },
      select: { id: true, jobNumber: true },
      orderBy: { id: 'asc' },
    });

    const byId = new Map(after.map((a) => [a.id, a.jobNumber]));
    for (const b of before) expect(byId.get(b.id)).toBe(b.jobNumber);
  });

  /** A finished target is not returned — it is nobody's work any more */
  it('finished and dropped targets are not touched', async () => {
    const designer = await staff('OX-D1', 'designer', 'd1@test.local');
    await seed(40);

    const targets = h.app.get(TargetsService);
    await targets.distribute();

    const mine = await h.prisma.designTarget.findMany({
      where: { assignedToId: designer.id },
      select: { id: true },
      take: 2,
    });
    /**
     * The third parameter is **who pressed it**. This test's question is not
     * "who" but "how many go back", so any valid user will do — it is taken
     * from the database because the FK must be satisfied.
     */
    const anyUser = await h.prisma.user.findFirstOrThrow({ select: { id: true } });
    await targets.markDone(designer.id, mine[0].id, anyUser.id);
    await targets.skip(designer.id, mine[1].id, 'not_found');

    const { returned } = await targets.returnUnworked(workDateOf(TODAY));

    expect(returned).toBe(28);
    expect(await h.prisma.designTarget.count({ where: { status: 'done' } })).toBe(1);
    expect(await h.prisma.designTarget.count({ where: { status: 'skipped' } })).toBe(1);
  });
});

describe('started targets', () => {
  /**
   * **A target with work in progress does not go back at night.** The
   * "touched today" condition was narrower than this: work running for three
   * days would go back on the day nobody opened the file, and land with
   * someone else tomorrow.
   */
  it('a target started earlier is still in hand the next day', async () => {
    const designer = await staff('OX-D1', 'designer', 'd1@test.local');
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: Array.from({ length: 40 }, (_, i) => URL_OF(i + 1)).join(String.fromCharCode(10)),
    }).expect(201);

    const targets = h.app.get(TargetsService);
    await targets.distribute();

    const one = await h.prisma.designTarget.findFirstOrThrow({
      where: { assignedToId: designer.id },
    });
    // Started yesterday, nobody opened the file today
    await h.prisma.designTarget.update({
      where: { id: one.id },
      data: { startedAt: dhakaNoon(-1) },
    });

    await targets.returnUnworked(workDateOf(dhakaNoon()));

    const after = await h.prisma.designTarget.findUniqueOrThrow({
      where: { id: one.id },
    });
    expect(after.status).toBe('assigned');
    expect(after.assignedToId).toBe(designer.id);
  });
});

describe('job number', () => {
  /**
   * **Every target has a number, from the moment it is submitted.** It used
   * to be set at allocation time, so a row sitting in the pool had no
   * identity.
   */
  it('gets a number as soon as it is in the pool, and all are different', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: [URL_OF(1), URL_OF(2), URL_OF(3)].join(String.fromCharCode(10)),
    }).expect(201);

    const rows = await h.prisma.designTarget.findMany({
      select: { status: true, jobNumber: true },
    });

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'pool')).toBe(true);
    expect(rows.every((r) => r.jobNumber !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.jobNumber)).size).toBe(3);
  });

  /** The number does **not change** on allocation — it belongs to the ASIN, not to the allocation */
  it('the number stays the same after allocation', async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', { text: URL_OF(1) }).expect(201);

    const before = await h.prisma.designTarget.findFirstOrThrow();
    await h.app.get(TargetsService).distribute();
    const after = await h.prisma.designTarget.findFirstOrThrow();

    expect(after.jobNumber).toBe(before.jobNumber);
    expect(after.status).toBe('assigned');
  });
});

/**
 * **The researcher's two queues** (G-workflow).
 *
 * **Why a cut-off date:** the 22 August import brought in 27,509 old `done`
 * rows that went to Amazon long ago, but there was no Uploaded button at the
 * time. Without a limit the queue would stand at 27,641 — not a queue, a mountain.
 *
 * This describe guards that limit: whether the chip count and the list count
 * are the **same**, and whether old rows really drop out.
 */
/**
 * **Searching the Design Pool — by ASIN or Job number.**
 *
 * **Why it was needed:** the screen shows the Job number large under every
 * row (`Job 1016878`), yet there was no way to search by it — the only
 * identity was the ASIN. So the screen showed a number you could do nothing with.
 *
 * **Searching by URL has been removed** — the owner's decision. It used to
 * extract the ASIN from the link with `asinOf()`.
 */
describe('searching the Design Pool — by ASIN or Job number', () => {
  /** Sets up three targets and returns their ASINs and Job numbers */
  async function seed() {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: [URL_OF(1), URL_OF(2), URL_OF(3)].join(String.fromCharCode(10)),
    }).expect(201);

    const rows = await h.prisma.designTarget.findMany({
      select: { asin: true, jobNumber: true },
      orderBy: { asin: 'asc' },
    });

    return { owner, rows };
  }

  const search = (session: Session, q: string) =>
    session.http.get(`/api/v1/design-targets?q=${encodeURIComponent(q)}`);

  it('can search by ASIN', async () => {
    const { owner, rows } = await seed();

    const res = await search(owner, rows[0].asin).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].asin).toBe(rows[0].asin);
  });

  /**
   * **The main test of this describe** — it is the new capability.
   *
   * The Job number is matched **exactly**, not with `contains` — the column is
   *    `Int`, and a partial match of a number means nothing to a person.
   */
  it('can search by Job number too', async () => {
    const { owner, rows } = await seed();
    const target = rows[1];

    const res = await search(owner, String(target.jobNumber)).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].asin).toBe(target.asin);
    expect(res.body.rows[0].jobNumber).toBe(target.jobNumber);
  });

  /**
   * **Another person's number gives another person's row** — otherwise the
   * test would go green just from seeing "some row came back", and we could not
   * tell whether the search actually goes by number.
   */
  it('a different Job number brings a different row', async () => {
    const { owner, rows } = await seed();

    const first = await search(owner, String(rows[0].jobNumber)).expect(200);
    const last = await search(owner, String(rows[2].jobNumber)).expect(200);

    expect(first.body.rows[0].asin).toBe(rows[0].asin);
    expect(last.body.rows[0].asin).toBe(rows[2].asin);
    expect(first.body.rows[0].asin).not.toBe(last.body.rows[0].asin);
  });

  /**
   * **No longer found by URL** — this guards that decision.
   * If someone brings `asinOf()` back, this test turns red.
   */
  it('searching by link no longer works', async () => {
    const { owner, rows } = await seed();

    const res = await search(owner, URL_OF(1)).expect(200);

    expect(res.body.total).toBe(0);
    // Yet that ASIN is in the table — it is excluded only by the search rule
    expect(rows.some((r) => URL_OF(1).endsWith(r.asin))).toBe(true);
  });

  /**
   * Lower case works too — people copy the ASIN in all kinds of ways.
   */
  it('a lower-case ASIN works too', async () => {
    const { owner, rows } = await seed();

    const res = await search(owner, rows[0].asin.toLowerCase()).expect(200);

    expect(res.body.total).toBe(1);
  });

  /**
   * **A number beyond the `Int` range used to throw a 500.** The `job_number`
   * column is `Int`, so sending anything above 2,147,483,647 to Prisma broke
   * the query — although the user had only typed a long number.
   */
  it('does not fall over even with a huge number', async () => {
    const { owner } = await seed();

    const res = await search(owner, '99999999999999').expect(200);

    expect(res.body.total).toBe(0);
  });
});

describe("researcher's queue — waiting for upload and live", () => {
  const targetsOf = () => h.app.get(TargetsService);

  /** Sets completedAt on that ASIN's row — on either side of the cut-off date */
  /**
   * **The key is the ASIN, not the job number.** At first I assumed
   * `JOB_NUMBER_START + n`, and CI caught it: the number comes from a
   * sequence, and earlier describes in the same file use up numbers. We set
   * the ASIN ourselves (`URL_OF(n)`), so it is the only reliable key.
   */
  const ASIN_OF = (n: number) => `B${String(n).padStart(9, '0')}`;

  async function markDoneAt(n: number, iso: string): Promise<void> {
    await h.prisma.designTarget.update({
      where: { asin: ASIN_OF(n) },
      data: { status: 'done', completedAt: new Date(iso) },
    });
  }

  beforeEach(async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: [URL_OF(1), URL_OF(2), URL_OF(3)].join('\n'),
    }).expect(201);
  });

  it('"finished" before the cut-off date does not get into the queue', async () => {
    // 22 August — before the limit, i.e. old imported work
    await markDoneAt(1, '2026-08-22T10:00:00+06:00');
    // 23 August — exactly on the limit day, so it counts
    await markDoneAt(2, '2026-08-23T10:00:00+06:00');

    const page = await targetsOf().list({ stage: 'to_upload' });

    expect(page.total).toBe(1);
    expect(page.rows[0].asin).toBe(ASIN_OF(2));
  });

  /**
   * **The most important test** — if the number written on the chip and the
   * list you get by clicking it differ, nobody will trust any number again.
   */
  it('the chip count and the list count are exactly the same', async () => {
    await markDoneAt(1, '2026-08-23T10:00:00+06:00');
    await markDoneAt(2, '2026-08-24T10:00:00+06:00');
    await markDoneAt(3, '2026-08-22T10:00:00+06:00');

    const [stats, page] = await Promise.all([
      targetsOf().stats(),
      targetsOf().list({ stage: 'to_upload' }),
    ]);

    expect(stats.toUpload).toBe(2);
    expect(page.total).toBe(stats.toUpload);
  });

  it('once uploaded, the row leaves the first queue and goes to the second', async () => {
    await markDoneAt(1, '2026-08-23T10:00:00+06:00');

    const row = await h.prisma.designTarget.findUniqueOrThrow({
      where: { asin: ASIN_OF(1) },
    });
    await targetsOf().markUploaded(row.id, dhakaNoon());

    const [stats, toUpload, toLive] = await Promise.all([
      targetsOf().stats(),
      targetsOf().list({ stage: 'to_upload' }),
      targetsOf().list({ stage: 'to_live' }),
    ]);

    expect(toUpload.total).toBe(0);
    expect(toLive.total).toBe(1);
    expect(stats.toUpload).toBe(0);
    expect(stats.toLive).toBe(1);
  });

  /** `to_live` has **no** cut-off date — old rows are not a problem there */
  it('the cut-off date does not apply to the live queue', async () => {
    await markDoneAt(1, '2025-01-10T10:00:00+06:00');
    const row = await h.prisma.designTarget.findUniqueOrThrow({
      where: { asin: ASIN_OF(1) },
    });
    await targetsOf().markUploaded(row.id, dhakaNoon());

    expect((await targetsOf().list({ stage: 'to_upload' })).total).toBe(0);
    expect((await targetsOf().list({ stage: 'to_live' })).total).toBe(1);
  });
});

/**
 * **The spell-check chain** (ADR-038).
 *
 * Once a designer says "finished", the work is not over — someone checks the
 * spelling, someone fixes any mistake found, then the file goes to Amazon. This
 * happens in the field; the system did not know, so nobody could say
 * *"which ones are still to be checked"*.
 *
 * The machine does **not** read spelling — it only keeps the count.
 */
describe('spell-check — checked, mistake found, fixed', () => {
  const svc = () => h.app.get(TargetsService);
  const ASIN_OF = (n: number) => `B${String(n).padStart(9, '0')}`;

  /** Sets `completedAt` on that row — after the cut-off date */
  async function finished(n: number): Promise<number> {
    const row = await h.prisma.designTarget.update({
      where: { asin: ASIN_OF(n) },
      data: { status: 'done', completedAt: new Date('2026-08-23T10:00:00+06:00') },
    });
    return row.id;
  }

  /**
   * Whoever presses the button — the owner is enough.
   *
   * This describe calls the **service directly**, so the HTTP guard
   * (`assertCanProofread`) does not run here at all — who may do it is
   * checked in the separate describe below. The only question here is whether the *rule* is right.
   */
  let actorId: number;

  beforeEach(async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: [URL_OF(1), URL_OF(2), URL_OF(3)].join('\n'),
    }).expect(201);
    const u = await h.prisma.user.findFirstOrThrow({
      where: { role: 'owner' },
    });
    actorId = u.id;
  });

  it('a finished design enters the check queue', async () => {
    await finished(1);

    const [stats, page] = await Promise.all([
      svc().stats(),
      svc().list({ stage: 'to_check' }),
    ]);

    expect(stats.toCheck).toBe(1);
    expect(page.total).toBe(stats.toCheck);
    expect(page.rows[0].asin).toBe(ASIN_OF(1));
  });

  it('when the spelling is right it leaves the queue and does not go to the fix queue', async () => {
    const id = await finished(1);

    await svc().markChecked(id, true, actorId, dhakaNoon());

    const stats = await svc().stats();
    expect(stats.toCheck).toBe(0);
    expect(stats.toFix).toBe(0);
    // It was fine, so it stays in the upload queue
    expect(stats.toUpload).toBe(1);
  });

  /**
   * **Guards the owner's decision** — a design with a mistake found but not
   * yet fixed is **out of the upload queue**. Something known to be broken
   * must not go to Amazon.
   */
  it('a design with a mistake found stays out of the upload queue', async () => {
    const id = await finished(1);
    await finished(2);

    await svc().markChecked(id, false, actorId, dhakaNoon());

    const [stats, toFix, toUpload] = await Promise.all([
      svc().stats(),
      svc().list({ stage: 'to_fix' }),
      svc().list({ stage: 'to_upload' }),
    ]);

    expect(stats.toFix).toBe(1);
    expect(toFix.rows[0].asin).toBe(ASIN_OF(1));

    // No. 2 has not even been checked yet — still in the upload queue
    expect(stats.toUpload).toBe(1);
    expect(toUpload.rows[0].asin).toBe(ASIN_OF(2));
  });

  it('after being fixed it returns to the upload queue', async () => {
    const id = await finished(1);
    await svc().markChecked(id, false, actorId, dhakaNoon());
    expect((await svc().stats()).toUpload).toBe(0);

    await svc().markFixed(id, actorId, dhakaNoon());

    const stats = await svc().stats();
    expect(stats.toFix).toBe(0);
    expect(stats.toUpload).toBe(1);
  });

  /**
   * **Ownership of a design never changes** — this test guards that
   * decision. If the work moved to the fixer's name when they fixed it, their
   * count would swell — the whole investigation of 23 August started exactly
   * from seeing such a number.
   */
  it('even when fixed, the design stays with the original designer', async () => {
    const designer = await staff('OX-D9', 'designer', 'd9@test.local');
    const id = await finished(1);
    await h.prisma.designTarget.update({
      where: { id },
      data: { assignedToId: designer.id },
    });

    await svc().markChecked(id, false, actorId, dhakaNoon());
    await svc().markFixed(id, actorId, dhakaNoon());

    const row = await h.prisma.designTarget.findUniqueOrThrow({ where: { id } });
    expect(row.assignedToId).toBe(designer.id);
    expect(row.fixedById).toBe(actorId);
  });

  /** Pressing twice does not move the date — otherwise "when it was checked" would jump */
  it('pressing again does not change the date', async () => {
    const id = await finished(1);
    await svc().markChecked(id, true, actorId, new Date('2026-08-24T10:00:00+06:00'));
    await svc().markChecked(id, false, actorId, new Date('2026-08-25T10:00:00+06:00'));

    const row = await h.prisma.designTarget.findUniqueOrThrow({ where: { id } });
    expect(row.checkedAt?.toISOString()).toBe(new Date('2026-08-24T10:00:00+06:00').toISOString());
    // The second press did not set "mistake" — the first verdict stays
    expect(row.errorFoundAt).toBeNull();
  });

  it('an unfinished design cannot be checked', async () => {
    const row = await h.prisma.designTarget.findUniqueOrThrow({
      where: { asin: ASIN_OF(1) },
    });
    await expect(
      svc().markChecked(row.id, true, actorId, dhakaNoon()),
    ).rejects.toThrow();
  });

  it('"fixed" cannot be said when there is no mistake', async () => {
    const id = await finished(1);
    await svc().markChecked(id, true, actorId, dhakaNoon());

    await expect(svc().markFixed(id, actorId, dhakaNoon())).rejects.toThrow();
  });
});


/**
 * **Who may check spelling.**
 *
 * ### This describe was written twice in one day
 *
 * **In the morning** the owner said only he, the manager and one named person
 * should have this access — so the guard went by the `employees.can_proofread`
 * checkbox, i.e. **by person**, and the tests here measured exactly that.
 *
 * **Later** he said all researchers get the same access: researcher and
 * designer do different work, so their access should differ.
 * So the question was never *"which person"*, it was *"which work"* — and that
 * is a question of role. The checkbox lived for one day and was deleted.
 */
describe('spell-check rights — HTTP guard', () => {
  const ASIN_OF = (n: number) => `B${String(n).padStart(9, '0')}`;

  /** A row made for checking — finished, not yet looked at */
  async function ready(): Promise<number> {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: URL_OF(1),
    }).expect(201);

    const row = await h.prisma.designTarget.update({
      where: { asin: ASIN_OF(1) },
      data: { status: 'done', completedAt: new Date('2026-08-23T10:00:00+06:00') },
    });
    return row.id;
  }

  it('a researcher can check and fix', async () => {
    const id = await ready();
    await staff('OX-R8', 'researcher', 'r8@test.local', 'researcher');
    const session = await loginReady(h, 'r8@test.local', 'staff-password-123');

    await post(session, `/api/v1/design-targets/${id}/checked`, {
      ok: false,
    }).expect(201);
    await post(session, `/api/v1/design-targets/${id}/fixed`, {}).expect(201);

    const row = await h.prisma.designTarget.findUniqueOrThrow({ where: { id } });
    expect(row.errorFoundAt).not.toBeNull();
    expect(row.fixedAt).not.toBeNull();
  });

  /**
   * **A second researcher can too — this is the 25 August change.**
   *
   * In the morning the opposite of this test was written (`.expect(403)`),
   * because the right sat in a checkbox and the tick belonged to one person.
   * The owner changed the rule, so the test flipped too — it was matched not to
   * the code but to the **decision**.
   */
  it("a second researcher can too — no waiting for anyone's tick", async () => {
    const id = await ready();
    await staff('OX-R9', 'researcher', 'r9@test.local', 'researcher');
    const session = await loginReady(h, 'r9@test.local', 'staff-password-123');

    await post(session, `/api/v1/design-targets/${id}/checked`, {
      ok: true,
    }).expect(201);
  });

  /** A manager has no `employees` row at all — they get it through the role */
  it('a manager can', async () => {
    const id = await ready();
    const session = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await post(session, `/api/v1/design-targets/${id}/checked`, {
      ok: true,
    }).expect(201);

    const row = await h.prisma.designTarget.findUniqueOrThrow({ where: { id } });
    expect(row.checkedAt).not.toBeNull();
  });

  it('a designer cannot', async () => {
    const id = await ready();
    await staff('OX-D7', 'designer', 'd7@test.local');
    const session = await loginReady(h, 'd7@test.local', 'staff-password-123');

    await session.http.get('/api/v1/design-targets').expect(403);
    await post(session, `/api/v1/design-targets/${id}/checked`, {
      ok: true,
    }).expect(403);

    const row = await h.prisma.designTarget.findUniqueOrThrow({ where: { id } });
    expect(row.checkedAt).toBeNull();
  });

  /** Both flags go in the session too — the screen looks at them to hide the button */
  it('the session carries canAddTargets and canProofread correctly', async () => {
    await staff('OX-RA', 'researcher', 'ra@test.local', 'researcher');
    await staff('OX-D8', 'designer', 'd8@test.local');

    const researcher = await loginReady(h, 'ra@test.local', 'staff-password-123');
    const designer = await loginReady(h, 'd8@test.local', 'staff-password-123');

    const a = await researcher.http.get('/api/v1/auth/me').expect(200);
    const b = await designer.http.get('/api/v1/auth/me').expect(200);

    expect(a.body.role).toBe('researcher');
    expect(a.body.canAddTargets).toBe(true);
    expect(a.body.canProofread).toBe(true);

    expect(b.body.canAddTargets).toBe(false);
    expect(b.body.canProofread).toBe(false);
  });
});


/**
 * **Who brought the target** (owner's request: the owner wants to see who
 * added each target to the Design Pool).
 *
 * The subtlest claim here is about **two separate worlds of ids**:
 * `assignedToId → employees`, `addedById → users`. The numbers are small and
 * close together, so it is easy to put one in place of the other — and then
 * there is no error, only **the wrong person's rows** come back.
 */
describe('who brought it — list, filter and count', () => {
  const svc = () => h.app.get(TargetsService);

  it('the row says who brought it, with the role', async () => {
    await staff('OX-RB', 'researcher', 'rb@test.local', 'researcher');
    const session = await loginReady(h, 'rb@test.local', 'staff-password-123');

    await post(session, '/api/v1/design-targets/bulk', {
      text: URL_OF(1),
    }).expect(201);

    const page = await svc().list({});
    expect(page.rows[0].addedBy.fullName).toBe('OX-RB');
    expect(page.rows[0].addedBy.role).toBe('researcher');
    expect(page.rows[0].addedAt).not.toBeNull();
  });

  /**
   * **This test guards the two-id-worlds problem.** The researcher's `users.id`
   * and the designer's `employees.id` are different numbers; if the filter
   * gets it wrong, it will be caught here.
   */
  it('can be filtered by who brought it', async () => {
    await staff('OX-RC', 'researcher', 'rc@test.local', 'researcher');
    const them = await loginReady(h, 'rc@test.local', 'staff-password-123');
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    await post(them, '/api/v1/design-targets/bulk', {
      text: [URL_OF(1), URL_OF(2)].join('\n'),
    }).expect(201);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: URL_OF(3),
    }).expect(201);

    const adders = await svc().adders();
    expect(adders).toHaveLength(2);

    const researcher = adders.find((a) => a.role === 'researcher');
    expect(researcher?.count).toBe(2);
    expect(adders.find((a) => a.role === 'owner')?.count).toBe(1);

    // The one who brought the most comes first
    expect(adders[0].count).toBe(2);

    const only = await svc().list({ addedById: researcher!.id });
    expect(only.total).toBe(2);
    for (const row of only.rows) {
      expect(row.addedBy.role).toBe('researcher');
    }
  });

  /** If nobody brought anything the list is empty — the dropdown stays empty, it does not break */
  it('empty list when there is nothing', async () => {
    expect(await svc().adders()).toEqual([]);
  });

  /** A designer cannot touch this route either — it sits right under `assertCanUse` */
  it('a designer cannot see adders', async () => {
    await staff('OX-D9B', 'designer', 'd9b@test.local');
    const session = await loginReady(h, 'd9b@test.local', 'staff-password-123');

    await session.http.get('/api/v1/design-targets/adders').expect(403);
  });
});


/**
 * **"I pressed Complete by mistake"** (owner's report: someone often presses
 * Complete by mistake and cannot undo it).
 *
 * The root cause was **not being able to see it at all**: `mine()` sent only
 * `assigned` rows, so the moment Complete was pressed the item vanished from
 * the screen. Never mind an undo button — the row could not even be found.
 */
describe('undoing Complete', () => {
  const svc = () => h.app.get(TargetsService);
  const ASIN_OF = (n: number) => `B${String(n).padStart(9, '0')}`;

  /**
   * One designer, with one target in hand.
   *
   * **The owner's session is returned, and that is the real trap here.**
   * In the harness the owner has `mustChangePw: true`, so `loginReady` changes
   * the password to `…-changed` on the first login. Calling
   * `loginReady(OWNER_PASSWORD)` a second time in one test therefore gives a
   * **401** — and the message ("expected 200, got 401") has no relation to the
   * test's real claim, so finding the cause wastes time.
   */
  async function assigned(n: number, reuse?: Session) {
    const owner = reuse ?? (await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD));
    await post(owner, '/api/v1/design-targets/bulk', {
      text: URL_OF(n),
    }).expect(201);

    const designer = await staff(`OX-U${n}`, 'designer', `u${n}@test.local`);
    const row = await h.prisma.designTarget.update({
      where: { asin: ASIN_OF(n) },
      data: {
        status: 'assigned',
        assignedToId: designer.id,
        assignedAt: dhakaNoon(),
      },
    });

    const session = await loginReady(h, `u${n}@test.local`, 'staff-password-123');
    return { id: row.id, designer, session, owner };
  }

  it('after finishing, the row stays in their own list', async () => {
    const { id, designer, session } = await assigned(1);

    await post(session, `/api/v1/me/targets/${id}/done`, {}).expect(201);

    const mine = await svc().mine(designer.id);
    expect(mine).toHaveLength(1);
    // But it is no longer "in hand" — it is finished
    expect(mine[0].completedAt).not.toBeNull();
  });

  it('pressing Undo puts it back in hand', async () => {
    const { id, designer, session } = await assigned(1);
    await post(session, `/api/v1/me/targets/${id}/done`, {}).expect(201);

    await post(session, `/api/v1/me/targets/${id}/undone`, {}).expect(201);

    const row = await h.prisma.designTarget.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('assigned');
    /**
     * **All three must be cleared.** The queues run on `completedAt`, not on
     * `status` — restoring only the status would show the row as "in hand"
     * while it still sat in the upload queue.
     */
    expect(row.completedAt).toBeNull();
    expect(row.completedVia).toBeNull();
    expect(row.completedById).toBeNull();

    // The work stays theirs — it does not go back to the pool
    expect(row.assignedToId).toBe(designer.id);
  });

  it('it also leaves the queue', async () => {
    const { id, session } = await assigned(1);
    await post(session, `/api/v1/me/targets/${id}/done`, {}).expect(201);
    expect((await svc().stats()).toUpload).toBe(1);

    await post(session, `/api/v1/me/targets/${id}/undone`, {}).expect(201);

    const stats = await svc().stats();
    expect(stats.toUpload).toBe(0);
    expect(stats.toCheck).toBe(0);
  });

  /**
   * **This is the most important test.** Once the spelling has been checked,
   * it is no longer an "accidental press" — undoing would make the spell-check
   * queue and the upload count lie together.
   */
  it('once the spelling has been checked, it cannot be undone', async () => {
    const { id, session, owner } = await assigned(1);
    await post(session, `/api/v1/me/targets/${id}/done`, {}).expect(201);

    await post(owner, `/api/v1/design-targets/${id}/checked`, { ok: true }).expect(201);

    await post(session, `/api/v1/me/targets/${id}/undone`, {}).expect(409);

    const row = await h.prisma.designTarget.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('done');
  });

  /** Undoing yesterday's would change yesterday's count too */
  it("a designer cannot undo yesterday's work", async () => {
    const { id, session } = await assigned(1);
    await post(session, `/api/v1/me/targets/${id}/done`, {}).expect(201);
    await h.prisma.designTarget.update({
      where: { id },
      data: { completedAt: dhakaNoon(-3) },
    });

    await post(session, `/api/v1/me/targets/${id}/undone`, {}).expect(409);
  });

  /** But the owner can — correcting old mistakes is the job of that route */
  it('the owner can undo even an old Complete', async () => {
    const { id, designer, session, owner } = await assigned(1);
    await post(session, `/api/v1/me/targets/${id}/done`, {}).expect(201);
    await h.prisma.designTarget.update({
      where: { id },
      data: { completedAt: dhakaNoon(-3) },
    });

    await post(owner, `/api/v1/design-targets/${id}/undone`, {}).expect(201);

    const row = await h.prisma.designTarget.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('assigned');
    expect(row.completedAt).toBeNull();
    expect(row.assignedToId).toBe(designer.id);
  });

  /** Someone else's row cannot be touched — not even by guessing the id */
  it("someone else's target cannot be undone", async () => {
    const first = await assigned(1);
    // Reuses the owner's session — see the note above
    const mine = await assigned(2, first.owner);
    const id = first.id;
    await post(mine.session, `/api/v1/me/targets/${mine.id}/done`, {}).expect(201);

    await post(mine.session, `/api/v1/me/targets/${id}/undone`, {}).expect(403);
  });

  /**
   * **Undo is written to the audit log** (added after the owner asked whether
   * designers should have this access).
   *
   * This is the only action that **erases its own trace** — `completedAt`,
   * `completedVia` and `completedById` all become `null`, so the proof that
   * the work was ever finished disappears from the row. Without the log, nobody
   * could see someone doing Complete → Undo → Complete every day.
   *
   * The meta must hold **the erased values**, otherwise the log would only say
   * "something was undone" — not what.
   */
  it('Undo is written to the audit log, with the erased values', async () => {
    const { id, session, designer } = await assigned(1);
    await post(session, `/api/v1/me/targets/${id}/done`, {}).expect(201);

    const doneRow = await h.prisma.designTarget.findUniqueOrThrow({
      where: { id },
    });

    await post(session, `/api/v1/me/targets/${id}/undone`, {}).expect(201);

    const entry = await h.prisma.auditLog.findFirstOrThrow({
      where: { action: 'design_undone' },
      orderBy: { id: 'desc' },
    });

    expect(entry.targetType).toBe('design_target');
    expect(entry.targetId).toBe(String(id));

    const meta = entry.meta as Record<string, unknown>;
    expect(meta.asin).toBe(ASIN_OF(1));
    expect(meta.assignedToId).toBe(designer.id);
    // What was erased — the row no longer has these, the log is the only place
    expect(meta.completedVia).toBe('manual');
    expect(meta.completedById).toBe(doneRow.completedById);
    expect(meta.completedAt).toBe(doneRow.completedAt?.toISOString());
  });

  /** A failed Undo is not logged — otherwise the log would fill up with attempts */
  it('a blocked Undo is not logged', async () => {
    const { id, session, owner } = await assigned(1);
    await post(session, `/api/v1/me/targets/${id}/done`, {}).expect(201);
    await post(owner, `/api/v1/design-targets/${id}/checked`, { ok: true }).expect(201);

    await post(session, `/api/v1/me/targets/${id}/undone`, {}).expect(409);

    expect(
      await h.prisma.auditLog.count({ where: { action: 'design_undone' } }),
    ).toBe(0);
  });

  /** Pressing twice does not break — "fine" the second time too */
  it('pressing Undo twice does not break', async () => {
    const { id, session } = await assigned(1);
    await post(session, `/api/v1/me/targets/${id}/done`, {}).expect(201);

    await post(session, `/api/v1/me/targets/${id}/undone`, {}).expect(201);
    await post(session, `/api/v1/me/targets/${id}/undone`, {}).expect(201);
  });
});


/**
 * **The manager gets 30 a day too** (owner's instruction: distribute 30
 * designs daily for the manager as well).
 *
 * The real claims here are two, and they are **separate** questions:
 *   1. Does the manager **get** work? → yes, 30 like the designers
 *   2. Is the manager bound to the work **yardstick**? → no, no daily target
 *
 * They design 1-2 days a week, so showing them "behind" on the other days
 * would be false. Merging the two is the easiest mistake to make here.
 */
describe('allocation — the manager gets it too', () => {
  const svc = () => h.app.get(TargetsService);

  /** `seedPool` of the describe above does not reach here — it is inside that one */
  async function fillPool(count: number) {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: Array.from({ length: count }, (_, i) => URL_OF(i + 1)).join('\n'),
    }).expect(201);
  }

  it('the manager gets 30, same as the designers', async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');
    await staff('OX-M1', 'manager', 'm1@test.local');
    await fillPool(100);

    await svc().distribute();

    const rows = await h.prisma.designTarget.findMany({
      where: { status: 'assigned' },
      select: { assignedToId: true },
    });
    expect(rows).toHaveLength(60);

    const per = new Map<number | null, number>();
    for (const r of rows) per.set(r.assignedToId, (per.get(r.assignedToId) ?? 0) + 1);
    expect([...per.values()]).toEqual([30, 30]);
  });

  /** A researcher does not get any — they **bring** targets, they do not do them */
  it('the researcher is not in the allocation', async () => {
    await staff('OX-R1', 'researcher', 'r1@test.local');
    await fillPool(100);

    expect((await svc().distribute()).assigned).toBe(0);
  });

  /**
   * **No pile builds up even if they do not work every day** — this answers
   * the owner's second sentence (they design 1-2 days a week).
   *
   * The condition is whether it was **opened**, not whether it was
   * "finished" — a file they picked up today but could not finish stays in their hand.
   */
  it('an untouched design returns to the pool at night', async () => {
    const manager = await staff('OX-M2', 'manager', 'm2@test.local');
    await fillPool(100);
    await svc().distribute();
    expect(
      await h.prisma.designTarget.count({ where: { assignedToId: manager.id } }),
    ).toBe(30);

    await svc().returnUnworked(workDateOf(dhakaNoon()));

    expect(
      await h.prisma.designTarget.count({ where: { assignedToId: manager.id } }),
    ).toBe(0);
    expect(
      await h.prisma.designTarget.count({ where: { status: 'pool' } }),
    ).toBe(100);
  });

  /** But one they opened stays in their hand */
  it('an opened design is not returned', async () => {
    const manager = await staff('OX-M3', 'manager', 'm3@test.local');
    await fillPool(100);
    await svc().distribute();

    const one = await h.prisma.designTarget.findFirstOrThrow({
      where: { assignedToId: manager.id },
    });
    await h.prisma.designTarget.update({
      where: { id: one.id },
      data: { startedAt: dhakaNoon() },
    });

    await svc().returnUnworked(workDateOf(dhakaNoon()));

    const still = await h.prisma.designTarget.findUniqueOrThrow({
      where: { id: one.id },
    });
    expect(still.assignedToId).toBe(manager.id);
  });
});
// ════════════════════════════════════════════════════════════════════════════

/**
 * **Deleting dead ASINs** (owner's report: some ASINs in the pool have no page
 * on Amazon — "Sorry, not found").
 *
 * **The one real claim of this describe: deleting does not mean forgetting.**
 * Delete used to be a real `DELETE`, which removed the `asin` UNIQUE guard
 * along with the row — if someone pasted that dead ASIN again tomorrow, it
 * would enter as new work, be allocated, and a designer would again find
 * "Sorry, not found". The second test below guards that cycle.
 */
describe('deleting dead ASINs', () => {
  /**
   * **The session is returned, and that is deliberate** — calling
   * `loginReady()` a second time in one test gives a 401 (lesson of 25 August,
   * `0a96d75`). So the test uses the session created while filling the pool.
   */
  async function seedPool(count: number): Promise<Session> {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: Array.from({ length: count }, (_, i) => URL_OF(i + 1)).join('\n'),
    }).expect(201);
    return owner;
  }

  const ids = async (): Promise<number[]> =>
    (
      await h.prisma.designTarget.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((r) => r.id);

  it('the row stays, but no longer gets allocated', async () => {
    await staff('OX-D1', 'designer', 'd1@test.local');
    const owner = await seedPool(5);

    const res = await post(owner, '/api/v1/design-targets/delete', {
      ids: (await ids()).slice(0, 2),
      reason: 'not_found',
    }).expect(201);

    expect(res.body).toEqual({ deleted: 2, keptDone: 0 });

    // All five are in the table — not deleted, marked
    expect(await h.prisma.designTarget.count()).toBe(5);
    expect(
      await h.prisma.designTarget.count({ where: { status: 'deleted' } }),
    ).toBe(2);

    await h.app.get(TargetsService).distribute();

    expect(
      await h.prisma.designTarget.count({ where: { status: 'assigned' } }),
    ).toBe(3);
  });

  /**
   * **This one test is the reason for the whole change.** Without the row,
   * `ON CONFLICT (asin) DO NOTHING` would block nothing.
   */
  it('a deleted ASIN pasted again does not return to the pool', async () => {
    const owner = await seedPool(1);

    await post(owner, '/api/v1/design-targets/delete', {
      ids: await ids(),
      reason: 'not_found',
    }).expect(201);

    const again = await post(owner, '/api/v1/design-targets/bulk', {
      text: URL_OF(1),
    }).expect(201);

    expect(again.body.added).toBe(0);
    expect(again.body.alreadyKnown).toBe(1);
    expect(
      await h.prisma.designTarget.count({ where: { status: 'pool' } }),
    ).toBe(0);
  });

  /**
   * Deleting finished work would lower the designer's count for the day, and
   * the item would silently disappear from the upload queue too.
   */
  it('finished rows are not touched, and that is counted and reported', async () => {
    const owner = await seedPool(2);
    const [first, second] = await ids();

    await h.prisma.designTarget.update({
      where: { id: first },
      data: { status: 'done', completedAt: dhakaNoon(), completedVia: 'manual' },
    });

    const res = await post(owner, '/api/v1/design-targets/delete', {
      ids: [first, second],
      reason: 'copyright',
    }).expect(201);

    expect(res.body).toEqual({ deleted: 1, keptDone: 1 });
    expect(
      (await h.prisma.designTarget.findUniqueOrThrow({ where: { id: first } }))
        .status,
    ).toBe('done');
  });

  /**
   * **The most useful case** — the designer opens the link and only then
   * realises the page is gone, so the row is **in their hand** at that point.
   */
  it('deleting a row in hand removes it from the list, and a replacement comes at the next allocation', async () => {
    const designer = await staff('OX-D1', 'designer', 'd1@test.local');
    const owner = await seedPool(31);
    const targets = h.app.get(TargetsService);
    await targets.distribute();

    const mine = await targets.mine(designer.id);
    expect(mine).toHaveLength(30);

    await post(owner, '/api/v1/design-targets/delete', {
      ids: [mine[0].id],
      reason: 'not_found',
    }).expect(201);

    expect(await targets.mine(designer.id)).toHaveLength(29);

    // The in-hand count is 29, 1 is left in the pool — so the replacement comes anyway
    await targets.distribute();
    expect(await targets.mine(designer.id)).toHaveLength(30);
  });

  /** The same id arriving twice would inflate the count */
  it('giving the same id twice counts it once', async () => {
    const owner = await seedPool(1);
    const [only] = await ids();

    const res = await post(owner, '/api/v1/design-targets/delete', {
      ids: [only, only],
      reason: 'events',
    }).expect(201);

    expect(res.body.deleted).toBe(1);
  });

  /** A second delete would add a second audit row, though nothing happened */
  it('deleting an already deleted row again does nothing', async () => {
    const owner = await seedPool(1);
    const only = await ids();

    await post(owner, '/api/v1/design-targets/delete', {
      ids: only,
      reason: 'not_found',
    }).expect(201);
    const twice = await post(owner, '/api/v1/design-targets/delete', {
      ids: only,
      reason: 'not_found',
    }).expect(201);

    expect(twice.body).toEqual({ deleted: 0, keptDone: 0 });
    expect(
      await h.prisma.auditLog.count({ where: { action: 'design_deleted' } }),
    ).toBe(1);
  });

  /** The single route does the same — two different behaviours would one day go wrong */
  it('the single DELETE does not remove the row either, it marks it', async () => {
    const owner = await seedPool(1);
    const [only] = await ids();

    await owner.http
      .delete(`/api/v1/design-targets/${only}?reason=copyright`)
      .set('X-CSRF-Token', owner.csrf)
      .expect(200);

    expect(
      (await h.prisma.designTarget.findUniqueOrThrow({ where: { id: only } }))
        .status,
    ).toBe('deleted');
  });
});
// ════════════════════════════════════════════════════════════════════════════

/**
 * **"Why was it dropped" — three reasons, one for both routes** (owner's
 * request: add "Not Found, Copyright, Events"; a designer pressing Skip
 * should get the same 3 options).
 *
 * The most important claim: **there is no route without a reason**. The field
 * used to be optional, and as a result none of the 93 skipped rows in the field had a reason.
 */
describe('reason for dropping', () => {
  async function seedPool(count: number): Promise<Session> {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: Array.from({ length: count }, (_, i) => URL_OF(i + 1)).join('\n'),
    }).expect(201);
    return owner;
  }

  it('on Delete the reason is stored on the row', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.designTarget.findFirstOrThrow();

    await post(owner, '/api/v1/design-targets/delete', {
      ids: [row.id],
      reason: 'copyright',
    }).expect(201);

    const after = await h.prisma.designTarget.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe('deleted');
    expect(after.dropReason).toBe('copyright');
  });

  /** With a route that deletes without a reason, the field would be empty again */
  it('Delete without a reason is rejected', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.designTarget.findFirstOrThrow();

    await post(owner, '/api/v1/design-targets/delete', {
      ids: [row.id],
    }).expect(400);

    expect(
      (await h.prisma.designTarget.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe('pool');
  });

  /** A reason outside the list cannot be accepted — otherwise the counts would mean nothing */
  it('an unknown reason is rejected', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.designTarget.findFirstOrThrow();

    await post(owner, '/api/v1/design-targets/delete', {
      ids: [row.id],
      reason: 'boring',
    }).expect(400);
  });

  /** The designer's Skip — the same three reasons, the same field */
  it('on Skip the reason goes in the same field', async () => {
    const designer = await staff('OX-D1', 'designer', 'd1@test.local');
    await seedPool(1);
    await h.app.get(TargetsService).distribute();

    const staffSession = await loginReady(
      h,
      'd1@test.local',
      'staff-password-123',
    );
    const mine = await h.app.get(TargetsService).mine(designer.id);

    await post(staffSession, `/api/v1/me/targets/${mine[0].id}/skip`, {
      reason: 'events',
    }).expect(201);

    const after = await h.prisma.designTarget.findUniqueOrThrow({
      where: { id: mine[0].id },
    });
    expect(after.status).toBe('skipped');
    expect(after.dropReason).toBe('events');
  });

  it('Skip without a reason is rejected', async () => {
    const designer = await staff('OX-D1', 'designer', 'd1@test.local');
    await seedPool(1);
    await h.app.get(TargetsService).distribute();

    const staffSession = await loginReady(
      h,
      'd1@test.local',
      'staff-password-123',
    );
    const mine = await h.app.get(TargetsService).mine(designer.id);

    await post(staffSession, `/api/v1/me/targets/${mine[0].id}/skip`, {}).expect(
      400,
    );

    expect(
      (
        await h.prisma.designTarget.findUniqueOrThrow({
          where: { id: mine[0].id },
        })
      ).status,
    ).toBe('assigned');
  });

  /**
   * **Undelete — the row returns to the pool, and the reason is erased too**
   * (owner's instruction: a deleted design should show only Undelete).
   *
   * If the reason were not erased, the row would return to the pool still
   * marked "Not Found", and whoever got it at the next allocation would see a
   * warning that was already settled.
   */
  it('when returned to the pool, the reason is erased too', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.designTarget.findFirstOrThrow();

    await post(owner, '/api/v1/design-targets/delete', {
      ids: [row.id],
      reason: 'not_found',
    }).expect(201);

    await owner.http
      .patch(`/api/v1/design-targets/${row.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ status: 'pool' })
      .expect(200);

    const back = await h.prisma.designTarget.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(back.status).toBe('pool');
    expect(back.dropReason).toBeNull();
  });

  /** The reason goes into the list too — otherwise there would be no way to show it on screen */
  it('the list row returns the reason', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.designTarget.findFirstOrThrow();

    await post(owner, '/api/v1/design-targets/delete', {
      ids: [row.id],
      reason: 'not_found',
    }).expect(201);

    const list = await owner.http
      .get('/api/v1/design-targets?status=deleted')
      .expect(200);

    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].dropReason).toBe('not_found');
  });
});
// ════════════════════════════════════════════════════════════════════════════

/**
 * **Review queue for dropped designs** (owner's request: the owner and the
 * manager should be able to manage the designs that were deleted or skipped).
 *
 * The most important claim is the second: **old rows without a reason do not
 * enter the queue**. Otherwise the queue would start on day one with 97 rows —
 * and nobody starts when they see a mountain (the upload queue made exactly
 * this mistake on 24 August).
 */
describe('review queue — dropped designs', () => {
  async function seedPool(count: number): Promise<Session> {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/design-targets/bulk', {
      text: Array.from({ length: count }, (_, i) => URL_OF(i + 1)).join('\n'),
    }).expect(201);
    return owner;
  }

  const queue = (session: Session) =>
    session.http.get('/api/v1/design-targets?stage=to_review').expect(200);

  it('a row deleted with a reason enters the queue', async () => {
    const owner = await seedPool(2);
    const [first] = (
      await h.prisma.designTarget.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((r) => r.id);

    await post(owner, '/api/v1/design-targets/delete', {
      ids: [first],
      reason: 'copyright',
    }).expect(201);

    const list = await queue(owner);
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].dropReason).toBe('copyright');
    expect(list.body.rows[0].reviewedAt).toBeNull();
  });

  /**
   * **This test keeps the queue usable.** The reason requirement dates from
   * 31 August, so `skipped` rows before it have nothing written — there is
   * nothing for the manager to "look over".
   */
  it('old rows without a reason do not enter the queue', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.designTarget.findFirstOrThrow();

    // A fake old row — status `skipped`, but no reason
    await h.prisma.designTarget.update({
      where: { id: row.id },
      data: { status: 'skipped', dropReason: null },
    });

    expect((await queue(owner)).body.rows).toHaveLength(0);
  });

  it('pressing "seen" removes it from the queue, but the status does not change', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.designTarget.findFirstOrThrow();

    await post(owner, '/api/v1/design-targets/delete', {
      ids: [row.id],
      reason: 'not_found',
    }).expect(201);

    await post(owner, `/api/v1/design-targets/${row.id}/reviewed`, {}).expect(201);

    expect((await queue(owner)).body.rows).toHaveLength(0);

    const after = await h.prisma.designTarget.findUniqueOrThrow({
      where: { id: row.id },
    });
    // An acknowledgement, not a decision — the row stays `deleted`
    expect(after.status).toBe('deleted');
    expect(after.reviewedAt).not.toBeNull();
    expect(after.reviewedById).not.toBeNull();
  });

  /** If the chip count and the list count differ, both become unbelievable */
  it('the chip count and the list count are exactly the same', async () => {
    const owner = await seedPool(3);
    const ids = (
      await h.prisma.designTarget.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((r) => r.id);

    await post(owner, '/api/v1/design-targets/delete', {
      ids: ids.slice(0, 2),
      reason: 'events',
    }).expect(201);

    const stats = await owner.http.get('/api/v1/design-targets/stats').expect(200);
    expect(stats.body.toReview).toBe(2);
    expect((await queue(owner)).body.rows).toHaveLength(2);
  });

  /**
   * When it returns to the pool the mark is erased too — otherwise if someone
   * skipped it again later, the row **would not enter the queue** because of an old mark.
   */
  it('when returned to the pool, the "seen" mark is erased too', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.designTarget.findFirstOrThrow();

    await post(owner, '/api/v1/design-targets/delete', {
      ids: [row.id],
      reason: 'not_found',
    }).expect(201);
    await post(owner, `/api/v1/design-targets/${row.id}/reviewed`, {}).expect(201);

    await owner.http
      .patch(`/api/v1/design-targets/${row.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ status: 'pool' })
      .expect(200);

    const back = await h.prisma.designTarget.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(back.reviewedAt).toBeNull();
    expect(back.reviewedById).toBeNull();
  });

  /** Not the researcher — the owner said "the owner and the manager" */
  it('a researcher cannot press "seen"', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.designTarget.findFirstOrThrow();
    await post(owner, '/api/v1/design-targets/delete', {
      ids: [row.id],
      reason: 'not_found',
    }).expect(201);

    await staff('OX-R1', 'researcher', 'r1@test.local', 'researcher');
    const researcher = await loginReady(h, 'r1@test.local', 'staff-password-123');

    await post(
      researcher,
      `/api/v1/design-targets/${row.id}/reviewed`,
      {},
    ).expect(403);
  });
});
