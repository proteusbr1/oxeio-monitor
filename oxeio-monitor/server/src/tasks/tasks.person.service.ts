import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { TasksHandoutService } from './tasks.handout.service';
import { type DropReason, workDateStr, workStart } from './tasks.rules';
import type { MyTask } from './tasks.types';

/**
 * Tasks: the assignee's own list and what they do with it.
 *
 * Each assignee works through their own list: Complete, Undo, drop. Start
 * detection ("work started", from a window title) also lands here, since it
 * only ever touches the assignee's own rows. The owner's Undo shares the
 * clearing step, so it lives here too.
 */
@Injectable()
export class TasksPersonService {
  private readonly logger = new Logger(TasksPersonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /** Top-up after Complete / skip, and the daily limit */
    private readonly handout: TasksHandoutService,
  ) {}

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
    if (count > 0) await this.handout.topUp(employeeId, now);

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
      const cap = await this.handout.capFor(employeeId, tx);
      if (cap !== null) {
        const doneToday = await this.handout.completedToday(employeeId, now, tx);
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
    if (count > 0) await this.handout.topUp(employeeId, now);

    return { ok: count > 0 };
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
}
