import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { isWorkday } from '../summary/summary.math';

export interface LeaveView {
  id: number;
  employeeId: number;
  employeeName: string;
  leaveDate: string;
  type: string;
  note: string | null;
  createdBy: string;
  /**
   * Whether that date was a workday for that employee at all.
   *
   * Careful: there is a reason this goes all the way to the screen: a leave
   * written on a Friday or a public holiday **reduces nothing of the target**
   * (`countLeaveWorkdays` filters it out). The row still stays in the
   * register, and showing it like any other would make the register lie
   * ("this day got relief"). So the row stays, but says itself that it changed nothing.
   */
  countsTowardTarget: boolean;
}

/** Careful: all three are paid; for why `unpaid` is missing, see the note in `schema.prisma` */
const LEAVE_TYPES = new Set(['casual', 'sick', 'annual']);

/**
 * **R2: the leave register.**
 *
 * Careful: what it does not do: there is no application/approval flow. The
 * owner or a manager just writes a date, that is all. In a seven-person
 * office, adding an approval step would build a process nobody would use, and
 * then the register would stay empty, so leave days would remain "absences".
 *
 * **The decision: leave is paid.** Leave reduces `target_sec` (those 8 hours
 * of that day are no longer owed by anyone), but it does **not** touch
 * payroll's fraction `d / D`. In the code this separation is guarded in three
 * places: `prorate()`, `proratedExpectedSec()`, and `test/proration.spec.ts`.
 */
@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * All leave in one month, with employee names.
   *
   * Careful: filtering by month is **mandatory**, a range is not optional:
   * the register grows year after year, and no screen needs "all leave".
   */
  async list(yearMonth: string): Promise<{ rows: LeaveView[] }> {
    const { first, last } = monthBounds(yearMonth);

    const [rows, holidayRows] = await Promise.all([
      this.prisma.leave.findMany({
        where: { leaveDate: { gte: first, lte: last } },
        orderBy: [{ leaveDate: 'asc' }, { employeeId: 'asc' }],
        include: {
          employee: {
            select: {
              fullName: true,
              policy: { select: { weeklyOffDays: true } },
            },
          },
        },
      }),
      this.prisma.holiday.findMany({
        where: { holidayDate: { gte: first, lte: last } },
        select: { holidayDate: true },
      }),
    ]);

    const holidays = new Set(holidayRows.map((h) => h.holidayDate.getTime()));

    return {
      rows: rows.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        employeeName: r.employee.fullName,
        leaveDate: r.leaveDate.toISOString().slice(0, 10),
        type: r.type,
        note: r.note,
        createdBy: r.createdBy,
        countsTowardTarget: isWorkday(
          r.leaveDate,
          r.employee.policy?.weeklyOffDays ?? [],
          holidays,
        ),
      })),
    };
  }

  /**
   * Writing leave for one or more days.
   *
   * **By range**, not one day at a time: people take leave "from the 10th to
   * the 14th", not "the 10th" five times. With a one-day API the screen would
   * have to send five requests, and if one failed midway the register would
   * hold half a leave.
   */
  async create(
    actor: SessionUser,
    input: {
      employeeId: number;
      from: string;
      to: string;
      type: string;
      note?: string;
    },
    ip: string,
  ): Promise<{ created: number; skipped: string[] }> {
    if (!LEAVE_TYPES.has(input.type)) {
      throw new BadRequestException(
        `Unknown leave type "${input.type}" — expected one of ${[...LEAVE_TYPES].join(', ')}`,
      );
    }

    const from = parseDate(input.from);
    const to = parseDate(input.to);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('The start date is after the end date');
    }

    /**
     * Careful: **a ceiling of 92 days.** Nobody would write a range longer
     * than this except through a typo (`2016` instead of `2026`), and without
     * a ceiling that typo would insert several thousand rows and zero out
     * every month's target.
     */
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > 92) {
      throw new BadRequestException(
        `${days} days is too long for one entry — 92 is the limit`,
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: input.employeeId },
      select: { id: true, fullName: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    /**
     * Careful: **leave cannot be written into a closed month** (R1). Allowing
     * it would defeat the whole purpose of closing: `refreshMonth()` does not
     * touch a closed month, so the row would sit in the register while the
     * target did not change, and the leave register and the numbers would
     * silently disagree for ever.
     */
    const months = [
      ...new Set(
        eachDay(from, to).map((d) => d.toISOString().slice(0, 7)),
      ),
    ];
    const closed = await this.prisma.monthClosure.findMany({
      where: { yearMonth: { in: months } },
      select: { yearMonth: true },
    });
    if (closed.length > 0) {
      throw new ConflictException(
        `${closed.map((c) => c.yearMonth).join(', ')} ${closed.length === 1 ? 'is' : 'are'} closed — reopen the month first`,
      );
    }

    /**
     * `skipDuplicates`: the whole range does not fail because of one day that
     * is already written. Which days were skipped is returned below, otherwise
     * the screen would say "5 added" when only 3 were.
     */
    const existing = await this.prisma.leave.findMany({
      where: {
        employeeId: employee.id,
        leaveDate: { gte: from, lte: to },
      },
      select: { leaveDate: true },
    });
    const already = new Set(existing.map((e) => e.leaveDate.getTime()));
    const fresh = eachDay(from, to).filter((d) => !already.has(d.getTime()));

    if (fresh.length > 0) {
      await this.prisma.leave.createMany({
        data: fresh.map((leaveDate) => ({
          employeeId: employee.id,
          leaveDate,
          type: input.type,
          note: input.note?.trim() || null,
          createdBy: actor.email,
        })),
      });
    }

    await this.audit.record({
      userId: actor.userId,
      action: 'leave_added',
      targetType: 'employee',
      targetId: String(employee.id),
      ipAddress: ip,
      meta: {
        from: input.from,
        to: input.to,
        type: input.type,
        created: fresh.length,
      },
    });

    this.logger.log(
      `${fresh.length} leave day(s) for ${employee.fullName} (${input.from}…${input.to}) by ${actor.email}`,
    );

    return {
      created: fresh.length,
      skipped: [...already]
        .sort((a, b) => a - b)
        .map((ms) => new Date(ms).toISOString().slice(0, 10)),
    };
  }

  /**
   * Deleting one day of leave.
   *
   * Careful: it is really deleted, not `revoked_at`: leave is not a financial
   * transaction (unlike a time adjustment), and the audit keeps who deleted it and when.
   */
  async remove(actor: SessionUser, id: number, ip: string): Promise<void> {
    const row = await this.prisma.leave.findUnique({
      where: { id },
      select: { id: true, employeeId: true, leaveDate: true, type: true },
    });
    if (!row) throw new NotFoundException('Leave entry not found');

    const yearMonth = row.leaveDate.toISOString().slice(0, 7);
    const closed = await this.prisma.monthClosure.findUnique({
      where: { yearMonth },
      select: { yearMonth: true },
    });
    // Careful: deleting is blocked in a closed month too, for the same reason:
    // the register would change, the numbers would not
    if (closed) {
      throw new ConflictException(
        `${yearMonth} is closed — reopen the month first`,
      );
    }

    await this.prisma.leave.delete({ where: { id } });

    await this.audit.record({
      userId: actor.userId,
      action: 'leave_removed',
      targetType: 'employee',
      targetId: String(row.employeeId),
      ipAddress: ip,
      meta: {
        leaveDate: row.leaveDate.toISOString().slice(0, 10),
        type: row.type,
      },
    });
  }
}

/** `YYYY-MM-DD` -> UTC midnight, exactly as it is stored in the `holidays` table */
function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`Expected YYYY-MM-DD, got "${value}"`);
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`"${value}" is not a real date`);
  }
  return d;
}

function eachDay(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
    out.push(new Date(t));
  }
  return out;
}

function monthBounds(yearMonth: string): { first: Date; last: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
    throw new BadRequestException(`Expected YYYY-MM, got "${yearMonth}"`);
  }
  const [y, m] = yearMonth.split('-').map(Number);
  return {
    first: new Date(Date.UTC(y, m - 1, 1)),
    last: new Date(Date.UTC(y, m, 0)),
  };
}
