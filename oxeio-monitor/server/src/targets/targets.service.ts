import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DesignTargetStatus, Prisma, UserRole } from '@prisma/client';

import {
  LOCAL_OFFSET_ISO,
  localMidnightOf,
  nextLocalMidnight,
  workDateOf,
} from '../agent/util/work-time';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import {
  dailyCompletionCap,
  designTargetOf,
  hasDesignTarget,
} from '../summary/design.rules';
import { FileTraceService } from './file-trace.service';
import {
  allocationSizes,
  amazonUrl,
  canUseTargets,
  DESIGN_WORK_STAFF_TYPES,
  type DropReason,
  fileSecOf,
  parseBulk,
  POOL_PER_DESIGNER,
  topUpSize,
  UPLOAD_QUEUE_FROM,
  type RejectedLine,
} from './targets.rules';

/**
 * 'YYYY-MM-DD' becomes the Dhaka midnight of that day.
 *
 * Careful: this sits at module level on purpose. The `list()` filter and the
 * `stats()` count must use exactly the same date. If a chip says 132 and
 * clicking it shows 90, nobody will trust any number again, and this project
 * has had bugs precisely because the same formula was written in two places.
 */
const workStart = (day: string): Date =>
  new Date(`${day}T00:00:00${LOCAL_OFFSET_ISO}`);
const nextDay = (day: string): Date =>
  new Date(workStart(day).getTime() + 86_400_000);

/**
 * The later of two `'YYYY-MM-DD'` strings.
 *
 * Comparing as text is enough: for ISO dates, character order is time order.
 */
const laterDay = (a: string, b: string): string => (a >= b ? a : b);

/**
 * Which Dhaka day an instant falls on, as `'YYYY-MM-DD'`.
 *
 * Careful: `toISOString().slice(0,10)` would give the UTC day, which shows
 * yesterday before 06:00 in Dhaka. Someone who pressed Complete at 11 pm and
 * spotted a mistake would then find Undo blocked as "yesterday's work".
 */
const workDateStr = (at: Date): string =>
  workDateOf(at).toISOString().slice(0, 10);

/**
 * The most rejected lines shown on screen.
 *
 * With the ceiling raised, pasting 45,000 lines is possible. If someone
 * pastes the wrong file, all of them would be rejected, and sending the whole
 * list to the browser would make the response several MB and put a
 * 45,000-row table on screen, freezing the browser.
 *
 * The count (`rejectedTotal`) stays true; only the list is trimmed. Seeing
 * 200 is enough to understand the kind of mistake; row 201 says nothing new.
 */
export const REJECTED_SHOWN = 200;

export interface BulkResult {
  /** How many were newly added */
  added: number;
  /** Already existed: not a mistake, but worth knowing */
  alreadyKnown: number;
  /** At most `REJECTED_SHOWN`; the true count is in `rejectedTotal` */
  rejected: RejectedLine[];
  /** How many were really rejected; the full count even when the list is trimmed */
  rejectedTotal: number;
  /** How many are now waiting in the pool */
  poolSize: number;
}

/**
 * 50 per page: more would make scrolling a 39-thousand-row table painful, and
 * fewer would make the researcher keep pressing "next page".
 */
export const TARGET_PAGE_SIZE = 50;

/**
/**
 * The most rows one call can delete. The screen shows 50 per page, so nobody
 * will get near this; the ceiling stops accidents and oversized queries, not
 * people (same reasoning as the `BulkDto` ceiling).
 */
export const DELETE_MAX = 500;

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
 * What the Design Pool search matches: the ASIN, the job number, or both.
 *
 * Careful: digits-only input uses `OR`. Some ASINs are entirely numeric, and
 * searching only by job number would silently lose such a row.
 */
type TargetSearchMatch =
  | { asin: { contains: string } }
  | { OR: [{ jobNumber: number }, { asin: { contains: string } }] };

export interface TargetRow {
  id: number;
  asin: string;
  url: string;
  status: DesignTargetStatus;
  jobNumber: number | null;
  /** `null` on a row of staff who have left; the name is in `sourceNote` */
  assignedTo: { empCode: string; fullName: string } | null;
  assignedAt: string | null;
  /** The file was first opened: "work in progress" */
  startedAt: string | null;
  completedAt: string | null;
  completedVia: string | null;

  /**
   * Total seconds the file with that job number was on screen in the design
   * app.
   *
   * Careful: three states. `> 0` is measured; `0` means "marked done yet
   * never opened"; `null` means nothing to say. The middle one appears only on
   * rows marked done: a file in hand not yet being opened is normal, and
   * writing `no trace` there would be an accusation where no claim was made.
   * The rule is in [`fileSecOf`](./targets.rules.ts).
   *
   * This is not "was the work done": files that were not saved or were
   * renamed are not caught here. The number is context, not a verdict.
   */
  fileSec: number | null;
  /** Raw text from the old Excel, e.g. "Hafiz-24-05-2026" */
  sourceNote: string | null;

  /**
   * Why the row went out of work: `not_found`, `copyright` or `events`.
   *
   * Present on both `skipped` and `deleted`; `null` in other states. The text
   * on screen comes from `DROP_REASON_LABELS`, not from this value, so
   * changing the label leaves stored data intact.
   */
  dropReason: string | null;

  /**
   * The owner/manager has reviewed this. `null` means still in the queue.
   *
   * Meaningful only on dropped rows; always `null` on every other row.
   */
  reviewedAt: string | null;
  reviewedBy: { fullName: string; role: string } | null;

  /**
   * Careful: `list()` already returned the fields below, but this type did not
   * list them, so the contract was smaller than reality and TypeScript did not
   * notice (the result of `.map()` is structurally assignable). It was caught
   * when adding the spelling-check fields; all were written in together.
   */
  completedBy: { fullName: string; role: string } | null;

  /**
   * Who brought the target in.
   *
   * Do not confuse it with `assignedTo`: that is the staff member (who will
   * design it), this is the user (who brought the link). Two separate id
   * spaces: `assigned_to_id -> employees`, `added_by_id -> users`.
   *
   * It is never `null`: the column is `NOT NULL`, so every row has a source.
   * The type deliberately has no `| null`, because false optionality would
   * force pointless `?? '—'` on screen.
   */
  addedBy: { fullName: string; role: string };
  /** When it arrived; rows of the same batch land at one instant */
  addedAt: string;
  /** Spelling checked; `null` = not checked yet (ADR-038) */
  checkedAt: string | null;
  /** A mistake was found; `null` with `checkedAt` set = it was correct */
  errorFoundAt: string | null;
  /** The mistake was fixed */
  fixedAt: string | null;
  uploadedAt: string | null;
  liveAt: string | null;
  liveAsin: string | null;
}

export interface MyTarget {
  id: number;
  asin: string;
  url: string;
  jobNumber: number | null;
  assignedAt: string | null;
  /** The file was opened: "work in progress" on screen */
  startedAt: string | null;
  /**
   * Finished today.
   *
   * Careful: `null` = still in hand. This field decides which section of the
   * screen the row goes in and whether the Undo button appears.
   *
   * Nothing outside today ever appears here (see `mine()`), so a value means
   * "finished today, can still be undone".
   */
  completedAt: string | null;
}

/**
 * Design targets: submission, distribution and completion.
 *
 * Researchers submit about 500 Amazon URLs a day; distribution is random in
 * the morning; each designer takes one at a time and works on it.
 */
@Injectable()
export class TargetsService {
  private readonly logger = new Logger(TargetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly trace: FileTraceService,
  ) {}

  /**
   * Who can view and submit targets: owner, manager, researcher.
   *
   * Reading and writing share one guard, on purpose: the full list shows where
   * the whole team's work stands, which is not for a designer to see. A
   * designer sees their own 30 in `/me/targets`.
   *
   * ### What this used to say, and why it is no longer true
   *
   * The old note said: "A researcher cannot be blocked with `@Roles()`: the
   * portal has three roles (owner, manager, employee), and researchers log in
   * as `employee`." So permission had to be inferred from `staff_type` in
   * another table, costing one database call per request.
   *
   * Then the owner removed that foundation: researchers and designers do
   * different work, so their access should differ too. `UserRole` now has
   * `researcher`, so the question is no longer split across two tables.
   *
   * Three results, all gains:
   *   - the database call is gone: the function is now synchronous
   *   - the sidebar hack of `roles: [...] + when: canAddTargets` is gone
   *   - permission is in one place; the split across two tables is what made
   *     the 24 August mess possible (ADR-038)
   *
   * The old note also feared that "if the type goes into the token, an old
   * token keeps the old permission after the owner changes the type". That no
   * longer applies either: `JwtAuthGuard` re-reads the role from the database
   * every 5 minutes (see the note there). Changing a role does not require
   * logging anyone out.
   */
  assertCanUse(actor: SessionUser): void {
    if (canUseTargets(actor.role)) return;

    throw new ForbiddenException(
      'Only researchers, managers and the owner can add design targets.',
    );
  }

  /**
   * Who can check spelling: owner, manager, researcher.
   *
   * ### This function changed twice in one day, and the history is useful
   *
   * Morning: the owner wanted this access for the manager and one named
   * proofreader. It was then based on the `employees.can_proofread` checkbox,
   * i.e. per person.
   *
   * Later: the owner said all researchers get this access, because researchers
   * and designers do different work. So the question was never "which person"
   * but "which kind of work". The checkbox was removed and the role now
   * carries the right.
   *
   * Careful: today the formula is identical to `assertCanUse`, yet the two
   * functions stay separate, on purpose and following this code base's rule
   * (the same reason `mayOpenSettings` in `App.tsx` is not `isOwner ||
   * isManager`). With a named condition, changing one later does not mean
   * hunting for the other. Matching is not the same as being equal.
   */
  assertCanProofread(actor: SessionUser): void {
    if (canUseTargets(actor.role)) return;

    throw new ForbiddenException(
      'Only researchers, managers and the owner can check spelling.',
    );
  }

  /**
   * Up to 500 URLs at once.
   *
   * Careful: duplicates are filtered at two levels: inside the paste
   * (`parseBulk`) and against the database (`skipDuplicates`). Without the
   * second, `createMany` would cancel the whole batch, so one old ASIN among
   * 500 would stop the researcher's whole day of work from being submitted.
   *
   * Careful: how many were really inserted comes from the `count` of
   * `createMany`, not from a guess. Saying "500 submitted" when 437 went in
   * would be a silent lie.
   */
  async bulkAdd(actor: SessionUser, text: string, ip: string): Promise<BulkResult> {
    await this.assertCanUse(actor);

    const { accepted, rejected } = parseBulk(text);

    /**
     * The job number is assigned at submission time.
     *
     * It used to be assigned at allocation time, so rows never allocated would
     * not consume serials. But then a row sitting in the pool had no identity,
     * and the owner could not point at a row and say "this number". The serial
     * is a 4-byte int, so it lasts to 2 billion, not 39 thousand; the cost
     * was imaginary.
     *
     * `nextval` cannot be called through `createMany`, so this is a raw
     * insert, but `ON CONFLICT DO NOTHING` is kept; otherwise one old ASIN
     * among 500 would cancel the whole batch.
     */
    const created =
      accepted.length === 0
        ? { count: 0 }
        : {
            count: await this.prisma.$executeRaw`
              INSERT INTO design_targets (asin, added_by_id, job_number)
              SELECT a, ${actor.userId}, nextval('design_job_number_seq')
              FROM unnest(${accepted.map((t) => t.asin)}::text[]) AS a
              ON CONFLICT (asin) DO NOTHING
            `,
          };

    const poolSize = await this.prisma.designTarget.count({
      where: { status: DesignTargetStatus.pool },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'design_targets',
      targetId: 'bulk',
      ipAddress: ip,
      // The ASINs do not go into the audit log: five hundred ids in the log
      // help nobody, and the list is in the table anyway
      meta: {
        added: created.count,
        rejected: rejected.length,
        pasted: accepted.length + rejected.length,
      },
    });

    return {
      added: created.count,
      alreadyKnown: accepted.length - created.count,
      // Trimmed here, not in `parseBulk()`: that function's job is to tell the
      // truth, not to suit the screen. The ceiling sits at the border (the
      // audit log still gets the full count).
      rejected: rejected.slice(0, REJECTED_SHOWN),
      rejectedTotal: rejected.length,
      poolSize,
    };
  }

  /**
   * The daily distribution: random, but fair.
   *
   * Careful: the pick is random in the database itself (`ORDER BY random()`),
   * not in memory. The whole pool (thousands of rows) could be pulled and
   * shuffled in JavaScript, but as the pool grows that would be a pointless
   * load every morning.
   *
   * Careful: claiming happens in one transaction, as an update with the
   * `status = 'pool'` condition. If two runs overlapped (the owner pressing
   * the button while the job runs), the same target would land in two hands.
   * That condition is the real guard.
   *
   * Never throws: if distribution fails it is tried again tomorrow, and that
   * is no reason for the server to go down.
   */
  async distribute(now: Date = new Date()): Promise<{ assigned: number }> {
    let assigned = 0;

    try {
      const designers = await this.prisma.employee.findMany({
        // Who receives is written in one place, with the reason, in the note
        // on `DESIGN_WORK_STAFF_TYPES` (managers design too)
        where: {
          status: 'active',
          staffType: { in: [...DESIGN_WORK_STAFF_TYPES] },
        },
        select: { id: true, empCode: true },
        // By staff code: when the pool is short, who goes first must be
        // predictable. If it were random, a different person would miss out
        // each day and nobody could say why. (The pick is random, not the order.)
        orderBy: { empCode: 'asc' },
      });
      if (designers.length === 0) return { assigned: 0 };

      const open = await this.prisma.designTarget.groupBy({
        by: ['assignedToId'],
        where: {
          status: DesignTargetStatus.assigned,
          assignedToId: { in: designers.map((d) => d.id) },
        },
        _count: { _all: true },
      });
      const openBy = new Map(open.map((o) => [o.assignedToId, o._count._all]));

      const poolSize = await this.prisma.designTarget.count({
        where: { status: DesignTargetStatus.pool },
      });

      const sizes = allocationSizes(
        designers.map((d) => ({
          employeeId: d.id,
          openCount: openBy.get(d.id) ?? 0,
        })),
        poolSize,
      );

      for (const [employeeId, size] of sizes) {
        assigned += await this.claimFor(employeeId, size, now);
      }

      if (assigned > 0) {
        this.logger.log(
          `Design targets distributed · ${assigned} to ${sizes.size} designers`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Could not distribute design targets: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return { assigned };
  }

  /**
   * Claims `size` targets from the pool for one person.
   *
   * Careful: the `WHERE status = 'pool'` condition is inside the update, so
   * even if two runs overlap, one row cannot land in two hands.
   *
   * The job number is assigned here, at allocation; targets left in the pool
   * have none. Otherwise about a thousand never-allocated targets would eat
   * serials.
   */
  private async claimFor(
    employeeId: number,
    size: number,
    now: Date,
  ): Promise<number> {
    const picked = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM design_targets
      WHERE status = 'pool'
      ORDER BY random()
      LIMIT ${size}
      FOR UPDATE SKIP LOCKED
    `;
    if (picked.length === 0) return 0;

    let count = 0;

    for (const row of picked) {
      const done = await this.prisma.$executeRaw`
        UPDATE design_targets
        SET status = 'assigned',
            assigned_to_id = ${employeeId},
            assigned_at = ${now},
            -- ⚠️⚠️ COALESCE — a target that **came back from the pool**
            --    already has a number, and the number belongs to the ASIN,
            --    not to the assignment. Assigning a new one would burn
            --    serial numbers for nothing, and the old file names would
            --    never match anything.
            job_number = COALESCE(job_number, nextval('design_job_number_seq'))
        WHERE id = ${row.id} AND status = 'pool'
      `;
      count += done;
    }

    return count;
  }

  /**
   * End of day: return untouched targets to the pool.
   *
   * If someone was given 30 and did 15, the other 15 go back to the pool and
   * are handed out again later. So no target gets stuck in anyone's hand, and
   * the pool always shows the work that is really left.
   *
   * Careful: anything touched today is not returned, and this is the most
   * important condition here. If someone opened a design and started work but
   * could not finish it today, the simple rule would send it back too, and it
   * would land in someone else's hands tomorrow. Two people's effort wasted,
   * and nobody would understand why. "Touched" means the file was opened,
   * i.e. the number is in today's `design_credits`, the same signal used to
   * detect "done".
   *
   * Careful: the job number is not cleared. The number belongs to the ASIN,
   * not to the allocation: once set, it stays forever. Clearing it would (a)
   * burn serials for nothing and (b) leave old file names matching nothing.
   *
   * Never throws.
   */
  async returnUnworked(workDate: Date): Promise<{ returned: number }> {
    try {
      /**
       * Numbers seen in someone's file today, per staff member.
       * `design_credits.design_id` is text and `job_number` is a number, so
       * the match is done as text (the number's form is the same, `1000042`).
       */
      const touched = await this.prisma.designCredit.findMany({
        where: { firstWorkDate: workDate },
        select: { employeeId: true, designId: true },
      });

      const keep = new Set(touched.map((t) => `${t.employeeId}:${t.designId}`));

      const open = await this.prisma.designTarget.findMany({
        where: { status: DesignTargetStatus.assigned },
        select: { id: true, assignedToId: true, jobNumber: true, startedAt: true },
      });

      const ids = open
        // Careful: started targets are not returned. A set `startedAt` means
        // the file was opened some day, i.e. work is in progress. Checking only
        // today's credit was narrower: work running for three days would be
        // returned on the one day nobody opened the file.
        .filter((t) => t.startedAt === null)
        .filter((t) => !keep.has(`${t.assignedToId}:${t.jobNumber}`))
        .map((t) => t.id);
      if (ids.length === 0) return { returned: 0 };

      const { count } = await this.prisma.designTarget.updateMany({
        // The `status` condition is here too, so that if someone finishes in
        // the meantime, their work does not go back to the pool
        where: { id: { in: ids }, status: DesignTargetStatus.assigned },
        data: { status: DesignTargetStatus.pool, assignedToId: null, assignedAt: null },
      });

      if (count > 0) this.logger.log(`Design targets returned to the pool · ${count}`);

      return { returned: count };
    } catch (err) {
      this.logger.error(
        `Could not return targets: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { returned: 0 };
    }
  }

  /**
   * The designer's own list: what is in hand, and what was finished today.
   *
   * ### Why today's finished ones are included
   *
   * The owner reported that if someone presses Complete by mistake they
   * cannot undo it. The cause was here: the condition was only `assigned`, so
   * the moment Complete was pressed the row vanished from the screen. There
   * was no Undo button to press, because the row was not even visible.
   *
   * Careful: it goes no further than today. Undoing yesterday's Complete would
   * change yesterday's numbers too, and someone could move work from a bad day
   * to a good one. The owner can undo older ones.
   *
   * Careful: "today" means the Dhaka day, counted exactly as reports count it.
   */
  async mine(employeeId: number): Promise<MyTarget[]> {
    const rows = await this.prisma.designTarget.findMany({
      where: {
        assignedToId: employeeId,
        OR: [
          { status: DesignTargetStatus.assigned },
          {
            status: DesignTargetStatus.done,
            completedAt: { gte: workStart(workDateStr(new Date())) },
          },
        ],
      },
      select: {
        id: true,
        asin: true,
        jobNumber: true,
        assignedAt: true,
        startedAt: true,
        completedAt: true,
      },
      // Earlier first: otherwise old targets would sink to the bottom for good
      // and nobody would pick them up
      orderBy: { assignedAt: 'asc' },
    });

    return rows.map((r) => ({
      id: r.id,
      asin: r.asin,
      url: amazonUrl(r.asin),
      jobNumber: r.jobNumber,
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
   * `completedAt` (`to_check`, `to_upload`), not on `status`, so changing only
   * the status would show the row "in hand" while it still sat in the upload
   * queue. The return-to-pool branch clears exactly these three too.
   *
   * But `assignedToId`/`assignedAt`/`startedAt` are not touched: the work stays
   * with whoever had it. Clearing them would send the row back to the pool, and
   * a designer correcting their own mistake would lose the work.
   */
  private async clearCompletion(
    where: Prisma.DesignTargetWhereInput,
    by: { userId: number; ip: string | null },
  ): Promise<number> {
    /**
     * Careful: the row is read before clearing, and that is the real point.
     * `completed_at`, `completed_via` and `completed_by_id` are all about to
     * become `null`, so the proof that the work was ever finished disappears
     * from the row. Reading afterwards would find nothing.
     */
    const before = await this.prisma.designTarget.findFirst({
      where,
      select: {
        id: true,
        asin: true,
        jobNumber: true,
        assignedToId: true,
        completedAt: true,
        completedVia: true,
        completedById: true,
      },
    });
    if (before === null) return 0;

    const { count } = await this.prisma.designTarget.updateMany({
      where,
      data: {
        status: DesignTargetStatus.assigned,
        completedAt: null,
        completedVia: null,
        completedById: null,
      },
    });
    if (count === 0) return 0;

    /**
     * This is the only clearing action that leaves no trace of its own, so the
     * log is the only place. (Added after the owner asked whether designers
     * should have this access.)
     *
     * The real problem with that question was not the right itself but having
     * no way to verify. With a log, the question drops from "do we trust them"
     * to "we can check if needed".
     */
    await this.audit.record({
      userId: by.userId,
      action: 'design_undone',
      targetType: 'design_target',
      targetId: before.id,
      ipAddress: by.ip ?? undefined,
      meta: {
        asin: before.asin,
        jobNumber: before.jobNumber,
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
   * The designer's own Undo: today's, their own, and not yet moved along.
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
        status: DesignTargetStatus.done,
        completedAt: { gte: workStart(workDateStr(now)) },
        // A row that moved along the chain cannot be undone: once someone has
        // checked the spelling or sent it to Amazon, it is no longer "pressed by mistake"
        checkedAt: null,
        uploadedAt: null,
        liveAt: null,
      },
      by,
    );
    if (count > 0) return { ok: true };

    const row = await this.prisma.designTarget.findUnique({
      where: { id },
      select: {
        assignedToId: true,
        status: true,
        completedAt: true,
        checkedAt: true,
        uploadedAt: true,
        liveAt: true,
      },
    });

    if (!row || row.assignedToId !== employeeId) {
      throw new ForbiddenException('That design is not on your list.');
    }
    if (row.status !== DesignTargetStatus.done || row.completedAt === null) {
      // Pressing twice lands here, and that is not a failure
      return { ok: true };
    }
    if (row.checkedAt !== null || row.uploadedAt !== null || row.liveAt !== null) {
      throw new ConflictException(
        'This design has already moved on — someone has checked it or sent it to Amazon. Ask the owner to undo it.',
      );
    }
    throw new ConflictException(
      "You can only undo today's work. Ask the owner to undo an older one.",
    );
  }

  /**
   * Undo for owner and manager: any day, anyone's.
   *
   * No day limit, since correcting old mistakes is its only job. But a row
   * that moved along the chain cannot be undone here either: undoing it would
   * make the spelling queue and the upload counts wrong together.
   */
  async undoComplete(
    id: number,
    by: { userId: number; ip: string | null },
  ): Promise<{ ok: boolean }> {
    const count = await this.clearCompletion(
      {
        id,
        status: DesignTargetStatus.done,
        checkedAt: null,
        uploadedAt: null,
        liveAt: null,
      },
      by,
    );
    if (count > 0) return { ok: true };

    const row = await this.prisma.designTarget.findUnique({
      where: { id },
      select: { status: true, checkedAt: true, uploadedAt: true, liveAt: true },
    });
    if (!row) throw new NotFoundException('Design target not found');
    if (row.status !== DesignTargetStatus.done) return { ok: true };

    throw new ConflictException(
      'This design has already been checked or sent to Amazon — undo those steps first.',
    );
  }

  /**
   * "I dropped this".
   *
   * Careful: the condition includes `assignedToId`: nobody can touch a target
   * that is not theirs. This closes the path of guessing ids to change
   * someone else's row.
   */
  async skip(
    employeeId: number,
    id: number,
    reason: DropReason,
    now: Date = new Date(),
  ): Promise<{ ok: boolean }> {
    const { count } = await this.prisma.designTarget.updateMany({
      where: { id, assignedToId: employeeId, status: DesignTargetStatus.assigned },
      // Careful: the reason is now mandatory. While it was optional the screen
      // never sent one, and none of the 93 skipped rows had a reason. The
      // field is `dropReason` because Delete writes here too.
      data: { status: DesignTargetStatus.skipped, dropReason: reason },
    });

    // Dropping also empties the hand, so top up here too (owner's rule: "complete + skip")
    if (count > 0) await this.topUp(employeeId, now);

    return { ok: count > 0 };
  }

  /**
   * "I finished": a manual mark.
   *
   * Careful: `completedVia: 'manual'` is stored so it can later be told which
   * were detected by the system and which were declared by hand. The count is
   * the same, but the trust is not.
   */
  async markDone(
    employeeId: number,
    id: number,
    userId: number,
    now: Date = new Date(),
  ): Promise<{ ok: boolean }> {
    /**
     * The daily limit (owner's rule): the cap is the person's own daily target
     * ([`dailyCompletionCap`]).
     *
     * Careful: this applies only on this path, i.e. where the designer
     * presses the button (`POST /me/targets/:id/done`). The owner's and
     * manager's `update()` path is untouched; otherwise the way to correct
     * mistakes would be closed.
     */
    // Serialize completion decisions per employee across API instances.
    // Transaction locks are released on commit/rollback; namespace differs from clock drift.
    const count = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(260926, ${employeeId}::int)::text AS locked`;
      const cap = await this.capFor(employeeId, tx);
      if (cap !== null) {
        const doneToday = await this.completedToday(employeeId, now, tx);
        if (doneToday >= cap) {
          throw new ConflictException(
            `You have already marked ${cap} designs done today, so this one ` +
              `cannot be marked done — leave it in your list and finish it tomorrow.`,
          );
        }
      }
      const result = await tx.designTarget.updateMany({
        where: { id, assignedToId: employeeId, status: DesignTargetStatus.assigned },
        data: {
          status: DesignTargetStatus.done,
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
   * Checks every designer's hand and gives more only to those who need it.
   *
   * Careful: running right after an event is not enough. `topUp()` is called
   * after a completion or skip, so something must already be in hand. Someone
   * with nothing in hand cannot press anything, yet they are exactly who the
   * owner meant ("they have no designs left to work on").
   *
   * This happens in the field: when the pool is short in the morning,
   * `allocationSizes` serves staff in code order and the last person gets
   * nothing. The same goes for someone who joins mid-day, or whose type was
   * set to `designer` that same day.
   *
   * `topUp()` is itself idempotent (it returns 0 if the hand is full), so
   * running it repeatedly is safe.
   */
  async topUpAll(now: Date = new Date()): Promise<void> {
    const designers = await this.prisma.employee.findMany({
      where: { status: 'active', staffType: { in: [...DESIGN_WORK_STAFF_TYPES] } },
      select: { id: true },
      orderBy: { empCode: 'asc' },
    });

    for (const d of designers) await this.topUp(d.id, now);
  }

  /**
   * This person's daily limit. `null` means no limit.
   *
   * The number comes from three places (the person's own field, then the
   * policy, then none), and that order is written once, in `designTargetOf()`.
   */
  private async capFor(
    employeeId: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<number | null> {
    const emp = await db.employee.findUnique({
      where: { id: employeeId },
      select: {
        staffType: true,
        dailyDesignTarget: true,
        policy: { select: { dailyDesignTarget: true } },
      },
    });
    if (emp === null) return null;

    return dailyCompletionCap(
      emp.staffType,
      emp.dailyDesignTarget,
      emp.policy?.dailyDesignTarget,
    );
  }

  /**
   * How many were marked done in today's Dhaka day.
   *
   * Careful: the boundaries come from `localMidnightOf`/`nextLocalMidnight`,
   * not computed by hand. `workDateOf()` is a label, not an instant; using it
   * directly would start the day at 06:00 Dhaka, and this repo has made
   * exactly that mistake most often.
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
    return db.designTarget.count({
      where: {
        assignedToId: employeeId,
        completedAt: { gte: localMidnightOf(now), lt: nextLocalMidnight(now) },
      },
    });
  }

  /**
   * Gives more when the hand is not full enough (owner's rule), right after a
   * completion or skip.
   *
   * Careful: never throws. Top-up is a convenience; if it fails, the
   * designer's press of "I finished" must not fail.
   *
   * It runs immediately on the event, not waiting for a tick; otherwise
   * someone with an empty hand would sit idle for ten minutes. It uses the
   * same machinery as the morning distribution (`claimFor`), so the rule for
   * taking from the pool stays in one place.
   */
  private async topUp(employeeId: number, now: Date): Promise<void> {
    try {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: {
          staffType: true,
          dailyDesignTarget: true,
          policy: { select: { dailyDesignTarget: true } },
        },
      });
      // Nothing for someone without a target (the manager): the morning
      // distribution is enough, and there is no number for them to reach
      if (emp === null || !hasDesignTarget(emp.staffType)) return;

      const [completedToday, openCount, issuedToday] = await Promise.all([
        this.completedToday(employeeId, now),
        this.prisma.designTarget.count({
          where: { assignedToId: employeeId, status: DesignTargetStatus.assigned },
        }),
        // The total issued today: the daily ceiling stands on this
        this.prisma.designTarget.count({
          where: {
            assignedToId: employeeId,
            assignedAt: { gte: localMidnightOf(now), lt: nextLocalMidnight(now) },
          },
        }),
      ]);

      const size = topUpSize({
        staffType: emp.staffType,
        completedToday,
        openCount,
        issuedToday,
        dailyTarget: designTargetOf(
          emp.dailyDesignTarget,
          emp.policy?.dailyDesignTarget,
        ),
      });
      if (size === 0) return;

      const given = await this.claimFor(employeeId, size, now);

      if (given > 0) {
        this.logger.log(
          `Design targets topped up · ${given} to employee ${employeeId} ` +
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
   * Detects "work started" from the file name.
   *
   * Careful: this used to be treated as "done", which was wrong (fixed on the
   * owner's question). The agent sees the number in the title when the file
   * comes to the front, i.e. at the moment work starts. Treating that as
   * "done" closed a target as soon as it was opened, and the designer could
   * not find it in the list the next day.
   *
   * The system now says only what it really knows: work has started. The
   * designer declares "done" themselves (`markDone`).
   *
   * The designer puts the assigned number in the file name
   * (`1000042-Funny Cat T-Shirt.ai`), and that number surfaces in
   * `design_credits`. Here it is matched to start the target.
   *
   * Careful: the condition includes `assignedToId`: one person's file cannot
   * close another's target. The number should never be with two people, but
   * "should not" and "cannot" are not the same thing.
   *
   * Never throws: this is a convenience, and it must not block the daily
   * summary.
   */
  async markStartedByJobNumbers(
    employeeId: number,
    /**
     * Number to the earliest instant that day the file was seen open.
     *
     * This used to be `numbers: string[]` plus a `now: Date`, and the caller
     * passed the work-day label in place of `now`. The label is UTC midnight,
     * i.e. 06:00 Dhaka, so every target's "work started" got that one instant:
     * 711 of 711 in the field, all the same time, and each before its own
     * `assigned_at` (distribution is at 08:00).
     *
     * The field is now a `Map`, so each number cannot be passed without its
     * own instant. A plain `Date` field would let someone pass the label again
     * with the compiler silent.
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
      /**
       * There used to be a single `updateMany`, because every time was the
       * same. Each now has its own time, so first look up which are still
       * unmarked: usually 0-4 a day. The other numbers cause no query at all.
       */
      const pending = await this.prisma.designTarget.findMany({
        where: {
          jobNumber: { in: [...at.keys()] },
          assignedToId: employeeId,
          status: DesignTargetStatus.assigned,
          // One already marked is not touched again; otherwise "when started"
          // would slide to today's date every day
          startedAt: null,
        },
        select: { id: true, jobNumber: true },
      });

      let count = 0;

      for (const row of pending) {
        const when = row.jobNumber === null ? undefined : at.get(row.jobNumber);
        if (when === undefined) continue;

        // The `startedAt: null` condition is here too: another run could set
        // the mark between the read above and this write
        const { count: n } = await this.prisma.designTarget.updateMany({
          where: { id: row.id, startedAt: null },
          data: { startedAt: when },
        });

        count += n;
      }

      return count;
    } catch (err) {
      this.logger.warn(
        `Could not mark targets started: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  /**
   * Shape of the search condition, spread into `where`.
   *
   * `OR` is optional: digits-only input searches both job number and ASIN,
   * otherwise only ASIN.
   */
  /**
   * The full list, with filters and paging.
   *
   * Careful: paging is mandatory, not optional. The table has more than 39
   * thousand rows; sending all of them would make the response several MB and
   * the browser would freeze drawing it.
   *
   * `q` matches an ASIN or a job number, both. The job number is printed under
   * every row on screen, yet could not be searched; the ASIN was the only
   * identity.
   *
   * Careful: searching by URL no longer works. `asinOf()` used to extract the
   * ASIN from a link, but the owner asked for that to be removed. So the
   * screen says so directly when a link is pasted; otherwise the result would
   * be a silent empty list, the failure this app likes least.
   */
  async list(query: {
    status?: DesignTargetStatus;
    q?: string;
    page?: number;
    /** Which designer: `employees.id` */
    staffId?: number;
    /**
     * Who brought them in: `users.id`.
     *
     * Careful: a different id space from `staffId` (that is `employees`, this
     * is `users`). Putting one's number into the other would quietly return
     * the wrong person's rows: no error, just a wrong answer.
     */
    addedById?: number;
    /** 'YYYY-MM-DD': date of the last activity, from this day */
    from?: string;
    /** 'YYYY-MM-DD': up to and including this day */
    to?: string;
    /** Which step of the chain it is stuck on: the researcher's queue */
    /** `no_file` is not a step but a question */
    stage?:
      | 'to_check'
      | 'to_fix'
      | 'to_upload'
      | 'to_live'
      | 'to_review'
      | 'no_file';
  }): Promise<{
    rows: TargetRow[];
    total: number;
    page: number;
    pages: number;
    /** Since which day titles have been stored; explains why `fileSec === null` */
    traceSince: string | null;
  }> {
    const page = Math.max(1, query.page ?? 1);

    /**
     * ASIN or job number: the difference in one line: digits only means job
     * number, otherwise ASIN.
     *
     * Even so, digits search both (`OR`). Some ASINs are entirely numeric
     * (old ISBN style), and searching only by job number would never find that
     * row, silently.
     *
     * Careful: the range is checked before `Number()`. `job_number` is an
     * `Int`, so anything above 2,147,483,647 would make Prisma throw and the
     * search return 500, when the user merely typed a long number.
     */
    const INT32_MAX = 2_147_483_647;
    let match: TargetSearchMatch | undefined;

    const term = query.q?.trim().toUpperCase();
    if (term) {
      const digits = /^\d+$/.test(term);
      const jobNumber = digits ? Number(term) : NaN;

      match =
        digits && Number.isSafeInteger(jobNumber) && jobNumber <= INT32_MAX
          ? { OR: [{ jobNumber }, { asin: { contains: term } }] }
          : { asin: { contains: term } };
    }

    /**
     * The date applies to `lastActivityAt`, i.e. "the last thing that
     * happened".
     *
     * Careful: a different field per status was deliberately not used
     * (completedAt if done, assignedAt if assigned). That would change "which
     * date is being filtered" every time, and sorting and filtering would
     * stand on different bases.
     *
     * With one basis the result is naturally right: choosing `done` makes the
     * row's `lastActivityAt` its `completedAt`, since that is the latest.
     *
     * Careful: the day in `to` is inclusive. People saying "up to the 23rd"
     * mean the 23rd as well, so it looks up to the start of the next day (`lt`).
     */

    const activity =
      query.from || query.to
        ? {
            ...(query.from ? { gte: workStart(query.from) } : {}),
            ...(query.to ? { lt: nextDay(query.to) } : {}),
          }
        : undefined;

    /**
     * The researcher's two queues: exactly which step of the chain a row is
     * stuck on.
     *
     * `to_upload` has a cut-off date and `to_live` does not. The reason is
     * `UPLOAD_QUEUE_FROM` in [targets.rules.ts](./targets.rules.ts): without
     * excluding the old 27 thousand imported rows the queue would be a
     * mountain. `to_live` has no such problem, since only rows where Uploaded
     * was pressed qualify.
     */
    /**
     * Since which day titles have been stored. The right to say "no file
     * trace" begins only after this date.
     *
     * Called once per page. It is deliberately not a constant: if old rows are
     * ever trimmed, the boundary moves by itself and nobody has to remember.
     */
    const traceSince = await this.trace.since();
    const since = traceSince === null ? null : workStart(traceSince);

    /**
     * Only for this one step. Because the question is asked from
     * `design_targets`, the cost drops from 930 ms to 25 ms
     * ([`unseenJobNumbers`](./file-trace.service.ts)).
     */
    const noFileFrom =
      traceSince === null
        ? null
        : workStart(laterDay(UPLOAD_QUEUE_FROM, traceSince));

    const unseenJobs =
      query.stage === 'no_file' && noFileFrom !== null
        ? await this.trace.unseenJobNumbers(noFileFrom)
        : [];

    const stage =
      /**
       * Marked done, yet the file was never opened.
       *
       * Careful: this is not an alert, and that was the owner's condition: a
       * "silent list". There are many innocent explanations for no trace: the
       * file was not saved (in the field one person works all day in
       * `Untitled-20*`), the number was not put in front of the name, or the
       * work was done in another app. So the list is a question, not an
       * accusation.
       *
       * Careful: two limits apply together, each with its own reason:
       *   - `UPLOAD_QUEUE_FROM`: excludes the old 27 thousand imported rows
       *   - `traceSince`: before this we did not see titles at all
       * Whichever is later is used.
       */
      query.stage === 'no_file'
        ? noFileFrom === null
          ? // No titles stored at all: then there is no right to say anything about anyone
            { id: { in: [] as number[] } }
          : {
              completedAt: { not: null, gte: noFileFrom },
              jobNumber: { in: unseenJobs },
            }
        : query.stage === 'to_check'
        ? {
            completedAt: { not: null, gte: workStart(UPLOAD_QUEUE_FROM) },
            checkedAt: null,
          }
        : query.stage === 'to_fix'
          ? { errorFoundAt: { not: null }, fixedAt: null }
          : query.stage === 'to_upload'
            ? {
                completedAt: { not: null, gte: workStart(UPLOAD_QUEUE_FROM) },
                uploadedAt: null,
                /**
                 * Careful: rows where a mistake was found but not yet fixed are
                 * excluded (owner's decision). A known-broken design must not
                 * go to Amazon.
                 *
                 * Rows not yet checked are not blocked, though. Blocking them
                 * would drop today's queue of 132 to 0 overnight, and nobody
                 * would start.
                 */
                NOT: { errorFoundAt: { not: null }, fixedAt: null },
              }
            : query.stage === 'to_live'
              ? { uploadedAt: { not: null }, liveAt: null }
              : /**
                 * Dropped but nobody has looked.
                 *
                 * Careful: `dropReason: { not: null }` instead of a cut-off
                 * date is the only clever bit here. The old 93 `skipped` rows
                 * have no reason (asking for one began on 31 August), so there
                 * is nothing for the manager to review in them; they simply
                 * fall out. No date constant like `UPLOAD_QUEUE_FROM` was
                 * needed: the condition follows meaning, not the calendar, so
                 * nobody has to remember to change a date one day.
                 */
                query.stage === 'to_review'
                ? {
                    status: {
                      in: [
                        DesignTargetStatus.skipped,
                        DesignTargetStatus.deleted,
                      ],
                    },
                    dropReason: { not: null },
                    reviewedAt: null,
                  }
                : {};

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(match ?? {}),
      ...(query.staffId ? { assignedToId: query.staffId } : {}),
      ...(query.addedById ? { addedById: query.addedById } : {}),
      ...(activity ? { lastActivityAt: activity } : {}),
      ...stage,
    };

    const [total, rows] = await Promise.all([
      this.prisma.designTarget.count({ where }),
      this.prisma.designTarget.findMany({
        where,
        select: {
          id: true,
          asin: true,
          status: true,
          jobNumber: true,
          assignedAt: true,
          startedAt: true,
          completedAt: true,
          completedVia: true,
          checkedAt: true,
          errorFoundAt: true,
          fixedAt: true,
          uploadedAt: true,
          liveAt: true,
          liveAsin: true,
          sourceNote: true,
          dropReason: true,
          reviewedAt: true,
          reviewedBy: { select: { fullName: true, role: true } },
          assignedTo: { select: { empCode: true, fullName: true } },
          // Who said "done": the person assigned and the person who finished
          // may differ (the owner can press it too)
          completedBy: { select: { fullName: true, role: true } },
          /**
           * Who brought it in, with their role, since "a researcher brought
           * it" and "the owner brought it" are different news on screen.
           *
           * The relation already existed in the schema (`addedTargets`) and
           * was simply never selected, so no migration was needed.
           */
          addedBy: { select: { fullName: true, role: true } },
          addedAt: true,
        },
        /**
         * Latest activity first.
         *
         * Careful: this used to be `id desc`, i.e. when it was added, not when
         * the work happened. Among 31,311 `done` rows, a mistake made ten
         * minutes ago could be anywhere and could not be found.
         *
         * `id` is the second key so rows submitted at the same instant keep
         * the same order every time (otherwise paging could show the same row
         * twice or not at all).
         */
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * TARGET_PAGE_SIZE,
        take: TARGET_PAGE_SIZE,
      }),
    ]);

    /**
     * Only for the rows on screen: 50 numbers, 50 index lookups. The whole
     * table is never read.
     */
    const seconds = await this.trace.secondsFor(
      rows.map((r) => r.jobNumber).filter((n): n is number => n !== null),
    );

    return {
      traceSince,
      rows: rows.map((r) => ({
        id: r.id,
        asin: r.asin,
        url: amazonUrl(r.asin),
        status: r.status,
        jobNumber: r.jobNumber,
        assignedTo: r.assignedTo,
        assignedAt: r.assignedAt?.toISOString() ?? null,
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
        completedVia: r.completedVia,
        fileSec: fileSecOf(r, seconds, since),
        completedBy: r.completedBy,
        addedBy: r.addedBy,
        addedAt: r.addedAt.toISOString(),
        checkedAt: r.checkedAt?.toISOString() ?? null,
        errorFoundAt: r.errorFoundAt?.toISOString() ?? null,
        fixedAt: r.fixedAt?.toISOString() ?? null,
        uploadedAt: r.uploadedAt?.toISOString() ?? null,
        liveAt: r.liveAt?.toISOString() ?? null,
        liveAsin: r.liveAsin,
        sourceNote: r.sourceNote,
        dropReason: r.dropReason,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
        reviewedBy: r.reviewedBy,
      })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / TARGET_PAGE_SIZE)),
    };
  }

  /**
   * Edit the list: owner, manager, researcher.
   *
   * Careful: the ASIN cannot be changed, on purpose. It is the row's identity;
   * changing it would shake the whole basis of the duplicate guard, and "this
   * product was made" in the history would become false. For a wrong ASIN,
   * delete the row and submit it again.
   *
   * What can change is the status: return to the pool (taking it out of
   * someone's hand), mark done, or drop.
   */
  async update(
    id: number,
    status: DesignTargetStatus,
    now: Date,
    userId: number,
  ): Promise<{ ok: boolean }> {
    /**
     * Careful: returning to the pool also gives up ownership; otherwise the
     * row would sit in the pool yet stay tied to someone, and the next
     * distribution could put it in two hands.
     * The job number is not cleared: it belongs to the ASIN, not the allocation.
     */
    const data =
      status === DesignTargetStatus.pool
        ? {
            status,
            assignedToId: null,
            assignedAt: null,
            startedAt: null,
            completedAt: null,
            completedVia: null,
            // This must be cleared too; otherwise a row returned to the pool
            // would keep "who finished it" though the work is no longer done
            completedById: null,
            /**
             * Careful: the reason is cleared too. A row going back to the pool
             * means "Not Found" is no longer true: someone checked and the
             * page exists, or it was deleted by mistake. Keeping the reason
             * would show a later recipient a row marked "Copyright" that is
             * already settled.
             */
            dropReason: null,
            /**
             * Careful: the "reviewed" mark is cleared too. A row returning to
             * the pool is no longer dropped, so there is nothing left for the
             * manager's review to refer to. Keeping it would mean that if
             * someone Skips it again, the row would never reach the queue: an
             * old mark hiding a new problem.
             */
            reviewedAt: null,
            reviewedById: null,
            // A new assignment must pass through the workflow again.
            checkedAt: null,
            checkedById: null,
            errorFoundAt: null,
            fixedAt: null,
            fixedById: null,
            uploadedAt: null,
            liveAt: null,
            liveAsin: null,
          }
        : status === DesignTargetStatus.done
          ? { status, completedAt: now, completedVia: 'manual', completedById: userId }
          : { status };

    const { count } = await this.prisma.designTarget.updateMany({
      where: {
        id,
        // A retry must not move yesterday's completion into today's count.
        ...(status === DesignTargetStatus.done
          ? { status: { not: DesignTargetStatus.done } }
          : {}),
      },
      data,
    });
    if (count > 0) return { ok: true };
    if (status === DesignTargetStatus.done) {
      const existing = await this.prisma.designTarget.findUnique({
        where: { id }, select: { status: true },
      });
      return { ok: existing?.status === DesignTargetStatus.done };
    }
    return { ok: false };
  }

  /**
   * Delete: the row stays and is only marked dead.
   *
   * Careful: this used to be a real `DELETE`, and that was the bug. With the
   * row gone, the `asin` UNIQUE guard went too: if someone pasted that dead
   * ASIN again tomorrow it would enter as new work, go into distribution, and
   * a designer would again find "Sorry, not found". The old note had spelled
   * out the cost but had no alternative; the `deleted` status is now that
   * alternative.
   *
   * Careful: rows that are done are not touched. `done` means someone really
   * made the design; deleting it would lower their day's count and silently
   * drop it from the upload queue. If selected by mistake, `keptDone` tells
   * the screen what happened; it is not skipped silently.
   *
   * A row in hand (`assigned`) can be deleted, and that is the most useful
   * case: the designer only learns the page does not exist by opening the
   * link. `assignedToId` is not cleared (who held it is history), but the
   * status change moves the row off their list and out of their "30 in hand"
   * count, so the next distribution supplies a replacement by itself.
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

    // Eligibility belongs in the write: a designer may complete work while
    // this request is in flight. RETURNING also makes audit IDs match actual writes.
    const deleted = await this.prisma.designTarget.updateManyAndReturn({
      where: {
        id: { in: wanted },
        status: { notIn: [DesignTargetStatus.done, DesignTargetStatus.deleted] },
      },
      data: { status: DesignTargetStatus.deleted, dropReason: reason },
      select: { id: true },
    });
    const count = deleted.length;
    const keptDone = await this.prisma.designTarget.count({
      where: { id: { in: wanted }, status: DesignTargetStatus.done },
    });

    if (count > 0) {
      await this.audit.record({
        userId,
        action: 'design_deleted',
        targetType: 'design_targets',
        targetId: deleted.length === 1 ? String(deleted[0].id) : 'bulk',
        ipAddress: ip,
        // The counts, not the ASINs: the list is in the table (same rule as `bulkAdd`)
        meta: { deleted: count, keptDone, asked: wanted.length, reason },
      });
    }

    return { deleted: count, keptDone };
  }

  /** The pool's state, for the inbox screen */
  /**
   * The designer list for the filter dropdown.
   *
   * Careful: the ordinary staff-list route could not be used: it is
   * owner/manager only, yet researchers see this page too. So this is
   * separate, and only name and code go out, nothing like salary or phone.
   *
   * Staff who have left are included too: old targets are tied to their
   * names, and leaving them out of the filter would make those rows
   * unfindable.
   */
  async designers(): Promise<{ id: number; empCode: string; fullName: string }[]> {
    return this.prisma.employee.findMany({
      where: { designTargets: { some: {} } },
      select: { id: true, empCode: true, fullName: true },
      orderBy: { empCode: 'asc' },
    });
  }

  /**
   * How many targets each person has brought in.
   *
   * The number is shown in the dropdown itself, and that is the real answer:
   * the owner sees who brought how many without a single click. The filter
   * is the next step.
   *
   * Careful: unlike `designers()` this is `users`, not `employees`: targets
   * are brought in by users (owner, manager, researcher), and the owner has
   * no `employees` row at all. Going through that table would drop the
   * source of 39 thousand rows from the list.
   */
  async adders(): Promise<
    { id: number; fullName: string; role: UserRole; count: number }[]
  > {
    const grouped = await this.prisma.designTarget.groupBy({
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
      // Whoever brought the most is first; the list is short (3 people today)
      .sort((a, b) => b.count - a.count);
  }

  async stats(): Promise<
    Record<DesignTargetStatus, number> & {
      perDesigner: number;
      uploaded: number;
      live: number;
      /** Spelling check pending (ADR-038) */
      toCheck: number;
      /** A mistake was found and not yet fixed */
      toFix: number;
      /** The researcher's queue: done but not uploaded (after the cut-off date) */
      toUpload: number;
      /** Uploaded but not yet live */
      toLive: number;
    }
  > {
    /**
     * Uploaded and live are counted separately.
     *
     * Careful: `status` cannot count them, since those are dates, not states
     * (deliberate; see the note in the schema). One job can be `done` and
     * uploaded and live all at once, and that is correct.
     */
    const [rows, uploaded, live, toCheck, toFix, toUpload, toLive, toReview] =
      await Promise.all([
      this.prisma.designTarget.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.designTarget.count({ where: { uploadedAt: { not: null } } }),
      this.prisma.designTarget.count({ where: { liveAt: { not: null } } }),
      /**
       * Careful: these two numbers must be exact twins of the `list()`
       * filters. If a chip says 132 and clicking it shows 90, nobody will
       * trust the number again. The cut-off date is in one place
       * (`UPLOAD_QUEUE_FROM`), so both move together.
       */
      this.prisma.designTarget.count({
        where: {
          completedAt: { not: null, gte: workStart(UPLOAD_QUEUE_FROM) },
          checkedAt: null,
        },
      }),
      this.prisma.designTarget.count({
        where: { errorFoundAt: { not: null }, fixedAt: null },
      }),
      this.prisma.designTarget.count({
        where: {
          completedAt: { not: null, gte: workStart(UPLOAD_QUEUE_FROM) },
          uploadedAt: null,
          // Rows with a mistake found but not fixed are excluded: twin of `list()`
          NOT: { errorFoundAt: { not: null }, fixedAt: null },
        },
      }),
      this.prisma.designTarget.count({
        where: { uploadedAt: { not: null }, liveAt: null },
      }),
      // Twin of the `to_review` condition in `list()`: if the two differed, the
      // chip's number and the list's number would not match (the 24 August lesson)
      this.prisma.designTarget.count({
        where: {
          status: {
            in: [DesignTargetStatus.skipped, DesignTargetStatus.deleted],
          },
          dropReason: { not: null },
          reviewedAt: null,
        },
      }),
    ]);

    const out = {
      pool: 0,
      assigned: 0,
      done: 0,
      skipped: 0,
      /**
       * Dead ASIN: the page does not exist on Amazon.
       *
       * Careful: the zeros are written by hand here, on purpose: the type is
       * `Record<DesignTargetStatus, number>`, so when a new value is added to
       * the enum, the type check stops here. That is exactly what happened on
       * 29 August; otherwise the new status would have stayed out of the count
       * and nobody on screen would have noticed.
       */
      deleted: 0,
      perDesigner: POOL_PER_DESIGNER,
      uploaded,
      live,
      toCheck,
      toFix,
      toUpload,
      toLive,
      toReview,
    };
    for (const r of rows) out[r.status] = r._count._all;

    return out;
  }

  /**
   * "Uploaded": owner, manager, researcher.
   *
   * It cannot be uploaded before it is finished, so a missing `completedAt`
   * is rejected; otherwise the order of the pipeline would mean nothing.
   */
  /**
   * "Spelling checked" (ADR-038): the one method behind the proofreader's two
   * buttons.
   *
   * Careful: the machine does not read spelling. The text is inside the
   * `.ai`/`.psd` and the policy promises files are not opened. The machine
   * only keeps the books: which are still to check, who checked, what they
   * found. In the field the real problem is exactly this: not finding
   * mistakes, but knowing which ones to check.
   *
   * `ok: false` means a mistake was found: `errorFoundAt` is set too, and the
   * row goes into the "to fix" queue.
   *
   * Careful: idempotent. Pressing again does not move the date; otherwise
   * pressing twice on a row would make "when it was checked" jump to today.
   */
  async markChecked(
    id: number,
    ok: boolean,
    userId: number,
    now: Date,
  ): Promise<{ ok: true }> {
    const target = await this.prisma.designTarget.findUnique({
      where: { id },
      select: { completedAt: true, checkedAt: true },
    });
    if (!target) throw new NotFoundException('No design target with this id');
    if (target.completedAt === null) {
      throw new BadRequestException(
        'This design is not finished yet, so there is nothing to check.',
      );
    }
    if (target.checkedAt !== null) return { ok: true };

    await this.prisma.designTarget.update({
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
   * Careful: `assignedToId` is not touched. The design stays with the
   * original designer, and that is the most important line in this method:
   * otherwise the work would pass to whoever fixed it, and the whole 23 August
   * investigation began with exactly such an inflated number ("Belal made 16
   * designs?").
   */
  async markFixed(id: number, userId: number, now: Date): Promise<{ ok: true }> {
    const target = await this.prisma.designTarget.findUnique({
      where: { id },
      select: { errorFoundAt: true, fixedAt: true },
    });
    if (!target) throw new NotFoundException('No design target with this id');
    if (target.errorFoundAt === null) {
      throw new BadRequestException(
        'No spelling error was recorded for this design, so there is nothing to fix.',
      );
    }
    if (target.fixedAt !== null) return { ok: true };

    await this.prisma.designTarget.update({
      where: { id },
      data: { fixedAt: now, fixedById: userId },
    });
    return { ok: true };
  }

  /**
   * "Reviewed": the only way for the owner and manager to empty their queue.
   *
   * Careful: the row's status does not change; `skipped` stays `skipped`.
   * This is not a decision but an acknowledgement: "I have seen it". To
   * decide, the button beside it exists (return to the pool), and that is a
   * separate action.
   *
   * It works only on dropped rows that have a reason; otherwise any row could
   * be marked and the field would lose its meaning.
   */
  async markReviewed(
    id: number,
    userId: number,
    now: Date,
  ): Promise<{ ok: boolean }> {
    const { count } = await this.prisma.designTarget.updateMany({
      where: {
        id,
        status: { in: [DesignTargetStatus.skipped, DesignTargetStatus.deleted] },
        dropReason: { not: null },
      },
      data: { reviewedAt: now, reviewedById: userId },
    });

    return { ok: count > 0 };
  }

  async markUploaded(id: number, now: Date): Promise<{ ok: true }> {
    const target = await this.prisma.designTarget.findUnique({
      where: { id },
      select: { completedAt: true, uploadedAt: true },
    });
    if (!target) throw new NotFoundException('No design target with this id');
    if (target.completedAt === null) {
      throw new BadRequestException(
        'This design is not finished yet, so it cannot be marked uploaded.',
      );
    }
    // If already marked the date does not move; otherwise "when uploaded"
    // would jump to today's date every time
    if (target.uploadedAt !== null) return { ok: true };

    await this.prisma.designTarget.update({
      where: { id },
      data: { uploadedAt: now },
    });
    return { ok: true };
  }

  /**
   * "Live on Amazon", with the new product's ASIN.
   *
   * Careful: the ASIN is of our own product, not the sample the researcher
   * brought. It is the bridge to later join with sales figures.
   *
   * It cannot go live without being uploaded: to put anything on Amazon it
   * must first be sent.
   */
  async markLive(id: number, liveAsin: string | null, now: Date): Promise<{ ok: true }> {
    const target = await this.prisma.designTarget.findUnique({
      where: { id },
      select: { uploadedAt: true, liveAt: true },
    });
    if (!target) throw new NotFoundException('No design target with this id');
    if (target.uploadedAt === null) {
      throw new BadRequestException(
        'This design has not been uploaded yet, so it cannot be live.',
      );
    }
    if (target.liveAt !== null) return { ok: true };

    await this.prisma.designTarget.update({
      where: { id },
      data: { liveAt: now, liveAsin },
    });
    return { ok: true };
  }
}
