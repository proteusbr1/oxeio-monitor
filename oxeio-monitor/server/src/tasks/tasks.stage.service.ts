import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TaskStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Tasks: the steps after "done": check, fix, review a drop, deliver, publish.
 *
 * Careful: the queues these steps empty are counted in `TasksService.stats()`
 * (`STAGE_*` in tasks.service.ts); the conditions here and there must stay in step.
 */
@Injectable()
export class TasksStageService {
  constructor(private readonly prisma: PrismaService) {}

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
