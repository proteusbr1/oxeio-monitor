import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, TaskStatus, UserRole } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { OnScreenService } from './on-screen.service';
import { TasksSettingsService } from './tasks-settings.service';
import {
  canUseTasks,
  type DropReason,
  nextDay,
  onScreenSecOf,
  POOL_PER_ASSIGNEE,
  workStart,
} from './tasks.rules';
import {
  TASK_PAGE_SIZE,
  type DeleteResult,
  type TaskList,
  type TaskStage,
  type TaskStats,
} from './tasks.types';

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

/**
 * Tasks: adding, hand-out and completion.
 *
 * Coordinators, managers or the owner paste tasks into the pool; the morning
 * hand-out is random; each assignee works through their own list.
 *
 * This class holds the guards, the full list (filters, paging, stage chips),
 * the dropdowns, the counts, and the owner's edits (status change, delete).
 * The rest of the module lives beside it:
 *   - `TasksPoolService` (tasks.pool.service.ts): bulk add into the pool
 *   - `TasksHandoutService` (tasks.handout.service.ts): hand-out, top-up, return
 *   - `TasksPersonService` (tasks.person.service.ts): the assignee's own list and actions
 *   - `TasksStageService` (tasks.stage.service.ts): check / fix / review / deliver / publish
 */
@Injectable()
export class TasksService {
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
