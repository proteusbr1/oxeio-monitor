import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';

import { localMidnightOf, nextLocalMidnight } from '../agent/util/work-time';
import { PrismaService } from '../prisma/prisma.service';
import { dailyCompletionCap, hasTaskTarget, taskTargetOf } from '../summary/task-start.rules';
import { allocationSizes, topUpSize } from './tasks.rules';

/**
 * Tasks: the hand-out.
 *
 * The morning hand-out is random; the hand is topped up during the day; at the
 * end of the day untouched tasks go back to the pool.
 *
 * `capFor`, `completedToday` and `topUp` are public only because
 * `TasksPersonService` (Complete / skip) needs the same answers; there is one
 * definition of "the daily limit" and "done today".
 */
@Injectable()
export class TasksHandoutService {
  private readonly logger = new Logger(TasksHandoutService.name);

  constructor(private readonly prisma: PrismaService) {}

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
  async capFor(
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
  async completedToday(
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
  async topUp(employeeId: number, now: Date): Promise<void> {
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
}
