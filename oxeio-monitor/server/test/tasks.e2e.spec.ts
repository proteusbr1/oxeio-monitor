import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import { FeaturesService } from '../src/features/features.service';
import { TasksHandoutService } from '../src/tasks/tasks.handout.service';
import { TasksPersonService } from '../src/tasks/tasks.person.service';
import { TasksService } from '../src/tasks/tasks.service';
import { TasksStageService } from '../src/tasks/tasks.stage.service';
import { BULK_MAX_LINES, TASK_NUMBER_START } from '../src/tasks/tasks.rules';
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
  workNoon,
} from './setup/harness';

/**
 * **Tasks — adding, hand-out, queues and review.**
 *
 * The two most important claims of this file:
 * 1. **A coordinator can add tasks, an ordinary assignee cannot** — and both
 *    may be linked to staff rows, so the permission follows the portal role,
 *    not whether the person receives tasks.
 * 2. **A task never lands in two people's hands** — otherwise two people
 *    would do the same work and nobody could tell.
 */

let h: Harness;

/** A generic reference: `INV-0001`, `INV-0002`, … */
const REF_OF = (n: number) => `INV-${String(n).padStart(4, '0')}`;
const BR = String.fromCharCode(10);
const refs = (count: number) =>
  Array.from({ length: count }, (_, i) => REF_OF(i + 1)).join(BR);

const STAFF_PASSWORD = 'staff-password-123';

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

/**
 * Employee + portal account.
 *
 * `receivesTasks` and `role` are separate on purpose: `receivesTasks` says
 * **whether work is handed to them**, `role` says **what they can see and
 * do**. The tests below try the two in matching and mismatching combinations.
 */
async function staff(
  empCode: string,
  email: string,
  opts: {
    receivesTasks?: boolean;
    dailyTaskTarget?: number | null;
    role?: 'employee' | 'coordinator';
  } = {},
) {
  const employee = await h.prisma.employee.create({
    data: {
      empCode,
      fullName: empCode,
      status: 'active',
      receivesTasks: opts.receivesTasks ?? false,
      dailyTaskTarget: opts.dailyTaskTarget ?? null,
    },
  });

  await h.prisma.user.create({
    data: {
      email,
      fullName: empCode,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      role: opts.role ?? 'employee',
      employeeId: employee.id,
      // Without `false` they would be stuck at the "change password" wall after login
      mustChangePw: false,
    },
  });

  return employee;
}

/** Someone who is handed tasks every morning */
const assignee = (empCode: string, email: string) =>
  staff(empCode, email, { receivesTasks: true });

/** Someone who adds and checks tasks but is not handed any */
const coordinator = (empCode: string, email: string) =>
  staff(empCode, email, { role: 'coordinator' });

const post = (session: Session, path: string, body: object) =>
  session.http.post(path).set('X-CSRF-Token', session.csrf).send(body);

const svc = () => h.app.get(TasksService);
const handout = () => h.app.get(TasksHandoutService);
const person = () => h.app.get(TasksPersonService);
const stage = () => h.app.get(TasksStageService);

/**
 * The owner's session, with tasks pasted.
 *
 * Careful: the session is returned on purpose. In the harness the owner has
 * `mustChangePw: true`, so `loginReady` changes the password on the first
 * login; a second `loginReady(OWNER_PASSWORD)` in the same test gives a 401
 * that has nothing to do with the test's claim.
 */
async function seedPool(count: number): Promise<Session> {
  const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
  await post(owner, '/api/v1/tasks/bulk', { text: refs(count) }).expect(201);
  return owner;
}

// ════════════════════════════════════════════════════════════════════════════

describe('POST /tasks/bulk — who may add', () => {
  it('a coordinator (role) may', async () => {
    await coordinator('OX-C1', 'c1@test.local');
    const session = await loginReady(h, 'c1@test.local', STAFF_PASSWORD);

    const res = await post(session, '/api/v1/tasks/bulk', {
      text: [REF_OF(1), REF_OF(2)].join(BR),
    }).expect(201);

    expect(res.body.added).toBe(2);
    expect(res.body.poolSize).toBe(2);
  });

  it('an assignee may not', async () => {
    await assignee('OX-A1', 'a1@test.local');
    const session = await loginReady(h, 'a1@test.local', STAFF_PASSWORD);

    await post(session, '/api/v1/tasks/bulk', { text: REF_OF(1) }).expect(403);
  });

  /**
   * **Receiving tasks and the right to add them are different things.** An
   * employee who receives no tasks is still just an employee: no access.
   */
  it('an employee who receives no tasks may not either', async () => {
    await staff('OX-E2', 'e2@test.local');
    const session = await loginReady(h, 'e2@test.local', STAFF_PASSWORD);

    await post(session, '/api/v1/tasks/bulk', { text: REF_OF(1) }).expect(403);
  });

  /** The reverse is true too — the role has the last word, not `receivesTasks` */
  it('a coordinator who also receives tasks — may', async () => {
    await staff('OX-C2', 'c2@test.local', {
      receivesTasks: true,
      role: 'coordinator',
    });
    const session = await loginReady(h, 'c2@test.local', STAFF_PASSWORD);

    await post(session, '/api/v1/tasks/bulk', { text: REF_OF(1) }).expect(201);
  });

  it('the owner and manager may', async () => {
    for (const [email, password] of [
      [OWNER_EMAIL, OWNER_PASSWORD],
      [MANAGER_EMAIL, MANAGER_PASSWORD],
    ]) {
      const session = await loginReady(h, email, password);
      await post(session, '/api/v1/tasks/bulk', {
        text: REF_OF(email === OWNER_EMAIL ? 10 : 20),
      }).expect(201);
    }
  });
});

describe('POST /tasks/bulk — lines, links and duplicates', () => {
  /**
   * **A single old reference among 500 would cancel the whole batch** —
   * without the duplicate guard, a coordinator's whole paste would be lost.
   * The known one comes back in `rejected` as `already_exists`.
   */
  it('a reference already added earlier does not cancel the batch', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    await post(owner, '/api/v1/tasks/bulk', {
      text: [REF_OF(1), REF_OF(2)].join(BR),
    }).expect(201);

    const res = await post(owner, '/api/v1/tasks/bulk', {
      text: [REF_OF(2), REF_OF(3)].join(BR),
    }).expect(201);

    expect(res.body.added).toBe(1);
    expect(res.body.alreadyKnown).toBe(1);
    expect(res.body.poolSize).toBe(3);
    expect(res.body.rejected).toEqual([
      { line: 1, text: REF_OF(2), reason: 'already_exists' },
    ]);
    expect(res.body.rejectedTotal).toBe(1);
  });

  /** The three line forms: `ref`, `ref | link`, bare URL */
  it('each line form is stored with the right reference and link', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await post(owner, '/api/v1/tasks/bulk', {
      text: [
        'INV-1001',
        'TICKET-7 | https://example.com/tickets/7',
        'https://example.com/x',
        '   INV-1002   ',
        'INV-1003 |',
      ].join(BR),
    }).expect(201);

    expect(res.body.added).toBe(5);
    expect(res.body.rejected).toEqual([]);

    const rows = await h.prisma.task.findMany({
      select: { reference: true, link: true, status: true, taskNumber: true },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => [r.reference, r.link])).toEqual([
      ['INV-1001', null],
      ['TICKET-7', 'https://example.com/tickets/7'],
      // A bare URL names the task and is its link
      ['https://example.com/x', 'https://example.com/x'],
      // Surrounding spaces are trimmed
      ['INV-1002', null],
      // An empty right side is "no link", not a mistake
      ['INV-1003', null],
    ]);
    expect(rows.every((r) => r.status === 'pool')).toBe(true);
  });

  /** Rejected lines come back with the reason — otherwise nobody would know which were lost */
  it('rejected lines come back with their line number and reason', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const long = 'x'.repeat(201);
    const longLink = `INV-0011 | https://example.com/${'a'.repeat(500)}`;

    const res = await post(owner, '/api/v1/tasks/bulk', {
      text: [
        REF_OF(1),
        '',
        long,
        'INV-0006 | ftp://example.com/x',
        'INV-0007 | javascript:alert(1)',
        'INV-0008 | not a link',
        longLink,
        REF_OF(1),
      ].join(BR),
    }).expect(201);

    expect(res.body.added).toBe(1);
    expect(res.body.alreadyKnown).toBe(0);
    expect(res.body.rejectedTotal).toBe(6);
    expect(
      res.body.rejected.map((r: { line: number; reason: string }) => [r.line, r.reason]),
    ).toEqual([
      [3, 'too_long'],
      [4, 'bad_link'],
      [5, 'bad_link'],
      [6, 'bad_link'],
      [7, 'too_long'],
      [8, 'duplicate_in_paste'],
    ]);
    expect(res.body.rejected[1].text).toBe('INV-0006 | ftp://example.com/x');
    expect(await h.prisma.task.count()).toBe(1);
  });

  it('a known reference pasted with a new link is still already_exists, and the link is not changed', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/tasks/bulk', {
      text: 'TICKET-7 | https://example.com/tickets/7',
    }).expect(201);

    const res = await post(owner, '/api/v1/tasks/bulk', {
      text: 'TICKET-7 | https://example.com/other',
    }).expect(201);

    expect(res.body.added).toBe(0);
    expect(res.body.alreadyKnown).toBe(1);
    expect(res.body.rejected).toEqual([
      { line: 1, text: 'TICKET-7 | https://example.com/other', reason: 'already_exists' },
    ]);
    const row = await h.prisma.task.findUniqueOrThrow({ where: { reference: 'TICKET-7' } });
    expect(row.link).toBe('https://example.com/tickets/7');
  });

  /** More than the ceiling is refused whole — nothing is half-added */
  it(`more than ${BULK_MAX_LINES} lines is a 400, and nothing is added`, async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    await post(owner, '/api/v1/tasks/bulk', {
      text: refs(BULK_MAX_LINES + 1),
    }).expect(400);

    expect(await h.prisma.task.count()).toBe(0);
  });

  /** Blank lines do not count towards the ceiling */
  it(`exactly ${BULK_MAX_LINES} lines, with blank lines between, is accepted`, async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await post(owner, '/api/v1/tasks/bulk', {
      text: `${refs(BULK_MAX_LINES)}${BR}${BR}${BR}`,
    }).expect(201);

    expect(res.body.added).toBe(BULK_MAX_LINES);
  });

  /** The link is returned in the full list and in the assignee's own list */
  it('the link comes back in GET /tasks and GET /me/tasks', async () => {
    const one = await assignee('OX-A1', 'a1@test.local');
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/tasks/bulk', {
      text: 'TICKET-7 | https://example.com/tickets/7',
    }).expect(201);

    const list = await owner.http.get('/api/v1/tasks').expect(200);
    expect(list.body.rows[0].reference).toBe('TICKET-7');
    expect(list.body.rows[0].link).toBe('https://example.com/tickets/7');

    await handout().distribute();

    const session = await loginReady(h, 'a1@test.local', STAFF_PASSWORD);
    const mine = await session.http.get('/api/v1/me/tasks').expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({
      reference: 'TICKET-7',
      link: 'https://example.com/tickets/7',
      completedAt: null,
    });
    expect(mine.body[0].taskNumber).toBeGreaterThanOrEqual(TASK_NUMBER_START);
    expect(
      (await h.prisma.task.findFirstOrThrow()).assignedToId,
    ).toBe(one.id);
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe('allocation', () => {
  /**
   * **A task never lands in two people's hands.** If it did, two people
   * would do the same work — and it would be caught only at delivery.
   */
  it('30 each, and no task twice', async () => {
    await assignee('OX-A1', 'a1@test.local');
    await assignee('OX-A2', 'a2@test.local');
    await seedPool(100);

    await handout().distribute();

    const rows = await h.prisma.task.findMany({
      where: { status: 'assigned' },
      select: { id: true, assignedToId: true, taskNumber: true },
    });

    expect(rows).toHaveLength(60);
    // Every row belongs to exactly one person — `id` is unique, so the count is the claim
    expect(new Set(rows.map((r) => r.id)).size).toBe(60);

    const perAssignee = new Map<number | null, number>();
    for (const r of rows) {
      perAssignee.set(r.assignedToId, (perAssignee.get(r.assignedToId) ?? 0) + 1);
    }
    expect([...perAssignee.values()]).toEqual([30, 30]);
  });

  /**
   * **Task numbers are above a million, and never repeated.** If they fell
   * lower, short numbers people already put at the start of file names would
   * wrongly mark a task started.
   */
  it('task numbers are unique and above a million', async () => {
    await assignee('OX-A1', 'a1@test.local');
    await seedPool(40);

    await handout().distribute();

    const numbers = (
      await h.prisma.task.findMany({
        where: { status: 'assigned' },
        select: { taskNumber: true },
      })
    ).map((r) => r.taskNumber!);

    expect(numbers).toHaveLength(30);
    expect(new Set(numbers).size).toBe(30);
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(TASK_NUMBER_START);
  });

  /** No more is given when the hand is full — otherwise two hundred would pile up in a week */
  it('running a second time adds nothing', async () => {
    await assignee('OX-A1', 'a1@test.local');
    await seedPool(100);

    await handout().distribute();
    const second = await handout().distribute();

    expect(second.assigned).toBe(0);
    expect(await h.prisma.task.count({ where: { status: 'assigned' } })).toBe(30);
  });

  /** No crash when the pool is empty — this is what happens when nobody added any */
  it('when the pool is empty, quietly nothing happens', async () => {
    await assignee('OX-A1', 'a1@test.local');

    expect((await handout().distribute()).assigned).toBe(0);
  });

  it('POST /tasks/distribute: owner and manager only', async () => {
    await assignee('OX-A1', 'a1@test.local');
    const owner = await seedPool(5);
    await coordinator('OX-C1', 'c1@test.local');
    const coord = await loginReady(h, 'c1@test.local', STAFF_PASSWORD);

    await post(coord, '/api/v1/tasks/distribute', {}).expect(403);

    const res = await post(owner, '/api/v1/tasks/distribute', {}).expect(201);
    expect(res.body.assigned).toBe(5);
  });
});

describe('GET /tasks/assignees', () => {
  it('lists everyone who ever held a task; a coordinator may see it, an assignee may not', async () => {
    const a1 = await assignee('OX-A1', 'a1@test.local');
    await assignee('OX-A2', 'a2@test.local');
    await seedPool(40);
    // 40 in the pool: 30 to the first by staff code and 10 to the second,
    // so both appear
    await handout().distribute();
    // Someone who never held a task is not listed
    await coordinator('OX-C1', 'c1@test.local');

    const coord = await loginReady(h, 'c1@test.local', STAFF_PASSWORD);
    const res = await coord.http.get('/api/v1/tasks/assignees').expect(200);

    expect(res.body.map((e: { empCode: string }) => e.empCode)).toEqual([
      'OX-A1',
      'OX-A2',
    ]);
    expect(res.body[0]).toEqual({ id: a1.id, empCode: 'OX-A1', fullName: 'OX-A1' });

    const mine = await loginReady(h, 'a1@test.local', STAFF_PASSWORD);
    await mine.http.get('/api/v1/tasks/assignees').expect(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe('detecting "work started" from a window title', () => {
  /**
   * **This is "start", not "finish"** — and that difference is the whole
   * point here. The number shows in the title at the moment the window is
   * **opened**; treating it as "finish" would close a task the moment it
   * was opened.
   */
  it('with their own number on their own task, a "started" mark is set, it does not close', async () => {
    const one = await assignee('OX-A1', 'a1@test.local');
    await seedPool(1);

    await handout().distribute();

    const row = await h.prisma.task.findFirstOrThrow();
    const seenAt = new Date(workNoon().getTime() + 37 * 60_000);
    const started = await person().markStartedByTaskNumbers(
      one.id,
      new Map([[String(row.taskNumber), seenAt]]),
    );

    expect(started).toBe(1);
    const after = await h.prisma.task.findFirstOrThrow();
    // Still in the assignee's hands — they say "finished" themselves
    expect(after.status).toBe('assigned');
    expect(after.completedAt).toBeNull();

    /**
     * **Exactly the moment that was given is the one stored.** A weak
     * `not.toBeNull()` here once hid a caller passing the work day's label,
     * which gave every task the same "started" time.
     */
    expect(after.startedAt?.toISOString()).toBe(seenAt.toISOString());
  });

  /**
   * **One person's window cannot start another's task.** The number is not
   * supposed to be in two people's hands, but "not supposed to" is not the
   * same as "cannot".
   */
  it("nothing is marked with someone else's number", async () => {
    await assignee('OX-A1', 'a1@test.local');
    const other = await assignee('OX-A2', 'a2@test.local');
    await seedPool(1);

    await handout().distribute();

    const row = await h.prisma.task.findFirstOrThrow();
    // The row belongs to OX-A1 (first in staff-code order), but OX-A2 is
    // the one whose window showed it
    const started = await person().markStartedByTaskNumbers(
      other.id,
      new Map([[String(row.taskNumber), workNoon()]]),
    );

    expect(started).toBe(0);
    expect((await h.prisma.task.findFirstOrThrow()).startedAt).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe('return to the pool at day end', () => {
  const TODAY = workNoon();

  /**
   * The rule: whatever is left untouched at day end comes back to the pool
   * — 30 given, none started, all 30 return.
   */
  it('tasks not worked on return to the pool', async () => {
    await assignee('OX-A1', 'a1@test.local');
    await seedPool(40);

    await handout().distribute();
    expect(await h.prisma.task.count({ where: { status: 'assigned' } })).toBe(30);

    const { returned } = await handout().returnUnworked(workDateOf(TODAY));

    expect(returned).toBe(30);
    expect(await h.prisma.task.count({ where: { status: 'pool' } })).toBe(40);
    // Nobody has anything left in hand
    expect(
      await h.prisma.task.count({ where: { assignedToId: { not: null } } }),
    ).toBe(0);
  });

  /**
   * **The most important test in this block.** Someone opened a task and
   * started work but could not finish today — under the simple rule it would
   * go back too and land with someone else tomorrow. Two people's work
   * wasted, and nobody would understand why.
   */
  it('a task touched today is not returned', async () => {
    const one = await assignee('OX-A1', 'a1@test.local');
    await seedPool(40);

    await handout().distribute();

    const mine = await h.prisma.task.findMany({
      where: { assignedToId: one.id },
      select: { id: true, taskNumber: true },
      take: 2,
    });

    // "Touched" = the number was seen on screen, i.e. it is in today's credit
    await h.prisma.taskCredit.create({
      data: {
        employeeId: one.id,
        taskNumber: String(mine[0].taskNumber),
        firstWorkDate: workDateOf(TODAY),
      },
    });

    const { returned } = await handout().returnUnworked(workDateOf(TODAY));

    expect(returned).toBe(29);
    const kept = await h.prisma.task.findUniqueOrThrow({ where: { id: mine[0].id } });
    expect(kept.status).toBe('assigned');
    expect(kept.assignedToId).toBe(one.id);
  });

  /**
   * **The task number is not erased.** The number belongs to the task, not
   * to the hand-out — clearing it would burn numbers for nothing, and old
   * window titles would never match anything again.
   */
  it('even when returned the number stays the same, and no new number is set the next time', async () => {
    await assignee('OX-A1', 'a1@test.local');
    await seedPool(40);

    await handout().distribute();

    const before = await h.prisma.task.findMany({
      where: { status: 'assigned' },
      select: { id: true, taskNumber: true },
      orderBy: { id: 'asc' },
    });

    await handout().returnUnworked(workDateOf(TODAY));
    await handout().distribute();

    const after = await h.prisma.task.findMany({
      where: { id: { in: before.map((b) => b.id) } },
      select: { id: true, taskNumber: true },
      orderBy: { id: 'asc' },
    });

    const byId = new Map(after.map((a) => [a.id, a.taskNumber]));
    for (const b of before) expect(byId.get(b.id)).toBe(b.taskNumber);
  });

  /** A finished task is not returned — it is nobody's work any more */
  it('finished and dropped tasks are not touched', async () => {
    const one = await assignee('OX-A1', 'a1@test.local');
    await seedPool(40);

    await handout().distribute();

    const mine = await h.prisma.task.findMany({
      where: { assignedToId: one.id },
      select: { id: true },
      take: 2,
    });
    /**
     * The third parameter is **who pressed it**. This test's question is not
     * "who" but "how many go back", so any valid user will do — it is taken
     * from the database because the FK must be satisfied.
     */
    const anyUser = await h.prisma.user.findFirstOrThrow({ select: { id: true } });
    await person().markDone(one.id, mine[0].id, anyUser.id);
    await person().skip(one.id, mine[1].id, 'not_needed');

    const { returned } = await handout().returnUnworked(workDateOf(TODAY));

    expect(returned).toBe(28);
    expect(await h.prisma.task.count({ where: { status: 'done' } })).toBe(1);
    expect(await h.prisma.task.count({ where: { status: 'skipped' } })).toBe(1);
  });
});

describe('started tasks', () => {
  /**
   * **A task with work in progress does not go back at night.** The
   * "touched today" condition was narrower than this: work running for three
   * days would go back on the day nobody opened it, and land with someone
   * else tomorrow.
   */
  it('a task started earlier is still in hand the next day', async () => {
    const one = await assignee('OX-A1', 'a1@test.local');
    await seedPool(40);

    await handout().distribute();

    const row = await h.prisma.task.findFirstOrThrow({
      where: { assignedToId: one.id },
    });
    // Started yesterday, nobody opened it today
    await h.prisma.task.update({
      where: { id: row.id },
      data: { startedAt: workNoon(-1) },
    });

    await handout().returnUnworked(workDateOf(workNoon()));

    const after = await h.prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('assigned');
    expect(after.assignedToId).toBe(one.id);
  });
});

describe('task number', () => {
  /**
   * **Every task has a number, from the moment it is added.** A row sitting
   * in the pool has an identity people can point at.
   */
  it('gets a number as soon as it is in the pool, and all are different', async () => {
    await seedPool(3);

    const rows = await h.prisma.task.findMany({
      select: { status: true, taskNumber: true },
    });

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'pool')).toBe(true);
    expect(rows.every((r) => r.taskNumber !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.taskNumber)).size).toBe(3);
  });

  /** The number does **not change** on hand-out — it belongs to the task */
  it('the number stays the same after hand-out', async () => {
    await assignee('OX-A1', 'a1@test.local');
    await seedPool(1);

    const before = await h.prisma.task.findFirstOrThrow();
    await handout().distribute();
    const after = await h.prisma.task.findFirstOrThrow();

    expect(after.taskNumber).toBe(before.taskNumber);
    expect(after.status).toBe('assigned');
  });

  /** A known reference must not burn a number from the sequence */
  it('pasting a known reference again does not use up a number', async () => {
    const owner = await seedPool(1);
    await post(owner, '/api/v1/tasks/bulk', { text: REF_OF(1) }).expect(201);
    await post(owner, '/api/v1/tasks/bulk', { text: REF_OF(2) }).expect(201);

    const rows = await h.prisma.task.findMany({
      select: { taskNumber: true },
      orderBy: { id: 'asc' },
    });
    expect(rows[1].taskNumber).toBe(rows[0].taskNumber! + 1);
  });
});

/**
 * **Searching the task list — by reference or task number.**
 *
 * The screen shows the task number large under every row, so it must be
 * searchable too, not only the reference.
 */
describe('searching the task list — by reference or task number', () => {
  /** Sets up three tasks and returns their references and numbers */
  async function seed() {
    const owner = await seedPool(3);

    const rows = await h.prisma.task.findMany({
      select: { reference: true, taskNumber: true },
      orderBy: { reference: 'asc' },
    });

    return { owner, rows };
  }

  const search = (session: Session, q: string) =>
    session.http.get(`/api/v1/tasks?q=${encodeURIComponent(q)}`);

  it('can search by reference', async () => {
    const { owner, rows } = await seed();

    const res = await search(owner, rows[0].reference).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].reference).toBe(rows[0].reference);
  });

  /** Part of a reference matches too */
  it('part of a reference finds every match', async () => {
    const { owner } = await seed();

    const res = await search(owner, 'INV-000').expect(200);

    expect(res.body.total).toBe(3);
  });

  /**
   * The task number is matched **exactly**, not with `contains` — the column
   * is `Int`, and a partial match of a number means nothing to a person.
   */
  it('can search by task number too', async () => {
    const { owner, rows } = await seed();
    const task = rows[1];

    const res = await search(owner, String(task.taskNumber)).expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].reference).toBe(task.reference);
    expect(res.body.rows[0].taskNumber).toBe(task.taskNumber);
  });

  /**
   * **Another number gives another row** — otherwise the test would go green
   * just from seeing "some row came back".
   */
  it('a different task number brings a different row', async () => {
    const { owner, rows } = await seed();

    const first = await search(owner, String(rows[0].taskNumber)).expect(200);
    const last = await search(owner, String(rows[2].taskNumber)).expect(200);

    expect(first.body.rows[0].reference).toBe(rows[0].reference);
    expect(last.body.rows[0].reference).toBe(rows[2].reference);
    expect(first.body.rows[0].reference).not.toBe(last.body.rows[0].reference);
  });

  /**
   * **A reference made only of digits is found too.** Searching only by task
   * number would silently lose such a row.
   */
  it('an all-digit reference is found by its digits', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/tasks/bulk', { text: '4417' }).expect(201);

    const res = await search(owner, '4417').expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].reference).toBe('4417');
  });

  /** The link is not searched — only the reference and the number */
  it('the link of a `ref | link` row is not searched', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await post(owner, '/api/v1/tasks/bulk', {
      text: 'TICKET-7 | https://example.com/tickets/7',
    }).expect(201);

    expect((await search(owner, 'example.com').expect(200)).body.total).toBe(0);
    expect((await search(owner, 'ticket-7').expect(200)).body.total).toBe(1);
  });

  /** Lower case works too — people copy references in all kinds of ways */
  it('a lower-case reference works too', async () => {
    const { owner, rows } = await seed();

    const res = await search(owner, rows[0].reference.toLowerCase()).expect(200);

    expect(res.body.total).toBe(1);
  });

  /**
   * **A number beyond the `Int` range must not throw a 500.** The
   * `task_number` column is `Int`, so sending anything above 2,147,483,647 to
   * Prisma would break the query — although the user only typed a long number.
   */
  it('does not fall over even with a huge number', async () => {
    const { owner } = await seed();

    const res = await search(owner, '99999999999999').expect(200);

    expect(res.body.total).toBe(0);
  });
});

/**
 * **The two delivery queues: to deliver, then to publish.**
 *
 * They apply to **every** finished row, however old — there is no cut-off
 * date. The chip count and the list count must be the same.
 */
describe('queues — waiting for delivery and publishing', () => {
  /** The reference is the reliable key: task numbers come from a shared sequence */
  async function markDoneAt(n: number, at: string | Date): Promise<number> {
    const row = await h.prisma.task.update({
      where: { reference: REF_OF(n) },
      data: { status: 'done', completedAt: new Date(at) },
    });
    return row.id;
  }

  let owner: Session;

  beforeEach(async () => {
    owner = await seedPool(3);
  });

  it('every finished row is in the delivery queue, however old', async () => {
    await markDoneAt(1, '2025-01-10T10:00:00Z');
    await markDoneAt(2, workNoon());

    const page = await svc().list({ stage: 'to_deliver' });

    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.reference).sort()).toEqual([REF_OF(1), REF_OF(2)]);
  });

  /**
   * **The most important test** — if the number on the chip and the list you
   * get by clicking it differ, nobody will trust any number again.
   */
  it('the chip count and the list count are exactly the same', async () => {
    await markDoneAt(1, '2026-08-23T10:00:00Z');
    await markDoneAt(2, '2026-08-24T10:00:00Z');
    await markDoneAt(3, '2024-03-01T10:00:00Z');

    const [stats, page] = await Promise.all([
      svc().stats(),
      svc().list({ stage: 'to_deliver' }),
    ]);

    expect(stats.toDeliver).toBe(3);
    expect(page.total).toBe(stats.toDeliver);
  });

  it('once delivered, the row leaves the first queue and goes to the second', async () => {
    const id = await markDoneAt(1, '2025-01-10T10:00:00Z');

    await stage().markDelivered(id, workNoon());

    const [stats, toDeliver, toPublish] = await Promise.all([
      svc().stats(),
      svc().list({ stage: 'to_deliver' }),
      svc().list({ stage: 'to_publish' }),
    ]);

    expect(toDeliver.total).toBe(0);
    expect(toPublish.total).toBe(1);
    expect(stats.toDeliver).toBe(0);
    expect(stats.toPublish).toBe(1);
    expect(stats.delivered).toBe(1);
  });

  it('over HTTP: delivered, then published with a reference', async () => {
    const id = await markDoneAt(1, workNoon());

    await post(owner, `/api/v1/tasks/${id}/delivered`, {}).expect(201);
    await post(owner, `/api/v1/tasks/${id}/published`, {
      publishedRef: '  ORDER-55  ',
    }).expect(201);

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.deliveredAt).not.toBeNull();
    expect(row.publishedAt).not.toBeNull();
    expect(row.publishedRef).toBe('ORDER-55');

    const list = await owner.http.get('/api/v1/tasks?status=done').expect(200);
    expect(list.body.rows[0]).toMatchObject({
      reference: REF_OF(1),
      publishedRef: 'ORDER-55',
    });
    expect(list.body.rows[0].deliveredAt).not.toBeNull();
    expect(list.body.rows[0].publishedAt).not.toBeNull();

    const stats = await owner.http.get('/api/v1/tasks/stats').expect(200);
    expect(stats.body).toMatchObject({
      done: 1,
      pool: 2,
      delivered: 1,
      published: 1,
      toDeliver: 0,
      toPublish: 0,
    });
  });

  it('a blank published reference is stored as null', async () => {
    const id = await markDoneAt(1, workNoon());
    await post(owner, `/api/v1/tasks/${id}/delivered`, {}).expect(201);

    await post(owner, `/api/v1/tasks/${id}/published`, { publishedRef: '   ' }).expect(201);

    expect(
      (await h.prisma.task.findUniqueOrThrow({ where: { id } })).publishedRef,
    ).toBeNull();
  });

  it('cannot be delivered before done, nor published before delivered', async () => {
    const pool = await h.prisma.task.findUniqueOrThrow({ where: { reference: REF_OF(3) } });
    await post(owner, `/api/v1/tasks/${pool.id}/delivered`, {}).expect(400);

    const id = await markDoneAt(1, workNoon());
    await post(owner, `/api/v1/tasks/${id}/published`, {}).expect(400);

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.publishedAt).toBeNull();
  });
});

/**
 * **The check chain: checked, problem found, fixed.**
 *
 * Once an assignee says "finished", the work may not be over — someone
 * checks it, someone fixes any problem found, then it is delivered. The
 * machine does **not** inspect the work — it only keeps the count.
 */
describe('check — checked, problem found, fixed', () => {
  async function finished(n: number): Promise<number> {
    const row = await h.prisma.task.update({
      where: { reference: REF_OF(n) },
      data: { status: 'done', completedAt: new Date('2026-08-23T10:00:00Z') },
    });
    return row.id;
  }

  /**
   * Whoever presses the button — the owner is enough.
   *
   * This block calls the **service directly**, so the HTTP guard
   * (`assertCanCheck`) does not run here — who may do it is checked in the
   * separate block below. The only question here is whether the *rule* is right.
   */
  let actorId: number;

  beforeEach(async () => {
    await seedPool(3);
    const u = await h.prisma.user.findFirstOrThrow({ where: { role: 'owner' } });
    actorId = u.id;
  });

  it('a finished task enters the check queue', async () => {
    await finished(1);

    const [stats, page] = await Promise.all([
      svc().stats(),
      svc().list({ stage: 'to_check' }),
    ]);

    expect(stats.toCheck).toBe(1);
    expect(page.total).toBe(stats.toCheck);
    expect(page.rows[0].reference).toBe(REF_OF(1));
  });

  it('when it is fine it leaves the queue and does not go to the fix queue', async () => {
    const id = await finished(1);

    await stage().markChecked(id, true, actorId, workNoon());

    const stats = await svc().stats();
    expect(stats.toCheck).toBe(0);
    expect(stats.toFix).toBe(0);
    // It was fine, so it stays in the delivery queue
    expect(stats.toDeliver).toBe(1);
  });

  /**
   * **A task with a problem found but not yet fixed is out of the delivery
   * queue.** Something known to be broken must not be delivered.
   */
  it('a task with a problem found stays out of the delivery queue', async () => {
    const id = await finished(1);
    await finished(2);

    await stage().markChecked(id, false, actorId, workNoon());

    const [stats, toFix, toDeliver] = await Promise.all([
      svc().stats(),
      svc().list({ stage: 'to_fix' }),
      svc().list({ stage: 'to_deliver' }),
    ]);

    expect(stats.toFix).toBe(1);
    expect(toFix.rows[0].reference).toBe(REF_OF(1));

    // No. 2 has not even been checked yet — checking is optional, so it is still deliverable
    expect(stats.toDeliver).toBe(1);
    expect(toDeliver.rows[0].reference).toBe(REF_OF(2));
  });

  it('after being fixed it returns to the delivery queue', async () => {
    const id = await finished(1);
    await stage().markChecked(id, false, actorId, workNoon());
    expect((await svc().stats()).toDeliver).toBe(0);

    await stage().markFixed(id, actorId, workNoon());

    const stats = await svc().stats();
    expect(stats.toFix).toBe(0);
    expect(stats.toDeliver).toBe(1);
  });

  /**
   * **Ownership of a task never changes.** If the work moved to the fixer's
   * name when they fixed it, their count would swell.
   */
  it('even when fixed, the task stays with the original assignee', async () => {
    const one = await assignee('OX-A9', 'a9@test.local');
    const id = await finished(1);
    await h.prisma.task.update({ where: { id }, data: { assignedToId: one.id } });

    await stage().markChecked(id, false, actorId, workNoon());
    await stage().markFixed(id, actorId, workNoon());

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.assignedToId).toBe(one.id);
    expect(row.fixedById).toBe(actorId);
  });

  /** Pressing twice does not move the date — otherwise "when it was checked" would jump */
  it('pressing again does not change the date', async () => {
    const id = await finished(1);
    await stage().markChecked(id, true, actorId, new Date('2026-08-24T10:00:00Z'));
    await stage().markChecked(id, false, actorId, new Date('2026-08-25T10:00:00Z'));

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.checkedAt?.toISOString()).toBe(new Date('2026-08-24T10:00:00Z').toISOString());
    // The second press did not set "problem" — the first verdict stays
    expect(row.errorFoundAt).toBeNull();
  });

  it('an unfinished task cannot be checked', async () => {
    const row = await h.prisma.task.findUniqueOrThrow({ where: { reference: REF_OF(1) } });
    await expect(stage().markChecked(row.id, true, actorId, workNoon())).rejects.toThrow();
  });

  it('"fixed" cannot be said when there is no problem', async () => {
    const id = await finished(1);
    await stage().markChecked(id, true, actorId, workNoon());

    await expect(stage().markFixed(id, actorId, workNoon())).rejects.toThrow();
  });
});

/**
 * **Who may check tasks.**
 *
 * The question is not *"which person"* but *"which role"*: owner, manager and
 * every coordinator — never the assignee, who cannot approve their own work.
 */
describe('check rights — HTTP guard', () => {
  /** A row made for checking — finished, not yet looked at */
  async function ready(): Promise<number> {
    await seedPool(1);

    const row = await h.prisma.task.update({
      where: { reference: REF_OF(1) },
      data: { status: 'done', completedAt: new Date('2026-08-23T10:00:00Z') },
    });
    return row.id;
  }

  it('a coordinator can check and fix', async () => {
    const id = await ready();
    await coordinator('OX-C8', 'c8@test.local');
    const session = await loginReady(h, 'c8@test.local', STAFF_PASSWORD);

    await post(session, `/api/v1/tasks/${id}/checked`, { ok: false }).expect(201);
    await post(session, `/api/v1/tasks/${id}/fixed`, {}).expect(201);

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.errorFoundAt).not.toBeNull();
    expect(row.fixedAt).not.toBeNull();
  });

  /** Any coordinator — the right is the role's, not one named person's */
  it("a second coordinator can too — no waiting for anyone's tick", async () => {
    const id = await ready();
    await coordinator('OX-C9', 'c9@test.local');
    const session = await loginReady(h, 'c9@test.local', STAFF_PASSWORD);

    await post(session, `/api/v1/tasks/${id}/checked`, { ok: true }).expect(201);
  });

  /** A manager has no `employees` row at all — they get it through the role */
  it('a manager can', async () => {
    const id = await ready();
    const session = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await post(session, `/api/v1/tasks/${id}/checked`, { ok: true }).expect(201);

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.checkedAt).not.toBeNull();
  });

  /** `ok` is mandatory — sending nothing must not silently become "fine" */
  it('checked without ok is a 400', async () => {
    const id = await ready();
    const session = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await post(session, `/api/v1/tasks/${id}/checked`, {}).expect(400);
  });

  it('an assignee cannot', async () => {
    const id = await ready();
    await assignee('OX-A7', 'a7@test.local');
    const session = await loginReady(h, 'a7@test.local', STAFF_PASSWORD);

    await session.http.get('/api/v1/tasks').expect(403);
    await post(session, `/api/v1/tasks/${id}/checked`, { ok: true }).expect(403);

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.checkedAt).toBeNull();
  });

  /** Both flags go in the session too — the screen looks at them to hide the buttons */
  it('the session carries canAddTasks and canCheckTasks correctly', async () => {
    await coordinator('OX-CA', 'ca@test.local');
    await assignee('OX-A8', 'a8@test.local');

    const coord = await loginReady(h, 'ca@test.local', STAFF_PASSWORD);
    const worker = await loginReady(h, 'a8@test.local', STAFF_PASSWORD);

    const a = await coord.http.get('/api/v1/auth/me').expect(200);
    const b = await worker.http.get('/api/v1/auth/me').expect(200);

    expect(a.body.role).toBe('coordinator');
    expect(a.body.canAddTasks).toBe(true);
    expect(a.body.canCheckTasks).toBe(true);

    expect(b.body.canAddTasks).toBe(false);
    expect(b.body.canCheckTasks).toBe(false);
  });
});

/**
 * **Who added the task.**
 *
 * The subtlest claim here is about **two separate worlds of ids**:
 * `assignedToId → employees`, `addedById → users`. The numbers are small and
 * close together, so it is easy to put one in place of the other — and then
 * there is no error, only **the wrong person's rows** come back.
 */
describe('who added it — list, filter and count', () => {
  it('the row says who added it, with the role', async () => {
    await coordinator('OX-CB', 'cb@test.local');
    const session = await loginReady(h, 'cb@test.local', STAFF_PASSWORD);

    await post(session, '/api/v1/tasks/bulk', { text: REF_OF(1) }).expect(201);

    const page = await svc().list({});
    expect(page.rows[0].addedBy.fullName).toBe('OX-CB');
    expect(page.rows[0].addedBy.role).toBe('coordinator');
    expect(page.rows[0].addedAt).not.toBeNull();
  });

  /**
   * **This test guards the two-id-worlds problem.** The coordinator's
   * `users.id` and an assignee's `employees.id` are different numbers; if the
   * filter gets it wrong, it will be caught here.
   */
  it('can be filtered by who added it', async () => {
    await coordinator('OX-CC', 'cc@test.local');
    const them = await loginReady(h, 'cc@test.local', STAFF_PASSWORD);
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    await post(them, '/api/v1/tasks/bulk', {
      text: [REF_OF(1), REF_OF(2)].join(BR),
    }).expect(201);
    await post(owner, '/api/v1/tasks/bulk', { text: REF_OF(3) }).expect(201);

    const adders = await svc().adders();
    expect(adders).toHaveLength(2);

    const coord = adders.find((a) => a.role === 'coordinator');
    expect(coord?.count).toBe(2);
    expect(adders.find((a) => a.role === 'owner')?.count).toBe(1);

    // The one who added the most comes first
    expect(adders[0].count).toBe(2);

    const only = await svc().list({ addedById: coord!.id });
    expect(only.total).toBe(2);
    for (const row of only.rows) {
      expect(row.addedBy.role).toBe('coordinator');
    }
  });

  /** If nobody added anything the list is empty — the dropdown stays empty, it does not break */
  it('empty list when there is nothing', async () => {
    expect(await svc().adders()).toEqual([]);
  });

  /** An assignee cannot touch this route either — it sits right under `assertCanUse` */
  it('an assignee cannot see adders', async () => {
    await assignee('OX-A9B', 'a9b@test.local');
    const session = await loginReady(h, 'a9b@test.local', STAFF_PASSWORD);

    await session.http.get('/api/v1/tasks/adders').expect(403);
  });
});

/**
 * **"I pressed Complete by mistake."**
 *
 * The root cause would be **not being able to see it**: if the own list sent
 * only `assigned` rows, the moment Complete was pressed the item would vanish
 * from the screen, and there would be no Undo button to press.
 */
describe('undoing Complete', () => {
  /** One assignee, with one task in hand. Returns the owner's session too (see `seedPool`). */
  async function assigned(n: number, reuse?: Session) {
    const owner = reuse ?? (await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD));
    await post(owner, '/api/v1/tasks/bulk', { text: REF_OF(n) }).expect(201);

    const one = await assignee(`OX-U${n}`, `u${n}@test.local`);
    const row = await h.prisma.task.update({
      where: { reference: REF_OF(n) },
      data: {
        status: 'assigned',
        assignedToId: one.id,
        assignedAt: workNoon(),
      },
    });

    const session = await loginReady(h, `u${n}@test.local`, STAFF_PASSWORD);
    return { id: row.id, one, session, owner };
  }

  it('after finishing, the row stays in their own list', async () => {
    const { id, one, session } = await assigned(1);

    await post(session, `/api/v1/me/tasks/${id}/done`, {}).expect(201);

    const mine = await person().mine(one.id);
    expect(mine).toHaveLength(1);
    // But it is no longer "in hand" — it is finished
    expect(mine[0].completedAt).not.toBeNull();
  });

  it('pressing Undo puts it back in hand', async () => {
    const { id, one, session } = await assigned(1);
    await post(session, `/api/v1/me/tasks/${id}/done`, {}).expect(201);

    await post(session, `/api/v1/me/tasks/${id}/undone`, {}).expect(201);

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('assigned');
    /**
     * **All three must be cleared.** The queues run on `completedAt`, not on
     * `status` — restoring only the status would show the row as "in hand"
     * while it still sat in the delivery queue.
     */
    expect(row.completedAt).toBeNull();
    expect(row.completedVia).toBeNull();
    expect(row.completedById).toBeNull();

    // The work stays theirs — it does not go back to the pool
    expect(row.assignedToId).toBe(one.id);
  });

  it('it also leaves the queue', async () => {
    const { id, session } = await assigned(1);
    await post(session, `/api/v1/me/tasks/${id}/done`, {}).expect(201);
    expect((await svc().stats()).toDeliver).toBe(1);

    await post(session, `/api/v1/me/tasks/${id}/undone`, {}).expect(201);

    const stats = await svc().stats();
    expect(stats.toDeliver).toBe(0);
    expect(stats.toCheck).toBe(0);
  });

  /**
   * **The most important test.** Once the task has been checked, it is no
   * longer an "accidental press" — undoing would make the check queue and the
   * delivery count lie together.
   */
  it('once checked, it cannot be undone', async () => {
    const { id, session, owner } = await assigned(1);
    await post(session, `/api/v1/me/tasks/${id}/done`, {}).expect(201);

    await post(owner, `/api/v1/tasks/${id}/checked`, { ok: true }).expect(201);

    await post(session, `/api/v1/me/tasks/${id}/undone`, {}).expect(409);

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('done');
  });

  /** The same holds once it has been delivered */
  it('once delivered, it cannot be undone either', async () => {
    const { id, session, owner } = await assigned(1);
    await post(session, `/api/v1/me/tasks/${id}/done`, {}).expect(201);
    await post(owner, `/api/v1/tasks/${id}/delivered`, {}).expect(201);

    await post(session, `/api/v1/me/tasks/${id}/undone`, {}).expect(409);
    await post(owner, `/api/v1/tasks/${id}/undone`, {}).expect(409);
  });

  /** Undoing yesterday's would change yesterday's count too */
  it("an assignee cannot undo yesterday's work", async () => {
    const { id, session } = await assigned(1);
    await post(session, `/api/v1/me/tasks/${id}/done`, {}).expect(201);
    await h.prisma.task.update({
      where: { id },
      data: { completedAt: workNoon(-3) },
    });

    await post(session, `/api/v1/me/tasks/${id}/undone`, {}).expect(409);
  });

  /** But the owner can — correcting old mistakes is the job of that route */
  it('the owner can undo even an old Complete', async () => {
    const { id, one, session, owner } = await assigned(1);
    await post(session, `/api/v1/me/tasks/${id}/done`, {}).expect(201);
    await h.prisma.task.update({
      where: { id },
      data: { completedAt: workNoon(-3) },
    });

    await post(owner, `/api/v1/tasks/${id}/undone`, {}).expect(201);

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('assigned');
    expect(row.completedAt).toBeNull();
    expect(row.assignedToId).toBe(one.id);
  });

  /** Someone else's row cannot be touched — not even by guessing the id */
  it("someone else's task cannot be undone", async () => {
    const first = await assigned(1);
    // Reuses the owner's session — see `seedPool`
    const mine = await assigned(2, first.owner);
    await post(mine.session, `/api/v1/me/tasks/${mine.id}/done`, {}).expect(201);

    await post(mine.session, `/api/v1/me/tasks/${first.id}/undone`, {}).expect(403);
  });

  /**
   * **Undo is written to the audit log.**
   *
   * This is the only action that **erases its own trace** — `completedAt`,
   * `completedVia` and `completedById` all become `null`. Without the log,
   * nobody could see someone doing Complete → Undo → Complete every day.
   *
   * The meta must hold **the erased values**, otherwise the log would only
   * say "something was undone" — not what.
   */
  it('Undo is written to the audit log, with the erased values', async () => {
    const { id, session, one } = await assigned(1);
    await post(session, `/api/v1/me/tasks/${id}/done`, {}).expect(201);

    const doneRow = await h.prisma.task.findUniqueOrThrow({ where: { id } });

    await post(session, `/api/v1/me/tasks/${id}/undone`, {}).expect(201);

    const entry = await h.prisma.auditLog.findFirstOrThrow({
      where: { action: 'task_undone' },
      orderBy: { id: 'desc' },
    });

    expect(entry.targetType).toBe('task');
    expect(entry.targetId).toBe(String(id));

    const meta = entry.meta as Record<string, unknown>;
    expect(meta.reference).toBe(REF_OF(1));
    expect(meta.taskNumber).toBe(doneRow.taskNumber);
    expect(meta.assignedToId).toBe(one.id);
    // What was erased — the row no longer has these, the log is the only place
    expect(meta.completedVia).toBe('manual');
    expect(meta.completedById).toBe(doneRow.completedById);
    expect(meta.completedAt).toBe(doneRow.completedAt?.toISOString());
  });

  /** A failed Undo is not logged — otherwise the log would fill up with attempts */
  it('a blocked Undo is not logged', async () => {
    const { id, session, owner } = await assigned(1);
    await post(session, `/api/v1/me/tasks/${id}/done`, {}).expect(201);
    await post(owner, `/api/v1/tasks/${id}/checked`, { ok: true }).expect(201);

    await post(session, `/api/v1/me/tasks/${id}/undone`, {}).expect(409);

    expect(await h.prisma.auditLog.count({ where: { action: 'task_undone' } })).toBe(0);
  });

  /** Pressing twice does not break — "fine" the second time too */
  it('pressing Undo twice does not break', async () => {
    const { id, session } = await assigned(1);
    await post(session, `/api/v1/me/tasks/${id}/done`, {}).expect(201);

    await post(session, `/api/v1/me/tasks/${id}/undone`, {}).expect(201);
    await post(session, `/api/v1/me/tasks/${id}/undone`, {}).expect(201);
  });

  /** An owner without a staff row has no own list */
  it('an account without a staff row gets 403 on /me/tasks', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await owner.http.get('/api/v1/me/tasks').expect(403);
  });
});

/**
 * **Receiving tasks and having a target are separate questions.**
 *
 *   1. Does the person **get** work? → `receivesTasks`, 30 like everyone else
 *   2. Are they held to a daily **target**? → only if their target is above 0
 *
 * Someone who helps out 1-2 days a week receives tasks with a target of 0;
 * showing them "behind" on the other days would be false.
 */
describe('allocation — someone with a target of 0 gets tasks too', () => {
  it('a receiver with target 0 gets 30, same as the others', async () => {
    await assignee('OX-A1', 'a1@test.local');
    await staff('OX-M1', 'm1@test.local', { receivesTasks: true, dailyTaskTarget: 0 });
    await seedPool(100);

    await handout().distribute();

    const rows = await h.prisma.task.findMany({
      where: { status: 'assigned' },
      select: { assignedToId: true },
    });
    expect(rows).toHaveLength(60);

    const per = new Map<number | null, number>();
    for (const r of rows) per.set(r.assignedToId, (per.get(r.assignedToId) ?? 0) + 1);
    expect([...per.values()]).toEqual([30, 30]);
  });

  /** Someone who does not receive tasks gets none — even with a target set */
  it('someone who does not receive tasks is not in the hand-out', async () => {
    await staff('OX-N1', 'n1@test.local', { receivesTasks: false, dailyTaskTarget: 25 });
    await coordinator('OX-C1', 'c1@test.local');
    await seedPool(100);

    expect((await handout().distribute()).assigned).toBe(0);
  });

  /**
   * **No pile builds up even if they do not work every day.** The condition
   * is whether it was **started**, not whether it was "finished".
   */
  it('an untouched task returns to the pool at night', async () => {
    const helper = await staff('OX-M2', 'm2@test.local', {
      receivesTasks: true,
      dailyTaskTarget: 0,
    });
    await seedPool(100);
    await handout().distribute();
    expect(await h.prisma.task.count({ where: { assignedToId: helper.id } })).toBe(30);

    await handout().returnUnworked(workDateOf(workNoon()));

    expect(await h.prisma.task.count({ where: { assignedToId: helper.id } })).toBe(0);
    expect(await h.prisma.task.count({ where: { status: 'pool' } })).toBe(100);
  });

  /** But one they started stays in their hand */
  it('a started task is not returned', async () => {
    const helper = await staff('OX-M3', 'm3@test.local', {
      receivesTasks: true,
      dailyTaskTarget: 0,
    });
    await seedPool(100);
    await handout().distribute();

    const one = await h.prisma.task.findFirstOrThrow({
      where: { assignedToId: helper.id },
    });
    await h.prisma.task.update({
      where: { id: one.id },
      data: { startedAt: workNoon() },
    });

    await handout().returnUnworked(workDateOf(workNoon()));

    const still = await h.prisma.task.findUniqueOrThrow({ where: { id: one.id } });
    expect(still.assignedToId).toBe(helper.id);
  });
});
// ════════════════════════════════════════════════════════════════════════════

/**
 * **Deleting tasks that are no longer wanted.**
 *
 * **The one real claim of this block: deleting does not mean forgetting.**
 * A real `DELETE` would remove the `reference` UNIQUE guard along with the
 * row — if someone pasted that reference again tomorrow, it would enter as
 * new work and be handed out again. The second test below guards that cycle.
 */
describe('deleting tasks', () => {
  const ids = async (): Promise<number[]> =>
    (
      await h.prisma.task.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
    ).map((r) => r.id);

  it('the row stays, but is no longer handed out', async () => {
    await assignee('OX-A1', 'a1@test.local');
    const owner = await seedPool(5);

    const res = await post(owner, '/api/v1/tasks/delete', {
      ids: (await ids()).slice(0, 2),
      reason: 'not_needed',
    }).expect(201);

    expect(res.body).toEqual({ deleted: 2, keptDone: 0 });

    // All five are in the table — not deleted, marked
    expect(await h.prisma.task.count()).toBe(5);
    expect(await h.prisma.task.count({ where: { status: 'deleted' } })).toBe(2);

    await handout().distribute();

    expect(await h.prisma.task.count({ where: { status: 'assigned' } })).toBe(3);
  });

  /**
   * **This one test is the reason for soft delete.** Without the row,
   * `ON CONFLICT (reference) DO NOTHING` would block nothing.
   */
  it('a deleted reference pasted again does not return to the pool', async () => {
    const owner = await seedPool(1);

    await post(owner, '/api/v1/tasks/delete', {
      ids: await ids(),
      reason: 'not_needed',
    }).expect(201);

    const again = await post(owner, '/api/v1/tasks/bulk', { text: REF_OF(1) }).expect(201);

    expect(again.body.added).toBe(0);
    expect(again.body.alreadyKnown).toBe(1);
    expect(again.body.rejected[0].reason).toBe('already_exists');
    expect(await h.prisma.task.count({ where: { status: 'pool' } })).toBe(0);
  });

  /**
   * Deleting finished work would lower the assignee's count for the day, and
   * the item would silently disappear from the delivery queue too.
   */
  it('finished rows are not touched, and that is counted and reported', async () => {
    const owner = await seedPool(2);
    const [first, second] = await ids();

    await h.prisma.task.update({
      where: { id: first },
      data: { status: 'done', completedAt: workNoon(), completedVia: 'manual' },
    });

    const res = await post(owner, '/api/v1/tasks/delete', {
      ids: [first, second],
      reason: 'cannot_do',
    }).expect(201);

    expect(res.body).toEqual({ deleted: 1, keptDone: 1 });
    expect(
      (await h.prisma.task.findUniqueOrThrow({ where: { id: first } })).status,
    ).toBe('done');
  });

  /**
   * **The most useful case** — the assignee opens the task and only then
   * finds it is no longer needed, so the row is **in their hand** at that point.
   */
  it('deleting a row in hand removes it from the list, and a replacement comes at the next hand-out', async () => {
    const one = await assignee('OX-A1', 'a1@test.local');
    const owner = await seedPool(31);
    await handout().distribute();

    const mine = await person().mine(one.id);
    expect(mine).toHaveLength(30);

    await post(owner, '/api/v1/tasks/delete', {
      ids: [mine[0].id],
      reason: 'not_needed',
    }).expect(201);

    expect(await person().mine(one.id)).toHaveLength(29);

    // 29 in hand, 1 left in the pool — so the replacement comes anyway
    await handout().distribute();
    expect(await person().mine(one.id)).toHaveLength(30);
  });

  /** The same id arriving twice would inflate the count */
  it('giving the same id twice counts it once', async () => {
    const owner = await seedPool(1);
    const [only] = await ids();

    const res = await post(owner, '/api/v1/tasks/delete', {
      ids: [only, only],
      reason: 'duplicate',
    }).expect(201);

    expect(res.body.deleted).toBe(1);
  });

  /** A second delete would add a second audit row, though nothing happened */
  it('deleting an already deleted row again does nothing', async () => {
    const owner = await seedPool(1);
    const only = await ids();

    await post(owner, '/api/v1/tasks/delete', { ids: only, reason: 'not_needed' }).expect(201);
    const twice = await post(owner, '/api/v1/tasks/delete', {
      ids: only,
      reason: 'not_needed',
    }).expect(201);

    expect(twice.body).toEqual({ deleted: 0, keptDone: 0 });
    expect(await h.prisma.auditLog.count({ where: { action: 'task_deleted' } })).toBe(1);

    const entry = await h.prisma.auditLog.findFirstOrThrow({
      where: { action: 'task_deleted' },
    });
    expect(entry.targetType).toBe('tasks');
    expect(entry.targetId).toBe(String(only[0]));
    expect(entry.meta).toMatchObject({ deleted: 1, reason: 'not_needed' });
  });

  /** The single route does the same — two different behaviours would one day go wrong */
  it('the single DELETE does not remove the row either, it marks it', async () => {
    const owner = await seedPool(1);
    const [only] = await ids();

    await owner.http
      .delete(`/api/v1/tasks/${only}?reason=cannot_do`)
      .set('X-CSRF-Token', owner.csrf)
      .expect(200);

    const row = await h.prisma.task.findUniqueOrThrow({ where: { id: only } });
    expect(row.status).toBe('deleted');
    expect(row.dropReason).toBe('cannot_do');
  });
});
// ════════════════════════════════════════════════════════════════════════════

/**
 * **"Why was it dropped" — one list of reasons for both routes**: the
 * assignee's Skip and the owner's Delete ask the same question.
 *
 * The most important claim: **there is no route without a reason**.
 */
describe('reason for dropping', () => {
  it('on Delete the reason is stored on the row', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.task.findFirstOrThrow();

    await post(owner, '/api/v1/tasks/delete', {
      ids: [row.id],
      reason: 'cannot_do',
    }).expect(201);

    const after = await h.prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('deleted');
    expect(after.dropReason).toBe('cannot_do');
  });

  /** With a route that deletes without a reason, the field would be empty again */
  it('Delete without a reason is rejected', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.task.findFirstOrThrow();

    await post(owner, '/api/v1/tasks/delete', { ids: [row.id] }).expect(400);
    await owner.http
      .delete(`/api/v1/tasks/${row.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .expect(400);

    expect(
      (await h.prisma.task.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('pool');
  });

  /**
   * A reason outside the list cannot be accepted — otherwise the counts would
   * mean nothing. The values used before the Tasks module are outside it too.
   */
  it('an unknown or old-style reason is rejected', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.task.findFirstOrThrow();

    for (const reason of ['boring', 'not_found', 'copyright', 'events']) {
      await post(owner, '/api/v1/tasks/delete', { ids: [row.id], reason }).expect(400);
    }
    expect(
      (await h.prisma.task.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('pool');
  });

  /** All four reasons are accepted */
  it('every listed reason is accepted', async () => {
    const owner = await seedPool(4);
    const rows = await h.prisma.task.findMany({ orderBy: { id: 'asc' } });
    const reasons = ['not_needed', 'cannot_do', 'duplicate', 'other'];

    for (let i = 0; i < reasons.length; i++) {
      await post(owner, '/api/v1/tasks/delete', {
        ids: [rows[i].id],
        reason: reasons[i],
      }).expect(201);
    }

    const after = await h.prisma.task.findMany({
      select: { dropReason: true },
      orderBy: { id: 'asc' },
    });
    expect(after.map((r) => r.dropReason)).toEqual(reasons);
  });

  /** The assignee's Skip — the same reasons, the same field */
  it('on Skip the reason goes in the same field', async () => {
    const one = await assignee('OX-A1', 'a1@test.local');
    await seedPool(1);
    await handout().distribute();

    const session = await loginReady(h, 'a1@test.local', STAFF_PASSWORD);
    const mine = await person().mine(one.id);

    await post(session, `/api/v1/me/tasks/${mine[0].id}/skip`, {
      reason: 'duplicate',
    }).expect(201);

    const after = await h.prisma.task.findUniqueOrThrow({ where: { id: mine[0].id } });
    expect(after.status).toBe('skipped');
    expect(after.dropReason).toBe('duplicate');
  });

  it('Skip without a reason is rejected', async () => {
    const one = await assignee('OX-A1', 'a1@test.local');
    await seedPool(1);
    await handout().distribute();

    const session = await loginReady(h, 'a1@test.local', STAFF_PASSWORD);
    const mine = await person().mine(one.id);

    await post(session, `/api/v1/me/tasks/${mine[0].id}/skip`, {}).expect(400);

    expect(
      (await h.prisma.task.findUniqueOrThrow({ where: { id: mine[0].id } })).status,
    ).toBe('assigned');
  });

  /**
   * **Back to the pool — the reason is erased too.** Otherwise the row would
   * return still marked "No longer needed", and whoever got it at the next
   * hand-out would see a warning that was already settled.
   */
  it('when returned to the pool, the reason is erased too', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.task.findFirstOrThrow();

    await post(owner, '/api/v1/tasks/delete', {
      ids: [row.id],
      reason: 'not_needed',
    }).expect(201);

    await owner.http
      .patch(`/api/v1/tasks/${row.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ status: 'pool' })
      .expect(200);

    const back = await h.prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    expect(back.status).toBe('pool');
    expect(back.dropReason).toBeNull();
  });

  /** The reason goes into the list too — otherwise there would be no way to show it on screen */
  it('the list row returns the reason', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.task.findFirstOrThrow();

    await post(owner, '/api/v1/tasks/delete', {
      ids: [row.id],
      reason: 'not_needed',
    }).expect(201);

    const list = await owner.http.get('/api/v1/tasks?status=deleted').expect(200);

    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].dropReason).toBe('not_needed');
  });
});
// ════════════════════════════════════════════════════════════════════════════

/**
 * **Review queue for dropped tasks**: the owner and the manager look over
 * the tasks that were deleted or skipped.
 *
 * The most important claim is the second: **rows without a reason do not
 * enter the queue**. Otherwise the queue could start with a mountain of rows
 * nobody can say anything about.
 */
describe('review queue — dropped tasks', () => {
  const queue = (session: Session) =>
    session.http.get('/api/v1/tasks?stage=to_review').expect(200);

  it('a row deleted with a reason enters the queue', async () => {
    const owner = await seedPool(2);
    const [first] = (
      await h.prisma.task.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
    ).map((r) => r.id);

    await post(owner, '/api/v1/tasks/delete', {
      ids: [first],
      reason: 'cannot_do',
    }).expect(201);

    const list = await queue(owner);
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].dropReason).toBe('cannot_do');
    expect(list.body.rows[0].reviewedAt).toBeNull();
  });

  /** A skipped row with no reason has nothing for the manager to look over */
  it('rows without a reason do not enter the queue', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.task.findFirstOrThrow();

    await h.prisma.task.update({
      where: { id: row.id },
      data: { status: 'skipped', dropReason: null },
    });

    expect((await queue(owner)).body.rows).toHaveLength(0);
  });

  it('pressing "reviewed" removes it from the queue, but the status does not change', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.task.findFirstOrThrow();

    await post(owner, '/api/v1/tasks/delete', {
      ids: [row.id],
      reason: 'not_needed',
    }).expect(201);

    await post(owner, `/api/v1/tasks/${row.id}/reviewed`, {}).expect(201);

    expect((await queue(owner)).body.rows).toHaveLength(0);

    const after = await h.prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    // An acknowledgement, not a decision — the row stays `deleted`
    expect(after.status).toBe('deleted');
    expect(after.reviewedAt).not.toBeNull();
    expect(after.reviewedById).not.toBeNull();
  });

  /** If the chip count and the list count differ, both become unbelievable */
  it('the chip count and the list count are exactly the same', async () => {
    const owner = await seedPool(3);
    const ids = (
      await h.prisma.task.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
    ).map((r) => r.id);

    await post(owner, '/api/v1/tasks/delete', {
      ids: ids.slice(0, 2),
      reason: 'other',
    }).expect(201);

    const stats = await owner.http.get('/api/v1/tasks/stats').expect(200);
    expect(stats.body.toReview).toBe(2);
    expect(stats.body.deleted).toBe(2);
    expect(stats.body.perAssignee).toBe(30);
    expect((await queue(owner)).body.rows).toHaveLength(2);
  });

  /**
   * When it returns to the pool the mark is erased too — otherwise if someone
   * skipped it again later, the row **would not enter the queue** because of
   * an old mark.
   */
  it('when returned to the pool, the "reviewed" mark is erased too', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.task.findFirstOrThrow();

    await post(owner, '/api/v1/tasks/delete', {
      ids: [row.id],
      reason: 'not_needed',
    }).expect(201);
    await post(owner, `/api/v1/tasks/${row.id}/reviewed`, {}).expect(201);

    await owner.http
      .patch(`/api/v1/tasks/${row.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ status: 'pool' })
      .expect(200);

    const back = await h.prisma.task.findUniqueOrThrow({ where: { id: row.id } });
    expect(back.reviewedAt).toBeNull();
    expect(back.reviewedById).toBeNull();
  });

  /** Not the coordinator — reviewing drops is for the owner and the manager */
  it('a coordinator cannot press "reviewed"', async () => {
    const owner = await seedPool(1);
    const row = await h.prisma.task.findFirstOrThrow();
    await post(owner, '/api/v1/tasks/delete', {
      ids: [row.id],
      reason: 'not_needed',
    }).expect(201);

    await coordinator('OX-C1', 'c1@test.local');
    const coord = await loginReady(h, 'c1@test.local', STAFF_PASSWORD);

    await post(coord, `/api/v1/tasks/${row.id}/reviewed`, {}).expect(403);
  });
});
// ════════════════════════════════════════════════════════════════════════════

/**
 * **On-screen time and start detection.**
 *
 * Start detection is optional: it is on only when Settings → Tasks lists the
 * apps whose window titles are read, and the Apps & websites module is on.
 * Off, the list must say so (`startDetection: false`) and every `onScreenSec`
 * must be `null` — never `0`, which would read as "never opened".
 */
describe('on-screen time — start detection', () => {
  const today = () => workDateOf(workNoon());

  async function withDevice(empCode: string) {
    const employee = await assignee(empCode, `${empCode.toLowerCase()}@test.local`);
    const device = await h.prisma.device.create({
      data: {
        hostname: `PC-${empCode}`,
        windowsUsername: empCode.toLowerCase(),
        employeeId: employee.id,
        machineGuid: randomUUID(),
        tokenHash: randomUUID(),
        status: 'active',
      },
    });
    return { employeeId: employee.id, deviceId: device.id };
  }

  async function saw(
    who: { employeeId: number; deviceId: number },
    title: string,
    seconds: number,
    processName: string,
  ): Promise<void> {
    const startedAt = new Date(workNoon().getTime() - 2 * 3600_000);
    await h.prisma.appUsage.create({
      data: {
        employeeId: who.employeeId,
        deviceId: who.deviceId,
        clientUuid: randomUUID(),
        workDate: today(),
        startedAt,
        endedAt: new Date(startedAt.getTime() + seconds * 1000),
        durationSec: seconds,
        processName,
        windowTitle: title,
      },
    });
  }

  const setApps = async (apps: string[]) => {
    const value = { startDetection: { apps } };
    await h.prisma.setting.upsert({
      where: { key: 'tasks' },
      update: { value },
      create: { key: 'tasks', value },
    });
  };

  /**
   * Three tasks for one person: one done and seen on screen for 10 minutes,
   * one done and never seen, one still in hand.
   */
  async function scene() {
    const who = await withDevice('OX-S1');
    const owner = await seedPool(3);
    await handout().distribute();

    const [seen, unseen, open] = await h.prisma.task.findMany({
      where: { assignedToId: who.employeeId },
      orderBy: { reference: 'asc' },
    });
    for (const t of [seen, unseen]) {
      await h.prisma.task.update({
        where: { id: t.id },
        data: { status: 'done', completedAt: workNoon(), completedVia: 'manual' },
      });
    }
    await saw(who, `${seen.taskNumber} - Quarterly report.xlsx`, 600, 'EXCEL.EXE');
    // The same number in an app that is not listed counts for nothing
    await saw(who, `${unseen.taskNumber} - notes.txt`, 300, 'notepad.exe');

    return { owner, seen, unseen, open };
  }

  const byRef = (rows: { reference: string; onScreenSec: number | null }[]) =>
    Object.fromEntries(rows.map((r) => [r.reference, r.onScreenSec]));

  it('with no apps configured: startDetection false, every onScreenSec null, no_file empty', async () => {
    const { owner } = await scene();

    const list = await owner.http.get('/api/v1/tasks').expect(200);

    expect(list.body.startDetection).toBe(false);
    expect(list.body.traceSince).toBeNull();
    expect(list.body.rows).toHaveLength(3);
    for (const row of list.body.rows) expect(row.onScreenSec).toBeNull();

    const noFile = await owner.http.get('/api/v1/tasks?stage=no_file').expect(200);
    expect(noFile.body.total).toBe(0);
  });

  it('with an app configured (any case): seconds for the seen one, 0 for the unseen one, null for the open one', async () => {
    const { owner, seen, unseen, open } = await scene();
    await setApps(['excel.exe']);

    const list = await owner.http.get('/api/v1/tasks').expect(200);

    expect(list.body.startDetection).toBe(true);
    expect(list.body.traceSince).toBe(today().toISOString().slice(0, 10));
    expect(byRef(list.body.rows)).toEqual({
      [seen.reference]: 600,
      [unseen.reference]: 0,
      [open.reference]: null,
    });

    const noFile = await owner.http.get('/api/v1/tasks?stage=no_file').expect(200);
    expect(noFile.body.total).toBe(1);
    expect(noFile.body.rows[0].reference).toBe(unseen.reference);
  });

  it('with the Apps & websites module off, detection is inactive even with apps listed', async () => {
    const { owner } = await scene();
    await setApps(['excel.exe']);
    await h.prisma.setting.upsert({
      where: { key: 'features' },
      update: { value: { appTracking: false } },
      create: { key: 'features', value: { appTracking: false } },
    });
    h.app.get(FeaturesService).forget();

    const list = await owner.http.get('/api/v1/tasks').expect(200);

    expect(list.body.startDetection).toBe(false);
    for (const row of list.body.rows) expect(row.onScreenSec).toBeNull();

    const settings = await owner.http.get('/api/v1/settings/tasks').expect(200);
    expect(settings.body).toEqual({
      startDetection: { apps: ['excel.exe'] },
      active: false,
    });
  });

  it('Settings → Tasks: off by default, the owner can list apps, a coordinator cannot', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const before = await owner.http.get('/api/v1/settings/tasks').expect(200);
    expect(before.body).toEqual({ startDetection: { apps: [] }, active: false });

    const saved = await owner.http
      .patch('/api/v1/settings/tasks')
      .set('X-CSRF-Token', owner.csrf)
      .send({ startDetection: { apps: [' EXCEL.EXE ', 'excel.exe', 'WINWORD.EXE'] } })
      .expect(200);
    // Trimmed, repeats removed case-insensitively (the first form wins)
    expect(saved.body).toEqual({
      startDetection: { apps: ['EXCEL.EXE', 'WINWORD.EXE'] },
      active: true,
    });

    await coordinator('OX-C1', 'c1@test.local');
    const coord = await loginReady(h, 'c1@test.local', STAFF_PASSWORD);
    await coord.http.get('/api/v1/settings/tasks').expect(403);
  });
});
