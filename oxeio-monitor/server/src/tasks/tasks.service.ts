import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaskStatus, UserRole } from '@prisma/client';

import {
  localMidnightOf,
  nextLocalMidnight,
  startOfWorkDate,
  workDateOf,
} from '../agent/util/work-time';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { dailyCompletionCap, hasTaskTarget, taskTargetOf } from '../summary/task-start.rules';
import { OnScreenService } from './on-screen.service';
import { TasksSettingsService } from './tasks-settings.service';
import {
  allocationSizes,
  BULK_MAX_LINES,
  canUseTasks,
  type DropReason,
  onScreenSecOf,
  parseBulk,
  pastedLineCount,
  POOL_PER_ASSIGNEE,
  topUpSize,
  type RejectedLine,
} from './tasks.rules';

/**
 * 'YYYY-MM-DD' becomes the local midnight of that day.
 *
 * Careful: this sits at module level on purpose. The `list()` filter and the
 * `stats()` count must use exactly the same date. If a chip says 132 and
 * clicking it shows 90, nobody will trust any number again.
 */
const workStart = (day: string): Date =>
  startOfWorkDate(new Date(`${day}T00:00:00Z`));
const nextDay = (day: string): Date =>
  startOfWorkDate(new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000));

/**
 * Which work day an instant falls on, as `'YYYY-MM-DD'`.
 *
 * Careful: `toISOString().slice(0,10)` would give the UTC day, which is a
 * different day for part of every day in most zones. Someone who pressed
 * Complete late in the evening and spotted a mistake would then find Undo
 * blocked as "yesterday's work".
 */
const workDateStr = (at: Date): string =>
  workDateOf(at).toISOString().slice(0, 10);

/**
 * The most rejected lines sent back. The count (`rejectedTotal`) stays true;
 * only the list is trimmed.
 */
export const REJECTED_SHOWN = 200;

/**
 * `POST /tasks/bulk` →
 * `{ added, alreadyKnown, rejected: { line, text, reason }[], rejectedTotal, poolSize }`
 */
export interface BulkResult {
  /** How many were newly added */
  added: number;
  /** Already in the table: these are also in `rejected` with reason `already_exists` */
  alreadyKnown: number;
  /**
   * In line order, at most `REJECTED_SHOWN`; reasons: `too_long`, `bad_link`,
   * `duplicate_in_paste`, `already_exists`
   */
  rejected: RejectedLine[];
  /** How many were really rejected; the full count even when the list is trimmed */
  rejectedTotal: number;
  /** How many are now waiting in the pool */
  poolSize: number;
}

/** 50 per page */
export const TASK_PAGE_SIZE = 50;

/**
 * The most rows one call can delete. The screen shows 50 per page, so nobody
 * will get near this; the ceiling stops accidents and oversized queries.
 */
export const DELETE_MAX = 500;

/** `POST /tasks/delete`, `DELETE /tasks/:id` → `{ deleted, keptDone }` */
export interface DeleteResult {
  /** How many were really marked `deleted` */
  deleted: number;
  /**
   * Careful: rows that were not touched because they are already done. The
   * number is returned so the screen can tell the truth; otherwise 50 would be
   * selected, 48 deleted, and nobody would know what happened to the other two.
   */
  keptDone: number;
}

/**
 * What the search matches: the reference, the task number, or both.
 *
 * Careful: digits-only input uses `OR`. Some references are entirely numeric,
 * and searching only by task number would silently lose such a row.
 */
type TaskSearchMatch =
  | { reference: { contains: string; mode: 'insensitive' } }
  | {
      OR: [
        { taskNumber: number },
        { reference: { contains: string; mode: 'insensitive' } },
      ];
    };

/** One row of `GET /tasks` */
export interface TaskRow {
  id: number;
  reference: string;
  /** http(s) URL or `null` */
  link: string | null;
  status: TaskStatus;
  taskNumber: number | null;
  /** `null` on a row of staff who have left; the name is in `sourceNote` */
  assignedTo: { empCode: string; fullName: string } | null;
  assignedAt: string | null;
  /** The task number was first seen on screen: "work in progress" */
  startedAt: string | null;
  completedAt: string | null;
  completedVia: string | null;

  /**
   * Total seconds a window whose title starts with the task number was in
   * front, in the start-detection apps.
   *
   * Careful: three states. `> 0` is measured; `0` means "marked done yet
   * never on screen"; `null` means nothing to say (and always `null` while
   * start detection is off). The rule is in [`onScreenSecOf`](./tasks.rules.ts).
   *
   * This is not "was the work done". The number is context, not a verdict.
   */
  onScreenSec: number | null;
  /** Free text from an import, e.g. a former owner's name */
  sourceNote: string | null;

  /**
   * Why the row went out of work: `not_needed`, `cannot_do`, `duplicate`,
   * `other`. Present on both `skipped` and `deleted`; `null` otherwise.
   */
  dropReason: string | null;

  /** The owner/manager has reviewed this dropped row. `null` means still in the queue. */
  reviewedAt: string | null;
  reviewedBy: { fullName: string; role: string } | null;

  /** Who pressed Complete: the owner may do it on someone's behalf */
  completedBy: { fullName: string; role: string } | null;

  /**
   * Who added the task (a user, not a staff row).
   *
   * Careful: never `null`: the column is `NOT NULL`, so every row has a source.
   */
  addedBy: { fullName: string; role: string };
  /** When it arrived; rows of the same paste land at one instant */
  addedAt: string;
  /** Checked; `null` = not checked yet */
  checkedAt: string | null;
  /** A problem was found; `null` with `checkedAt` set = it was fine */
  errorFoundAt: string | null;
  /** The problem was fixed */
  fixedAt: string | null;
  deliveredAt: string | null;
  publishedAt: string | null;
  publishedRef: string | null;
}

/** `GET /tasks` */
export interface TaskList {
  rows: TaskRow[];
  total: number;
  page: number;
  pages: number;
  /** Since which day titles have been stored; explains why `onScreenSec === null` */
  traceSince: string | null;
  /** Start detection is on (apps listed and Apps & websites on): show the "On screen" column */
  startDetection: boolean;
}

/** One row of `GET /me/tasks` */
export interface MyTask {
  id: number;
  reference: string;
  link: string | null;
  taskNumber: number | null;
  assignedAt: string | null;
  /** The task number was seen on screen: "work in progress" */
  startedAt: string | null;
  /**
   * Finished today.
   *
   * Careful: `null` = still in hand. This field decides which section of the
   * screen the row goes in and whether the Undo button appears.
   */
  completedAt: string | null;
}

/** `GET /tasks/stats` */
export type TaskStats = Record<TaskStatus, number> & {
  /** How many each person holds at a time (30) */
  perAssignee: number;
  delivered: number;
  published: number;
  /** Done, not checked yet */
  toCheck: number;
  /** A problem was found and not yet fixed */
  toFix: number;
  /** Done, not delivered yet (rows with an unfixed problem excluded) */
  toDeliver: number;
  /** Delivered, not published yet */
  toPublish: number;
  /** Dropped with a reason, nobody has looked yet */
  toReview: number;
};

export type TaskStage =
  | 'to_check'
  | 'to_fix'
  | 'to_deliver'
  | 'to_publish'
  | 'to_review'
  | 'no_file';

/**
 * Tasks: adding, hand-out and completion.
 *
 * Coordinators, managers or the owner paste tasks into the pool; the morning
 * hand-out is random; each assignee works through their own list.
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly onScreen: OnScreenService,
    private readonly settings: TasksSettingsService,
  ) {}

  /**
   * Who can view and add tasks: owner, manager, coordinator.
   *
   * Reading and writing share one guard, on purpose: the full list shows where
   * the whole team's work stands, which is not for an assignee to see. They
   * see their own list in `/me/tasks`.
   *
   * The role is re-read from the database every 5 minutes (`JwtAuthGuard`), so
   * changing someone's role does not require logging them out.
   */
  assertCanUse(actor: SessionUser): void {
    if (canUseTasks(actor.role)) return;

    throw new ForbiddenException(
      'Only coordinators, managers and the owner can manage tasks.',
    );
  }

  /**
   * Who can check finished tasks: owner, manager, coordinator.
   *
   * Careful: today the formula is identical to `assertCanUse`, yet the two
   * functions stay separate, on purpose: with a named condition, changing one
   * later does not mean hunting for the other. Matching is not the same as
   * being equal.
   */
  assertCanCheck(actor: SessionUser): void {
    if (canUseTasks(actor.role)) return;

    throw new ForbiddenException(
      'Only coordinators, managers and the owner can check tasks.',
    );
  }

  /**
   * Up to `BULK_MAX_LINES` tasks at once, one per line.
   *
   * Careful: duplicates are filtered at two levels: inside the paste
   * (`parseBulk`) and against the database (`already_exists`). The insert
   * still says `ON CONFLICT DO NOTHING`, so a reference added by someone else
   * a moment earlier cannot cancel the whole batch.
   *
   * Careful: how many were really inserted comes from the insert itself, not
   * from a guess. Saying "500 added" when 437 went in would be a silent lie.
   */
  async bulkAdd(actor: SessionUser, text: string, ip: string): Promise<BulkResult> {
    this.assertCanUse(actor);

    const lines = pastedLineCount(text);
    if (lines > BULK_MAX_LINES) {
      throw new BadRequestException(
        `At most ${BULK_MAX_LINES} tasks can be added at once — this paste has ${lines} lines.`,
      );
    }

    const { accepted, rejected } = parseBulk(text);

    /**
     * Existing references are looked up first, so a pasted duplicate does not
     * burn a task number (`nextval` runs before `ON CONFLICT` decides).
     */
    const existing =
      accepted.length === 0
        ? new Set<string>()
        : new Set(
            (
              await this.prisma.task.findMany({
                where: { reference: { in: accepted.map((t) => t.reference) } },
                select: { reference: true },
              })
            ).map((r) => r.reference),
          );
    const fresh = accepted.filter((t) => !existing.has(t.reference));

    /**
     * The task number is assigned when the task is added, so even a row
     * sitting in the pool has an identity people can point at.
     *
     * `nextval` cannot be called through `createMany`, so this is a raw
     * insert; `WITH ORDINALITY` keeps the numbers in paste order.
     */
    const inserted =
      fresh.length === 0
        ? []
        : await this.prisma.$queryRaw<{ reference: string }[]>`
            INSERT INTO tasks (reference, link, added_by_id, task_number)
            SELECT x.r, x.l, ${actor.userId}, nextval('task_number_seq')
            FROM (
              SELECT r, l, n
              FROM unnest(
                ${fresh.map((t) => t.reference)}::text[],
                ${fresh.map((t) => t.link)}::text[]
              ) WITH ORDINALITY AS u(r, l, n)
              ORDER BY n
            ) AS x
            ON CONFLICT (reference) DO NOTHING
            RETURNING reference
          `;
    const insertedRefs = new Set(inserted.map((r) => r.reference));

    const known = accepted.filter((t) => !insertedRefs.has(t.reference));
    const allRejected = [
      ...rejected,
      ...known.map((t) => ({
        line: t.line,
        text: t.link !== null && t.link !== t.reference ? `${t.reference} | ${t.link}` : t.reference,
        reason: 'already_exists' as const,
      })),
    ].sort((a, b) => a.line - b.line);

    const poolSize = await this.prisma.task.count({
      where: { status: TaskStatus.pool },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'tasks',
      targetId: 'bulk',
      ipAddress: ip,
      // The references do not go into the audit log: five hundred of them
      // help nobody, and the list is in the table anyway
      meta: {
        added: inserted.length,
        rejected: allRejected.length,
        pasted: accepted.length + rejected.length,
      },
    });

    return {
      added: inserted.length,
      alreadyKnown: known.length,
      rejected: allRejected.slice(0, REJECTED_SHOWN),
      rejectedTotal: allRejected.length,
      poolSize,
    };
  }

  /**
   * The daily hand-out: random, but fair.
   *
   * Careful: the pick is random in the database itself (`ORDER BY random()`),
   * not in memory.
   *
   * Careful: claiming happens as an update with the `status = 'pool'`
   * condition. If two runs overlapped (the owner pressing the button while the
   * job runs), the same task would otherwise land in two hands.
   *
   * Never throws: if the hand-out fails it is tried again tomorrow.
   */
  async distribute(now: Date = new Date()): Promise<{ assigned: number }> {
    let assigned = 0;

    try {
      const assignees = await this.prisma.employee.findMany({
        where: { status: 'active', receivesTasks: true },
        select: { id: true, empCode: true },
        // By staff code: when the pool is short, who goes first must be
        // predictable. (The pick is random, not the order.)
        orderBy: { empCode: 'asc' },
      });
      if (assignees.length === 0) return { assigned: 0 };

      const open = await this.prisma.task.groupBy({
        by: ['assignedToId'],
        where: {
          status: TaskStatus.assigned,
          assignedToId: { in: assignees.map((d) => d.id) },
        },
        _count: { _all: true },
      });
      const openBy = new Map(open.map((o) => [o.assignedToId, o._count._all]));

      const poolSize = await this.prisma.task.count({
        where: { status: TaskStatus.pool },
      });

      const sizes = allocationSizes(
        assignees.map((d) => ({
          employeeId: d.id,
          openCount: openBy.get(d.id) ?? 0,
        })),
        poolSize,
      );

      for (const [employeeId, size] of sizes) {
        assigned += await this.claimFor(employeeId, size, now);
      }

      if (assigned > 0) {
        this.logger.log(`Tasks handed out · ${assigned} to ${sizes.size} people`);
      }
    } catch (err) {
      this.logger.error(
        `Could not hand out tasks: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { assigned };
  }

  /**
   * Claims `size` tasks from the pool for one person.
   *
   * Careful: the `WHERE status = 'pool'` condition is inside the update, so
   * even if two runs overlap, one row cannot land in two hands.
   */
  private async claimFor(
    employeeId: number,
    size: number,
    now: Date,
  ): Promise<number> {
    const picked = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM tasks
      WHERE status = 'pool'
      ORDER BY random()
      LIMIT ${size}
      FOR UPDATE SKIP LOCKED
    `;
    if (picked.length === 0) return 0;

    let count = 0;

    for (const row of picked) {
      const done = await this.prisma.$executeRaw`
        UPDATE tasks
        SET status = 'assigned',
            assigned_to_id = ${employeeId},
            assigned_at = ${now},
            -- COALESCE: a task that came back to the pool already has a
            -- number, and the number belongs to the task, not to the
            -- assignment. A new one would leave old window titles matching nothing.
            task_number = COALESCE(task_number, nextval('task_number_seq'))
        WHERE id = ${row.id} AND status = 'pool'
      `;
      count += done;
    }

    return count;
  }

  /**
   * End of day: return untouched tasks to the pool.
   *
   * If someone was given 30 and did 15, the other 15 go back to the pool and
   * are handed out again later, so the pool always shows the work really left.
   *
   * Careful: anything started is not returned, and this is the most important
   * condition here: work in progress would otherwise land in someone else's
   * hands tomorrow. "Started" is `startedAt` (ever) or the number seen on
   * screen today (`task_credits`).
   *
   * Careful: the task number is not cleared: it belongs to the task.
   *
   * Never throws.
   */
  async returnUnworked(workDate: Date): Promise<{ returned: number }> {
    try {
      /**
       * Numbers seen on someone's screen today, per staff member.
       * `task_credits.task_number` is text and `tasks.task_number` is a
       * number, so the match is done as text (`1000042` either way).
       */
      const touched = await this.prisma.taskCredit.findMany({
        where: { firstWorkDate: workDate },
        select: { employeeId: true, taskNumber: true },
      });

      const keep = new Set(touched.map((t) => `${t.employeeId}:${t.taskNumber}`));

      const open = await this.prisma.task.findMany({
        where: { status: TaskStatus.assigned },
        select: { id: true, assignedToId: true, taskNumber: true, startedAt: true },
      });

      const ids = open
        // Careful: started tasks are not returned: work running for three
        // days would otherwise go back on the one day it was not opened.
        .filter((t) => t.startedAt === null)
        .filter((t) => !keep.has(`${t.assignedToId}:${t.taskNumber}`))
        .map((t) => t.id);
      if (ids.length === 0) return { returned: 0 };

      const { count } = await this.prisma.task.updateMany({
        // The `status` condition is here too, so that if someone finishes in
        // the meantime, their work does not go back to the pool
        where: { id: { in: ids }, status: TaskStatus.assigned },
        data: { status: TaskStatus.pool, assignedToId: null, assignedAt: null },
      });

      if (count > 0) this.logger.log(`Tasks returned to the pool · ${count}`);

      return { returned: count };
    } catch (err) {
      this.logger.error(
        `Could not return tasks: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { returned: 0 };
    }
  }

  /**
   * The assignee's own list: what is in hand, and what was finished today.
   *
   * Today's finished ones are included so a Complete pressed by mistake can be
   * undone: a row that vanished on Complete would leave no Undo to press.
   *
   * Careful: it goes no further than today. Undoing yesterday's Complete would
   * change yesterday's numbers too. The owner can undo older ones.
   */
  async mine(employeeId: number): Promise<MyTask[]> {
    const rows = await this.prisma.task.findMany({
      where: {
        assignedToId: employeeId,
        OR: [
          { status: TaskStatus.assigned },
          {
            status: TaskStatus.done,
            completedAt: { gte: workStart(workDateStr(new Date())) },
          },
        ],
      },
      select: {
        id: true,
        reference: true,
        link: true,
        taskNumber: true,
        assignedAt: true,
        startedAt: true,
        completedAt: true,
      },
      // Earlier first: otherwise old tasks would sink to the bottom for good
      orderBy: { assignedAt: 'asc' },
    });

    return rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      link: r.link,
      taskNumber: r.taskNumber,
      assignedAt: r.assignedAt?.toISOString() ?? null,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Take back a "done".
   *
   * Careful: `completedAt`, `completedVia` and `completedById` must all be
   * cleared; restoring only `status` is not enough. The queues run on
   * `completedAt` (`to_check`, `to_deliver`), not on `status`.
   *
   * But `assignedToId`/`assignedAt`/`startedAt` are not touched: the work stays
   * with whoever had it.
   */
  private async clearCompletion(
    where: Prisma.TaskWhereInput,
    by: { userId: number; ip: string | null },
  ): Promise<number> {
    /**
     * Careful: the row is read before clearing: the proof that the work was
     * ever finished is about to disappear from the row.
     */
    const before = await this.prisma.task.findFirst({
      where,
      select: {
        id: true,
        reference: true,
        taskNumber: true,
        assignedToId: true,
        completedAt: true,
        completedVia: true,
        completedById: true,
      },
    });
    if (before === null) return 0;

    const { count } = await this.prisma.task.updateMany({
      where,
      data: {
        status: TaskStatus.assigned,
        completedAt: null,
        completedVia: null,
        completedById: null,
      },
    });
    if (count === 0) return 0;

    /** This is the only clearing action that leaves no trace of its own, so the log is the only place. */
    await this.audit.record({
      userId: by.userId,
      action: 'task_undone',
      targetType: 'task',
      targetId: before.id,
      ipAddress: by.ip ?? undefined,
      meta: {
        reference: before.reference,
        taskNumber: before.taskNumber,
        assignedToId: before.assignedToId,
        // What was cleared: the row no longer has these
        completedAt: before.completedAt?.toISOString() ?? null,
        completedVia: before.completedVia,
        completedById: before.completedById,
      },
    });

    return count;
  }

  /**
   * The assignee's own Undo: today's, their own, and not yet moved along.
   *
   * Careful: staying silent when `count === 0` is not an option. "I pressed
   * Undo and nothing happened" is the silent failure that makes people lose
   * trust in the system. So it works out why it did not happen and says so.
   */
  async undoMine(
    employeeId: number,
    id: number,
    now: Date,
    by: { userId: number; ip: string | null },
  ): Promise<{ ok: boolean }> {
    const count = await this.clearCompletion(
      {
        id,
        assignedToId: employeeId,
        status: TaskStatus.done,
        completedAt: { gte: workStart(workDateStr(now)) },
        // A row that moved along the chain is no longer "pressed by mistake"
        checkedAt: null,
        deliveredAt: null,
        publishedAt: null,
      },
      by,
    );
    if (count > 0) return { ok: true };

    const row = await this.prisma.task.findUnique({
      where: { id },
      select: {
        assignedToId: true,
        status: true,
        completedAt: true,
        checkedAt: true,
        deliveredAt: true,
        publishedAt: true,
      },
    });

    if (!row || row.assignedToId !== employeeId) {
      throw new ForbiddenException('That task is not on your list.');
    }
    if (row.status !== TaskStatus.done || row.completedAt === null) {
      // Pressing twice lands here, and that is not a failure
      return { ok: true };
    }
    if (row.checkedAt !== null || row.deliveredAt !== null || row.publishedAt !== null) {
      throw new ConflictException(
        'This task has already moved on — someone has checked or delivered it. Ask the owner to undo it.',
      );
    }
    throw new ConflictException(
      "You can only undo today's work. Ask the owner to undo an older one.",
    );
  }

  /**
   * Undo for owner, manager and coordinator: any day, anyone's.
   *
   * A row that moved along the chain cannot be undone here either: undoing it
   * would make the check queue and the delivery counts wrong together.
   */
  async undoComplete(
    id: number,
    by: { userId: number; ip: string | null },
  ): Promise<{ ok: boolean }> {
    const count = await this.clearCompletion(
      {
        id,
        status: TaskStatus.done,
        checkedAt: null,
        deliveredAt: null,
        publishedAt: null,
      },
      by,
    );
    if (count > 0) return { ok: true };

    const row = await this.prisma.task.findUnique({
      where: { id },
      select: { status: true, checkedAt: true, deliveredAt: true, publishedAt: true },
    });
    if (!row) throw new NotFoundException('Task not found');
    if (row.status !== TaskStatus.done) return { ok: true };

    throw new ConflictException(
      'This task has already been checked or delivered — undo those steps first.',
    );
  }

  /**
   * "I am dropping this".
   *
   * Careful: the condition includes `assignedToId`: nobody can touch a task
   * that is not theirs.
   */
  async skip(
    employeeId: number,
    id: number,
    reason: DropReason,
    now: Date = new Date(),
  ): Promise<{ ok: boolean }> {
    const { count } = await this.prisma.task.updateMany({
      where: { id, assignedToId: employeeId, status: TaskStatus.assigned },
      data: { status: TaskStatus.skipped, dropReason: reason },
    });

    // Dropping also empties the hand, so top up here too
    if (count > 0) await this.topUp(employeeId, now);

    return { ok: count > 0 };
  }

  /**
   * "I finished": a manual mark.
   *
   * `completedVia: 'manual'` is stored so it can later be told which were
   * detected by the system and which were declared by hand.
   */
  async markDone(
    employeeId: number,
    id: number,
    userId: number,
    now: Date = new Date(),
  ): Promise<{ ok: boolean }> {
    /**
     * The daily limit: the cap is the person's own daily target
     * ([`dailyCompletionCap`]).
     *
     * Careful: this applies only on this path, where the assignee presses the
     * button (`POST /me/tasks/:id/done`). The owner's `update()` path is
     * untouched; otherwise the way to correct mistakes would be closed.
     */
    // Serialize completion decisions per employee across API instances.
    const count = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(260926, ${employeeId}::int)::text AS locked`;
      const cap = await this.capFor(employeeId, tx);
      if (cap !== null) {
        const doneToday = await this.completedToday(employeeId, now, tx);
        if (doneToday >= cap) {
          throw new ConflictException(
            `You have already marked ${cap} tasks done today, so this one ` +
              `cannot be marked done — leave it in your list and finish it tomorrow.`,
          );
        }
      }
      const result = await tx.task.updateMany({
        where: { id, assignedToId: employeeId, status: TaskStatus.assigned },
        data: {
          status: TaskStatus.done,
          completedAt: now,
          completedVia: 'manual',
          completedById: userId,
        },
      });
      return result.count;
    });
    if (count > 0) await this.topUp(employeeId, now);

    return { ok: count > 0 };
  }

  /**
   * Checks every assignee's hand and gives more only to those who need it.
   *
   * Careful: running right after an event is not enough: someone with
   * nothing in hand cannot press anything, yet they are exactly who the rule
   * is for (a short pool in the morning, someone who joined mid-day).
   *
   * `topUp()` is itself idempotent (it returns 0 if the hand is full).
   */
  async topUpAll(now: Date = new Date()): Promise<void> {
    const assignees = await this.prisma.employee.findMany({
      where: { status: 'active', receivesTasks: true },
      select: { id: true },
      orderBy: { empCode: 'asc' },
    });

    for (const d of assignees) await this.topUp(d.id, now);
  }

  /** This person's daily limit. `null` means no limit. */
  private async capFor(
    employeeId: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<number | null> {
    const emp = await db.employee.findUnique({
      where: { id: employeeId },
      select: {
        receivesTasks: true,
        dailyTaskTarget: true,
        policy: { select: { dailyTaskTarget: true } },
      },
    });
    if (emp === null) return null;

    return dailyCompletionCap(
      emp.receivesTasks,
      emp.dailyTaskTarget,
      emp.policy?.dailyTaskTarget,
    );
  }

  /**
   * How many were marked done in today's work day.
   *
   * Careful: the boundaries come from `localMidnightOf`/`nextLocalMidnight`,
   * not computed by hand. `workDateOf()` is a label, not an instant.
   *
   * Careful: counted by `assignedToId`, not `completedById`. The dashboard
   * number does the same, and if the two differed the screen and the limit
   * would say different things.
   */
  private async completedToday(
    employeeId: number,
    now: Date,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    return db.task.count({
      where: {
        assignedToId: employeeId,
        completedAt: { gte: localMidnightOf(now), lt: nextLocalMidnight(now) },
      },
    });
  }

  /**
   * Gives more when the hand is not full enough, right after a completion or
   * skip.
   *
   * Careful: never throws. Top-up is a convenience; if it fails, the press of
   * "I finished" must not fail.
   */
  private async topUp(employeeId: number, now: Date): Promise<void> {
    try {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: {
          receivesTasks: true,
          dailyTaskTarget: true,
          policy: { select: { dailyTaskTarget: true } },
        },
      });
      if (emp === null) return;

      const dailyTarget = taskTargetOf(emp.dailyTaskTarget, emp.policy?.dailyTaskTarget);
      // Nothing for someone without a target: the morning hand-out is enough
      if (!hasTaskTarget(emp.receivesTasks, dailyTarget)) return;

      const [completedToday, openCount, issuedToday] = await Promise.all([
        this.completedToday(employeeId, now),
        this.prisma.task.count({
          where: { assignedToId: employeeId, status: TaskStatus.assigned },
        }),
        // The total issued today: the daily ceiling stands on this
        this.prisma.task.count({
          where: {
            assignedToId: employeeId,
            assignedAt: { gte: localMidnightOf(now), lt: nextLocalMidnight(now) },
          },
        }),
      ]);

      const size = topUpSize({
        receivesTasks: emp.receivesTasks,
        completedToday,
        openCount,
        issuedToday,
        dailyTarget,
      });
      if (size === 0) return;

      const given = await this.claimFor(employeeId, size, now);

      if (given > 0) {
        this.logger.log(
          `Tasks topped up · ${given} to employee ${employeeId} ` +
            `(done ${completedToday}, had ${openCount})`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Top-up failed for employee ${employeeId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Start detection: "work started" from the task number in a window title.
   *
   * Careful: this is "started", never "done". The number shows the moment
   * the window comes to the front, i.e. when work begins; the assignee
   * declares "done" themselves (`markDone`).
   *
   * Careful: the condition includes `assignedToId`: one person's window
   * cannot start another's task.
   *
   * Never throws: this is a convenience, and it must not block the daily
   * summary.
   */
  async markStartedByTaskNumbers(
    employeeId: number,
    /**
     * Number → the earliest instant that day it was seen on screen.
     *
     * A `Map`, so each number cannot be passed without its own instant (a
     * single `Date` invited passing the work-day label, which gave every task
     * the same "started" time).
     */
    startedAt: ReadonlyMap<string, Date>,
  ): Promise<number> {
    if (startedAt.size === 0) return 0;

    const at = new Map<number, Date>();
    for (const [raw, when] of startedAt) {
      const n = Number.parseInt(raw, 10);
      if (Number.isSafeInteger(n)) at.set(n, when);
    }
    if (at.size === 0) return 0;

    try {
      const pending = await this.prisma.task.findMany({
        where: {
          taskNumber: { in: [...at.keys()] },
          assignedToId: employeeId,
          status: TaskStatus.assigned,
          // One already marked is not touched again; otherwise "when started"
          // would slide to today's date every day
          startedAt: null,
        },
        select: { id: true, taskNumber: true },
      });

      let count = 0;

      for (const row of pending) {
        const when = row.taskNumber === null ? undefined : at.get(row.taskNumber);
        if (when === undefined) continue;

        // The `startedAt: null` condition is here too: another run could set
        // the mark between the read above and this write
        const { count: n } = await this.prisma.task.updateMany({
          where: { id: row.id, startedAt: null },
          data: { startedAt: when },
        });

        count += n;
      }

      return count;
    } catch (err) {
      this.logger.warn(
        `Could not mark tasks started: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  /**
   * The full list, with filters and paging.
   *
   * `q` matches a reference (case-insensitive, part of it) or a task number.
   */
  async list(query: {
    status?: TaskStatus;
    q?: string;
    page?: number;
    /** Which assignee: `employees.id` */
    staffId?: number;
    /**
     * Who added them: `users.id`.
     *
     * Careful: a different id space from `staffId` (that is `employees`, this
     * is `users`).
     */
    addedById?: number;
    /** 'YYYY-MM-DD': date of the last activity, from this day */
    from?: string;
    /** 'YYYY-MM-DD': up to and including this day */
    to?: string;
    /** Which step of the chain it is stuck on; `no_file` is a question, not a step */
    stage?: TaskStage;
  }): Promise<TaskList> {
    const page = Math.max(1, query.page ?? 1);

    /**
     * Careful: the range is checked before `Number()`. `task_number` is an
     * `Int`, so anything above 2,147,483,647 would make Prisma throw and the
     * search return 500, when the user merely typed a long number.
     */
    const INT32_MAX = 2_147_483_647;
    let match: TaskSearchMatch | undefined;

    const term = query.q?.trim();
    if (term) {
      const digits = /^\d+$/.test(term);
      const taskNumber = digits ? Number(term) : NaN;
      const reference = { contains: term, mode: 'insensitive' as const };

      match =
        digits && Number.isSafeInteger(taskNumber) && taskNumber <= INT32_MAX
          ? { OR: [{ taskNumber }, { reference }] }
          : { reference };
    }

    /**
     * The date applies to `lastActivityAt`, i.e. "the last thing that
     * happened": one basis for both sorting and filtering.
     *
     * Careful: the day in `to` is inclusive ("up to the 23rd" includes the
     * 23rd), so it looks up to the start of the next day (`lt`).
     */
    const activity =
      query.from || query.to
        ? {
            ...(query.from ? { gte: workStart(query.from) } : {}),
            ...(query.to ? { lt: nextDay(query.to) } : {}),
          }
        : undefined;

    /**
     * Start detection decides whether on-screen time means anything at all.
     * Off → every `onScreenSec` is `null` and `no_file` finds nothing.
     */
    const apps = await this.settings.detectionApps();
    const detecting = apps.size > 0;

    /**
     * Since which day titles have been stored. The right to say "never on
     * screen" begins only after this date.
     */
    const traceSince = detecting ? await this.onScreen.since() : null;
    const since = traceSince === null ? null : workStart(traceSince);

    const unseen =
      query.stage === 'no_file' && since !== null
        ? await this.onScreen.unseenTaskNumbers(since, apps)
        : [];

    const stage = this.stageWhere(query.stage, since, unseen);

    const where: Prisma.TaskWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(match ?? {}),
      ...(query.staffId ? { assignedToId: query.staffId } : {}),
      ...(query.addedById ? { addedById: query.addedById } : {}),
      ...(activity ? { lastActivityAt: activity } : {}),
      ...stage,
    };

    const [total, rows] = await Promise.all([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        select: {
          id: true,
          reference: true,
          link: true,
          status: true,
          taskNumber: true,
          assignedAt: true,
          startedAt: true,
          completedAt: true,
          completedVia: true,
          checkedAt: true,
          errorFoundAt: true,
          fixedAt: true,
          deliveredAt: true,
          publishedAt: true,
          publishedRef: true,
          sourceNote: true,
          dropReason: true,
          reviewedAt: true,
          reviewedBy: { select: { fullName: true, role: true } },
          assignedTo: { select: { empCode: true, fullName: true } },
          completedBy: { select: { fullName: true, role: true } },
          addedBy: { select: { fullName: true, role: true } },
          addedAt: true,
        },
        /**
         * Latest activity first; `id` is the second key so rows added at the
         * same instant keep the same order every time (otherwise paging could
         * show the same row twice or not at all).
         */
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * TASK_PAGE_SIZE,
        take: TASK_PAGE_SIZE,
      }),
    ]);

    /** Only for the rows on screen: 50 numbers, 50 index lookups. */
    const seconds = detecting
      ? await this.onScreen.secondsFor(
          rows.map((r) => r.taskNumber).filter((n): n is number => n !== null),
          apps,
        )
      : new Map<number, number>();

    return {
      traceSince,
      startDetection: detecting,
      rows: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        link: r.link,
        status: r.status,
        taskNumber: r.taskNumber,
        assignedTo: r.assignedTo,
        assignedAt: r.assignedAt?.toISOString() ?? null,
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        completedVia: r.completedVia,
        onScreenSec: onScreenSecOf(r, seconds, since),
        completedBy: r.completedBy,
        addedBy: r.addedBy,
        addedAt: r.addedAt.toISOString(),
        checkedAt: r.checkedAt?.toISOString() ?? null,
        errorFoundAt: r.errorFoundAt?.toISOString() ?? null,
        fixedAt: r.fixedAt?.toISOString() ?? null,
        deliveredAt: r.deliveredAt?.toISOString() ?? null,
        publishedAt: r.publishedAt?.toISOString() ?? null,
        publishedRef: r.publishedRef,
        sourceNote: r.sourceNote,
        dropReason: r.dropReason,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
        reviewedBy: r.reviewedBy,
      })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / TASK_PAGE_SIZE)),
    };
  }

  /**
   * The stage filters.
   *
   * Careful: `stats()` counts with these same conditions (`STAGE_*` below),
   * so a chip's number and the list it opens always agree.
   */
  private stageWhere(
    stage: TaskStage | undefined,
    since: Date | null,
    unseen: readonly number[],
  ): Prisma.TaskWhereInput {
    switch (stage) {
      case 'no_file':
        /**
         * Marked done, yet the number was never seen on screen.
         *
         * Careful: this is not an alert, and that is deliberate: a "silent
         * list". There are many innocent explanations for no trace, so the
         * list is a question, not an accusation. Without start detection
         * (or before titles were stored) there is no right to say anything.
         */
        return since === null
          ? { id: { in: [] as number[] } }
          : { completedAt: { not: null, gte: since }, taskNumber: { in: [...unseen] } };
      case 'to_check':
        return STAGE_TO_CHECK;
      case 'to_fix':
        return STAGE_TO_FIX;
      case 'to_deliver':
        return STAGE_TO_DELIVER;
      case 'to_publish':
        return STAGE_TO_PUBLISH;
      case 'to_review':
        return STAGE_TO_REVIEW;
      default:
        return {};
    }
  }

  /**
   * Edit the list: owner, manager, coordinator.
   *
   * Careful: the reference cannot be changed, on purpose. It is the row's
   * identity; changing it would shake the whole basis of the duplicate guard.
   * For a wrong reference, delete the row and add it again.
   *
   * What can change is the status: return to the pool (taking it out of
   * someone's hand), mark done, or drop.
   */
  async update(
    id: number,
    status: TaskStatus,
    now: Date,
    userId: number,
  ): Promise<{ ok: boolean }> {
    /**
     * Careful: returning to the pool also gives up ownership and clears every
     * later stage: a new assignment must pass through the workflow again.
     * The task number is not cleared: it belongs to the task.
     */
    const data =
      status === TaskStatus.pool
        ? {
            status,
            assignedToId: null,
            assignedAt: null,
            startedAt: null,
            completedAt: null,
            completedVia: null,
            completedById: null,
            // A row back in the pool is no longer dropped, so its reason and
            // "reviewed" mark have nothing left to refer to
            dropReason: null,
            reviewedAt: null,
            reviewedById: null,
            checkedAt: null,
            checkedById: null,
            errorFoundAt: null,
            fixedAt: null,
            fixedById: null,
            deliveredAt: null,
            publishedAt: null,
            publishedRef: null,
          }
        : status === TaskStatus.done
          ? { status, completedAt: now, completedVia: 'manual', completedById: userId }
          : { status };

    const { count } = await this.prisma.task.updateMany({
      where: {
        id,
        // A retry must not move yesterday's completion into today's count.
        ...(status === TaskStatus.done
          ? { status: { not: TaskStatus.done } }
          : {}),
      },
      data,
    });
    if (count > 0) return { ok: true };
    if (status === TaskStatus.done) {
      const existing = await this.prisma.task.findUnique({
        where: { id }, select: { status: true },
      });
      return { ok: existing?.status === TaskStatus.done };
    }
    return { ok: false };
  }

  /**
   * Delete: the row stays and is only marked `deleted`, with a reason.
   *
   * Careful: a real `DELETE` would take the `reference` UNIQUE guard with it:
   * the same reference pasted again tomorrow would come back as new work.
   *
   * Careful: rows that are done are not touched. `done` means someone really
   * did the work; deleting it would lower their day's count. If selected by
   * mistake, `keptDone` tells the screen what happened.
   *
   * A row in hand (`assigned`) can be deleted; the status change moves it off
   * the assignee's list, so the next hand-out supplies a replacement.
   */
  async softDelete(
    ids: readonly number[],
    userId: number,
    ip: string,
    reason: DropReason,
  ): Promise<DeleteResult> {
    // The same id twice would be counted twice, inflating the number on screen
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return { deleted: 0, keptDone: 0 };

    // Eligibility belongs in the write: an assignee may complete work while
    // this request is in flight. RETURNING also makes audit IDs match actual writes.
    const deleted = await this.prisma.task.updateManyAndReturn({
      where: {
        id: { in: wanted },
        status: { notIn: [TaskStatus.done, TaskStatus.deleted] },
      },
      data: { status: TaskStatus.deleted, dropReason: reason },
      select: { id: true },
    });
    const count = deleted.length;
    const keptDone = await this.prisma.task.count({
      where: { id: { in: wanted }, status: TaskStatus.done },
    });

    if (count > 0) {
      await this.audit.record({
        userId,
        action: 'task_deleted',
        targetType: 'tasks',
        targetId: deleted.length === 1 ? String(deleted[0].id) : 'bulk',
        ipAddress: ip,
        // The counts, not the references: the list is in the table (same rule as `bulkAdd`)
        meta: { deleted: count, keptDone, asked: wanted.length, reason },
      });
    }

    return { deleted: count, keptDone };
  }

  /**
   * Everyone who ever held a task, for the filter dropdown.
   *
   * Careful: the ordinary staff-list route could not be used: it is
   * owner/manager only, yet coordinators see this page too. Only name and
   * code go out.
   *
   * Staff who have left are included too: old tasks are tied to their names.
   */
  async assignees(): Promise<{ id: number; empCode: string; fullName: string }[]> {
    return this.prisma.employee.findMany({
      where: { tasks: { some: {} } },
      select: { id: true, empCode: true, fullName: true },
      orderBy: { empCode: 'asc' },
    });
  }

  /**
   * How many tasks each user has added, for the "added by" dropdown.
   *
   * Careful: unlike `assignees()` this is `users`, not `employees`: tasks are
   * added by users, and the owner has no `employees` row at all.
   */
  async adders(): Promise<
    { id: number; fullName: string; role: UserRole; count: number }[]
  > {
    const grouped = await this.prisma.task.groupBy({
      by: ['addedById'],
      _count: { _all: true },
    });
    if (grouped.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.addedById) } },
      select: { id: true, fullName: true, role: true },
    });
    const countOf = new Map(grouped.map((g) => [g.addedById, g._count._all]));

    return users
      .map((u) => ({ ...u, count: countOf.get(u.id) ?? 0 }))
      // Whoever added the most is first
      .sort((a, b) => b.count - a.count);
  }

  async stats(): Promise<TaskStats> {
    /**
     * Delivered and published are counted separately: those are dates, not
     * states, so one task can be `done` and delivered and published at once.
     */
    const [rows, delivered, published, toCheck, toFix, toDeliver, toPublish, toReview] =
      await Promise.all([
        this.prisma.task.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.task.count({ where: { deliveredAt: { not: null } } }),
        this.prisma.task.count({ where: { publishedAt: { not: null } } }),
        // Careful: exact twins of the `list()` stage filters
        this.prisma.task.count({ where: STAGE_TO_CHECK }),
        this.prisma.task.count({ where: STAGE_TO_FIX }),
        this.prisma.task.count({ where: STAGE_TO_DELIVER }),
        this.prisma.task.count({ where: STAGE_TO_PUBLISH }),
        this.prisma.task.count({ where: STAGE_TO_REVIEW }),
      ]);

    const out: TaskStats = {
      pool: 0,
      assigned: 0,
      done: 0,
      skipped: 0,
      /**
       * Careful: the zeros are written by hand here, on purpose: the type is
       * `Record<TaskStatus, number>`, so when a new value is added to the
       * enum, the type check stops here.
       */
      deleted: 0,
      perAssignee: POOL_PER_ASSIGNEE,
      delivered,
      published,
      toCheck,
      toFix,
      toDeliver,
      toPublish,
      toReview,
    };
    for (const r of rows) out[r.status] = r._count._all;

    return out;
  }

  /**
   * "Checked": the one method behind the checker's two buttons.
   *
   * Careful: the machine does not inspect the work. It only keeps the books:
   * which are still to check, who checked, what they found.
   *
   * `ok: false` means a problem was found: `errorFoundAt` is set too, and the
   * row goes into the "to fix" queue.
   *
   * Careful: idempotent. Pressing again does not move the date.
   */
  async markChecked(
    id: number,
    ok: boolean,
    userId: number,
    now: Date,
  ): Promise<{ ok: true }> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: { completedAt: true, checkedAt: true },
    });
    if (!task) throw new NotFoundException('No task with this id');
    if (task.completedAt === null) {
      throw new BadRequestException(
        'This task is not finished yet, so there is nothing to check.',
      );
    }
    if (task.checkedAt !== null) return { ok: true };

    await this.prisma.task.update({
      where: { id },
      data: {
        checkedAt: now,
        checkedById: userId,
        errorFoundAt: ok ? null : now,
      },
    });
    return { ok: true };
  }

  /**
   * "Fixed": the fixer's button.
   *
   * Careful: `assignedToId` is not touched. The task stays with the original
   * assignee; otherwise the work would pass to whoever fixed it and inflate
   * their count.
   */
  async markFixed(id: number, userId: number, now: Date): Promise<{ ok: true }> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: { errorFoundAt: true, fixedAt: true },
    });
    if (!task) throw new NotFoundException('No task with this id');
    if (task.errorFoundAt === null) {
      throw new BadRequestException(
        'No problem was recorded for this task, so there is nothing to fix.',
      );
    }
    if (task.fixedAt !== null) return { ok: true };

    await this.prisma.task.update({
      where: { id },
      data: { fixedAt: now, fixedById: userId },
    });
    return { ok: true };
  }

  /**
   * "Reviewed": the only way for the owner and manager to empty their queue.
   *
   * Careful: the row's status does not change; `skipped` stays `skipped`.
   * This is an acknowledgement ("I have seen it"), not a decision.
   */
  async markReviewed(
    id: number,
    userId: number,
    now: Date,
  ): Promise<{ ok: boolean }> {
    const { count } = await this.prisma.task.updateMany({
      where: {
        id,
        status: { in: [TaskStatus.skipped, TaskStatus.deleted] },
        dropReason: { not: null },
      },
      data: { reviewedAt: now, reviewedById: userId },
    });

    return { ok: count > 0 };
  }

  /**
   * "Delivered": it cannot be delivered before it is finished.
   *
   * If already marked the date does not move.
   */
  async markDelivered(id: number, now: Date): Promise<{ ok: true }> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: { completedAt: true, deliveredAt: true },
    });
    if (!task) throw new NotFoundException('No task with this id');
    if (task.completedAt === null) {
      throw new BadRequestException(
        'This task is not finished yet, so it cannot be marked delivered.',
      );
    }
    if (task.deliveredAt !== null) return { ok: true };

    await this.prisma.task.update({
      where: { id },
      data: { deliveredAt: now },
    });
    return { ok: true };
  }

  /**
   * "Published", with an optional reference for the result.
   *
   * It cannot be published without being delivered first.
   */
  async markPublished(
    id: number,
    publishedRef: string | null,
    now: Date,
  ): Promise<{ ok: true }> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: { deliveredAt: true, publishedAt: true },
    });
    if (!task) throw new NotFoundException('No task with this id');
    if (task.deliveredAt === null) {
      throw new BadRequestException(
        'This task has not been delivered yet, so it cannot be published.',
      );
    }
    if (task.publishedAt !== null) return { ok: true };

    await this.prisma.task.update({
      where: { id },
      data: { publishedAt: now, publishedRef },
    });
    return { ok: true };
  }
}

/** Done, not checked yet */
const STAGE_TO_CHECK: Prisma.TaskWhereInput = {
  completedAt: { not: null },
  checkedAt: null,
};

/** A problem was found and not yet fixed */
const STAGE_TO_FIX: Prisma.TaskWhereInput = {
  errorFoundAt: { not: null },
  fixedAt: null,
};

/**
 * Done, not delivered yet.
 *
 * Careful: rows with a problem found but not yet fixed are excluded: known
 * broken work must not be delivered. Rows not yet checked are not blocked,
 * though: checking is optional.
 */
const STAGE_TO_DELIVER: Prisma.TaskWhereInput = {
  completedAt: { not: null },
  deliveredAt: null,
  NOT: { errorFoundAt: { not: null }, fixedAt: null },
};

/** Delivered, not published yet */
const STAGE_TO_PUBLISH: Prisma.TaskWhereInput = {
  deliveredAt: { not: null },
  publishedAt: null,
};

/**
 * Dropped but nobody has looked.
 *
 * Careful: `dropReason: { not: null }`: rows dropped before reasons were
 * required have nothing to review, so they simply fall out.
 */
const STAGE_TO_REVIEW: Prisma.TaskWhereInput = {
  status: { in: [TaskStatus.skipped, TaskStatus.deleted] },
  dropReason: { not: null },
  reviewedAt: null,
};
