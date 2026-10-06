import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { workDateOf } from '../agent/util/dhaka-time';
import { parseCalendarDate } from '../calendar/calendar-date';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { SummaryService } from '../summary/summary.service';
import {
  ADJUSTMENT_MAX_SEC,
  type CreateAdjustmentDto,
  type RevokeAdjustmentDto,
} from './adjustments.dto';

/**
 * Staff also see their own adjustments (J08), so there is no internal
 * information here: only what, how much, why, and who.
 */
export interface AdjustmentView {
  id: string;
  employeeId: number;
  workDate: string;
  deltaSec: number;
  cause: string;
  reason: string;
  beyondEvidence: boolean;
  createdAt: string;
  createdBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  /** Whether it still counts; a revoked adjustment does not. */
  active: boolean;
}

/**
 * **B14 · G35 · ADR-011e** - giving back hours lost through a system fault.
 *
 * Careful: this module **did not exist** for a long time, although the read side
 * was fully built: `progress.service` (the tray number), `summary.service`
 * (rollup), `payroll.math` (`credited = worked + adjustment`) and `reports` all
 * read `time_adjustments`. Nobody ever wrote a single row, so the sum stayed 0
 * forever. The result: the owner could not give back hours lost through a
 * system fault, and nothing showed an error.
 *
 * **Raw segments are never touched.** An adjustment is a separate row, so "what
 * the machine saw" and "what a person corrected" stay separate forever.
 * Editing segments would make them unauditable.
 */
@Injectable()
export class AdjustmentsService {
  private readonly logger = new Logger(AdjustmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly summary: SummaryService,
  ) {}

  async create(
    actor: SessionUser,
    employeeId: number,
    dto: CreateAdjustmentDto,
    ip: string,
  ): Promise<AdjustmentView> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, empCode: true },
    });
    if (!employee) throw new NotFoundException('Staff member not found');

    if (dto.deltaSec === 0) {
      throw new BadRequestException('deltaSec cannot be zero');
    }

    if (Math.abs(dto.deltaSec) > ADJUSTMENT_MAX_SEC) {
      throw new BadRequestException(
        `deltaSec must be within ±${ADJUSTMENT_MAX_SEC} seconds (24 hours) for a single day`,
      );
    }

    const workDate = parseCalendarDate(dto.workDate);
    if (!workDate) throw new BadRequestException('workDate is not a valid date');

    // Careful: hours cannot be given back for a future day; a day that has not
    // come yet has no "lost hours".
    if (workDate.getTime() > workDateOf(new Date()).getTime()) {
      throw new BadRequestException('workDate cannot be in the future');
    }

    // R1 - if the month is closed, stop here, before anything is written to the DB.
    await this.assertMonthOpen(workDate);

    // Check the proof alert really exists; a wrong id would break the FK and give a 500.
    if (dto.evidenceAlertId !== undefined) {
      const alert = await this.prisma.alert.findUnique({
        where: { id: BigInt(dto.evidenceAlertId) },
        select: { id: true },
      });
      if (!alert) throw new BadRequestException('evidenceAlertId not found');
    }

    const row = await this.prisma.timeAdjustment.create({
      data: {
        employeeId,
        workDate,
        deltaSec: dto.deltaSec,
        cause: dto.cause,
        reason: dto.reason.trim(),
        evidenceAlertId:
          dto.evidenceAlertId === undefined
            ? null
            : BigInt(dto.evidenceAlertId),
        beyondEvidence: dto.beyondEvidence ?? false,
        createdById: actor.userId,
      },
      include: SELECT_PEOPLE,
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'time_adjustment',
      targetType: 'employee',
      targetId: employeeId,
      ipAddress: ip,
      meta: {
        adjustmentId: String(row.id),
        empCode: employee.empCode,
        workDate: dto.workDate,
        deltaSec: dto.deltaSec,
        cause: dto.cause,
        reason: dto.reason.trim(),
        beyondEvidence: dto.beyondEvidence ?? false,
      },
    });

    await this.refresh(workDate, employee.id);

    this.logger.log(
      `${employee.empCode} ${dto.workDate}: ${dto.deltaSec > 0 ? '+' : ''}${dto.deltaSec}s (${dto.cause})`,
    );

    return toView(row);
  }

  /**
   * Careful: **revoke, not delete**; the schema deliberately has no delete.
   * "The adjustment existed and was later revoked" and "it never existed" are
   * two completely different histories, especially if that month's pay has
   * already been paid.
   */
  async revoke(
    actor: SessionUser,
    id: bigint,
    dto: RevokeAdjustmentDto,
    ip: string,
  ): Promise<AdjustmentView> {
    const before = await this.prisma.timeAdjustment.findUnique({
      where: { id },
      select: {
        id: true,
        employeeId: true,
        workDate: true,
        deltaSec: true,
        revokedAt: true,
        employee: { select: { empCode: true } },
      },
    });
    if (!before) throw new NotFoundException('Adjustment not found');

    // R1 - a revoke also moves the month's sum, so the same guard applies here.
    await this.assertMonthOpen(before.workDate);

    // Careful: on a second revoke, the second reason would overwrite the first.
    if (before.revokedAt) {
      throw new BadRequestException('This adjustment is already revoked');
    }

    const row = await this.prisma.timeAdjustment.update({
      where: { id },
      data: {
        revokedAt: new Date(),
        revokedById: actor.userId,
        revokeReason: dto.reason.trim(),
      },
      include: SELECT_PEOPLE,
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'time_adjustment_revoke',
      targetType: 'employee',
      targetId: before.employeeId,
      ipAddress: ip,
      meta: {
        adjustmentId: String(id),
        empCode: before.employee.empCode,
        workDate: before.workDate.toISOString().slice(0, 10),
        deltaSec: before.deltaSec,
        reason: dto.reason.trim(),
      },
    });

    await this.refresh(before.workDate, before.employeeId);

    return toView(row);
  }

  /**
   * J08 - staff can see **their own** adjustments, with the reason.
   *
   * This is the condition of ADR-011e: giving back hours is not a secret
   * mechanism. Staff must be able to know why the number their pay is based on
   * changed.
   */
  async list(actor: SessionUser, employeeId: number): Promise<AdjustmentView[]> {
    this.assertCanSee(actor, employeeId);

    const rows = await this.prisma.timeAdjustment.findMany({
      where: { employeeId },
      orderBy: [{ workDate: 'desc' }, { id: 'desc' }],
      include: SELECT_PEOPLE,
    });

    return rows.map(toView);
  }

  /**
   * Careful: for staff the id comes **from the session**, not from the path,
   * and a request for someone else's id is not silently answered with their own
   * (same as `resolveEmployeeScope` in `screenshots.service`). Swapping it
   * silently would show their own data under another person's name.
   */
  private assertCanSee(actor: SessionUser, employeeId: number): void {
    /**
     * Careful: like `resolveEmployeeScope` in `screenshots.service`, the
     * condition is an **allow-list**. It used to read `role !== employee`, and
     * when the `researcher` role was added we found that any new role would
     * **skip this guard entirely**, opening anyone's pay adjustments.
     * Careful: the controller has no `@Roles` here either (deliberately), so
     * this is the only guard.
     */
    if (actor.role === UserRole.owner || actor.role === UserRole.manager) return;

    if (actor.employeeId === null) {
      throw new ForbiddenException(
        'This account is not linked to any staff member',
      );
    }

    if (actor.employeeId !== employeeId) {
      throw new ForbiddenException('You can only view your own adjustments');
    }
  }

  /**
   * After an adjustment, that day's summary is recomputed **immediately**.
   *
   * Careful: without it, the tray number would change right away
   * (progress.service reads raw `time_adjustments`) but reports and the heatmap
   * would stay 15 minutes stale, so the owner would give back hours, open the
   * report, see nothing changed and think it had not worked.
   *
   * On failure it only logs: the adjustment is already in the DB, and the next
   * regular rollup (K06, every 15 minutes) will fix it anyway.
   */
  /**
   * **R1 - hours cannot move in a closed month.**
   *
   * Careful: it must be called in both places, **for a new adjustment and for a
   * revoke**. The revoke is easy to forget, but it moves the month's sum just as
   * much: the hours that were added go back out. A guard only on `create` would
   * leave the door half closed, which is worse than an open door because
   * everyone would think it was shut.
   *
   * Careful: 409 (Conflict), not 403. The user has the **right** to do this, but
   * the **state** of the thing does not allow it now. A 403 would make the owner
   * think their role had been reduced.
   */
  private async assertMonthOpen(workDate: Date): Promise<void> {
    const yearMonth = workDate.toISOString().slice(0, 7);
    const closed = await this.prisma.monthClosure.findUnique({
      where: { yearMonth },
      select: { closedAt: true, closedBy: true },
    });
    if (!closed) return;

    throw new ConflictException(
      `${yearMonth} was closed on ${closed.closedAt.toISOString().slice(0, 10)} by ${closed.closedBy}. ` +
        'Payroll for that month is already fixed — reopen it first if this correction is genuinely needed.',
    );
  }

  /**
   * Careful: **`employeeId` is passed separately, and that is the whole point
   * of this method.** The rollup runs only for **active** staff, so an inactive
   * person's adjustment would be stored but never reach `daily_summary`: it
   * would show on screen, pay would not change, and no error would appear.
   */
  private async refresh(workDate: Date, employeeId: number): Promise<void> {
    try {
      await this.summary.refreshDate(workDate, undefined, [employeeId]);
    } catch (err) {
      this.logger.warn(
        `Could not refresh the summary for ${workDate.toISOString().slice(0, 10)} — the next rollup will: ${String(err)}`,
      );
    }
  }
}

const SELECT_PEOPLE = {
  createdBy: { select: { fullName: true, email: true } },
  revokedBy: { select: { fullName: true, email: true } },
} as const;

type AdjustmentRow = {
  id: bigint;
  employeeId: number;
  workDate: Date;
  deltaSec: number;
  cause: string;
  reason: string;
  beyondEvidence: boolean;
  createdAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  createdBy: { fullName: string; email: string };
  revokedBy: { fullName: string; email: string } | null;
};

/**
 * Careful: `id` becomes a string. `BigInt` makes `JSON.stringify` throw, which
 * used to turn the whole response into a 500
 * ([09 § 3a.12](../../../docs/09-Build-Log.md)).
 */
function toView(row: AdjustmentRow): AdjustmentView {
  return {
    id: String(row.id),
    employeeId: row.employeeId,
    workDate: row.workDate.toISOString().slice(0, 10),
    deltaSec: row.deltaSec,
    cause: row.cause,
    reason: row.reason,
    beyondEvidence: row.beyondEvidence,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy.fullName,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy?.fullName ?? null,
    revokeReason: row.revokeReason,
    active: row.revokedAt === null,
  };
}
