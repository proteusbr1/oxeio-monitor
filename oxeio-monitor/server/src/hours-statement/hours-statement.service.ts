import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PayPeriod } from '@prisma/client';

import { workClock } from '../agent/util/work-time';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { SummaryService } from '../summary/summary.service';
import { statementLine } from './ledger.rules';
import {
  periodAfter,
  periodHolding,
  cutoffOnOrAfter,
  type CutoffDay,
} from './pay-period.rules';
import {
  countDays,
  employedRange,
  hourlyInPeriod,
  monthsTouched,
  type PayBasisName,
} from './statement.rules';
import type { StatementDayRow } from './statement-sheet';

export interface ComputedLine {
  employeeId: number;
  empCode: string;
  fullName: string;
  fromDate: string;
  toDate: string;
  measuredSec: number;
  carryInSec: number;
  toPostMin: number;
  leaveDays: number;
  holidayDays: number;
  noDataDays: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

/**
 * The hours statement: who was paid by the hour in a period, their hours and
 * the carry-over, frozen once per period. Hours only — this service never
 * selects a pay amount.
 */
@Injectable()
export class HoursStatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly summary: SummaryService,
    private readonly audit: AuditService,
  ) {}

  /** The open period (no snapshot); created from `today` on the very first run */
  async ensureOpen(today: string, cutoff: CutoffDay): Promise<PayPeriod> {
    const latest = await this.prisma.payPeriod.findFirst({
      orderBy: { startDate: 'desc' },
    });
    if (latest && latest.snapshotAt === null) return latest;
    const range = latest
      ? periodAfter(iso(latest.endDate), cutoff)
      : periodHolding(today, cutoff);
    return this.prisma.payPeriod.create({
      data: { startDate: day(range.start), endDate: day(range.end) },
    });
  }

  /** After the cutoff changes, the open period ends at the new cutoff (it never moves its start) */
  async reanchorOpen(cutoff: CutoffDay): Promise<void> {
    const open = await this.prisma.payPeriod.findFirst({
      where: { snapshotAt: null },
      orderBy: { startDate: 'desc' },
    });
    if (!open) return;
    await this.prisma.payPeriod.update({
      where: { id: open.id },
      data: { endDate: day(cutoffOnOrAfter(iso(open.startDate), cutoff)) },
    });
  }

  async computeLines(period: {
    id: number;
    start: string;
    end: string;
  }): Promise<ComputedLine[]> {
    const months = monthsTouched({ start: period.start, end: period.end });
    const staff = await this.prisma.employee.findMany({
      select: {
        id: true,
        empCode: true,
        fullName: true,
        joinedOn: true,
        leftOn: true,
        payBasis: true,
        salaryPeriods: { select: { throughMonth: true, payBasis: true } },
        policy: { select: { weeklyOffDays: true } },
      },
      orderBy: { fullName: 'asc' },
    });

    const lines: ComputedLine[] = [];
    const holidays = await this.prisma.holiday.findMany({
      where: { holidayDate: { gte: day(period.start), lte: day(period.end) } },
      select: { holidayDate: true },
    });
    const holidaySet = new Set(holidays.map((x) => iso(x.holidayDate)));

    for (const e of staff) {
      if (
        !hourlyInPeriod(
          months,
          e.payBasis as PayBasisName,
          e.salaryPeriods as { throughMonth: string; payBasis: PayBasisName }[],
        )
      )
        continue;
      const range = employedRange(
        { start: period.start, end: period.end },
        e.joinedOn ? iso(e.joinedOn) : null,
        e.leftOn ? iso(e.leftOn) : null,
      );
      if (!range) continue;

      const [days, leaves, earlier] = await Promise.all([
        this.prisma.dailySummary.findMany({
          where: {
            employeeId: e.id,
            workDate: { gte: day(range.start), lte: day(range.end) },
          },
          select: { workDate: true, creditedSec: true },
        }),
        this.prisma.leave.findMany({
          where: {
            employeeId: e.id,
            leaveDate: { gte: day(range.start), lte: day(range.end) },
          },
          select: { leaveDate: true },
        }),
        this.earlier(e.id, period.id, period.start),
      ]);

      const measuredSec = days.reduce((total, d) => total + d.creditedSec, 0);
      const { carryInSec, toPostMin } = statementLine({
        measuredSec,
        ...earlier,
      });
      lines.push({
        employeeId: e.id,
        empCode: e.empCode,
        fullName: e.fullName,
        fromDate: range.start,
        toDate: range.end,
        measuredSec,
        carryInSec,
        toPostMin,
        ...countDays({
          from: range.start,
          to: range.end,
          offDays: e.policy?.weeklyOffDays ?? [],
          holidays: holidaySet,
          leaves: new Set(leaves.map((l) => iso(l.leaveDate))),
          creditedByDate: new Map(
            days.map((d) => [iso(d.workDate), d.creditedSec]),
          ),
        }),
      });
    }
    return lines;
  }

  /** Real time now and posted minutes over this person's earlier frozen lines */
  private async earlier(
    employeeId: number,
    periodId: number,
    start: string,
  ): Promise<{ earlierRealSec: number; earlierPostedMin: number }> {
    const [real] = await this.prisma.$queryRaw<{ sec: bigint | null }[]>`
      SELECT SUM(ds.credited_sec)::bigint AS sec
        FROM pay_period_lines l
        JOIN pay_periods p ON p.id = l.period_id
        JOIN daily_summary ds
          ON ds.employee_id = l.employee_id
         AND ds.work_date BETWEEN l.from_date AND l.to_date
       WHERE l.employee_id = ${employeeId}
         AND p.id <> ${periodId}
         AND p.snapshot_at IS NOT NULL
         AND p.start_date < ${start}::date
    `;
    const posted = await this.prisma.payPeriodLine.findMany({
      where: {
        employeeId,
        periodId: { not: periodId },
        period: { snapshotAt: { not: null }, startDate: { lt: day(start) } },
      },
      select: { toPostMin: true, postedMin: true },
    });
    return {
      earlierRealSec: Number(real?.sec ?? 0),
      earlierPostedMin: posted.reduce(
        (total, l) => total + (l.postedMin ?? l.toPostMin),
        0,
      ),
    };
  }

  /** Freezes a period once; late uploads and the last day are counted first */
  async snapshot(periodId: number, now: Date): Promise<void> {
    const period = await this.prisma.payPeriod.findUniqueOrThrow({
      where: { id: periodId },
    });
    if (period.snapshotAt) return;

    // Prisma's `take` is a 32-bit int: a large finite batch, not MAX_SAFE_INTEGER
    await this.summary.drainDirty(now, 10_000);
    await this.summary.refreshDate(period.endDate, now);

    const lines = await this.computeLines({
      id: period.id,
      start: iso(period.startDate),
      end: iso(period.endDate),
    });
    await this.prisma.$transaction([
      this.prisma.payPeriodLine.createMany({
        data: lines.map((l) => ({
          periodId: period.id,
          employeeId: l.employeeId,
          fromDate: day(l.fromDate),
          toDate: day(l.toDate),
          measuredSec: l.measuredSec,
          carryInSec: l.carryInSec,
          toPostMin: l.toPostMin,
          leaveDays: l.leaveDays,
          holidayDays: l.holidayDays,
          noDataDays: l.noDataDays,
        })),
      }),
      this.prisma.payPeriod.update({
        where: { id: period.id },
        data: {
          snapshotAt: now,
          deliveryStatus: lines.length === 0 ? 'no_staff' : 'pending',
        },
      }),
    ]);
  }

  /** A frozen period is locked once a later period was frozen too (its posted values fed a carry-over) */
  async isLocked(periodId: number): Promise<boolean> {
    const period = await this.prisma.payPeriod.findUniqueOrThrow({
      where: { id: periodId },
    });
    const later = await this.prisma.payPeriod.count({
      where: { startDate: { gt: period.startDate }, snapshotAt: { not: null } },
    });
    return later > 0;
  }

  async markPosted(
    lineId: number,
    actor: SessionUser,
    postedMin: number | undefined,
    note: string | undefined,
    ip: string,
  ): Promise<void> {
    const line = await this.lineOrThrow(lineId);
    if (await this.isLocked(line.periodId))
      throw new ConflictException(
        'This period is closed: a later statement already used it',
      );
    await this.prisma.payPeriodLine.update({
      where: { id: lineId },
      data: {
        postedMin:
          postedMin === undefined || postedMin === line.toPostMin
            ? null
            : postedMin,
        postedAt: new Date(),
        postedById: actor.userId,
        note: note?.trim() || null,
      },
    });
    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'pay_period_line',
      targetId: lineId,
      ipAddress: ip,
      meta: { op: 'posted', postedMin: postedMin ?? line.toPostMin },
    });
  }

  async unmarkPosted(
    lineId: number,
    actor: SessionUser,
    ip: string,
  ): Promise<void> {
    const line = await this.lineOrThrow(lineId);
    if (await this.isLocked(line.periodId))
      throw new ConflictException(
        'This period is closed: a later statement already used it',
      );
    await this.prisma.payPeriodLine.update({
      where: { id: lineId },
      data: { postedMin: null, postedAt: null, postedById: null, note: null },
    });
    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'pay_period_line',
      targetId: lineId,
      ipAddress: ip,
      meta: { op: 'unposted' },
    });
  }

  /** One person's days in a period, for the screen and the spreadsheet */
  async days(
    range: { start: string; end: string },
    employeeIds: readonly number[],
  ): Promise<StatementDayRow[]> {
    const rows = await this.prisma.dailySummary.findMany({
      where: {
        employeeId: { in: [...employeeIds] },
        workDate: { gte: day(range.start), lte: day(range.end) },
      },
      select: {
        workDate: true,
        firstActivityAt: true,
        lastActivityAt: true,
        presenceSec: true,
        workedSec: true,
        adjustmentSec: true,
        creditedSec: true,
        employee: { select: { fullName: true, empCode: true } },
      },
      orderBy: [{ employeeId: 'asc' }, { workDate: 'asc' }],
    });
    const h = (sec: number) => Math.round((sec / 3600) * 100) / 100;
    return rows.map((r) => ({
      fullName: r.employee.fullName,
      empCode: r.employee.empCode,
      date: iso(r.workDate),
      arrived: r.firstActivityAt ? workClock(r.firstActivityAt) : null,
      left: r.lastActivityAt ? workClock(r.lastActivityAt) : null,
      presenceHours: h(r.presenceSec),
      activeHours: h(r.workedSec),
      adjustmentHours: h(r.adjustmentSec),
      creditedHours: h(r.creditedSec),
    }));
  }

  private async lineOrThrow(lineId: number) {
    const line = await this.prisma.payPeriodLine.findUnique({
      where: { id: lineId },
    });
    if (!line) throw new NotFoundException('Line not found');
    return line;
  }
}
