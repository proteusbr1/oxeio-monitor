import { BadRequestException, Injectable } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { BULK_MAX_LINES, parseBulk, pastedLineCount } from './tasks.rules';
import { TasksService } from './tasks.service';
import { REJECTED_SHOWN, type BulkResult } from './tasks.types';

/**
 * Tasks: adding to the pool.
 *
 * Coordinators, managers or the owner paste tasks into the pool; the morning
 * hand-out (`TasksHandoutService`) takes them from there.
 */
@Injectable()
export class TasksPoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /** The access guard (`assertCanUse`) lives there */
    private readonly tasks: TasksService,
  ) {}

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
    this.tasks.assertCanUse(actor);

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
}
