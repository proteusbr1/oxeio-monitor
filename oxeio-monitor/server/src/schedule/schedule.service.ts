import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { presenceSpans, type Span } from '../summary/summary.math';
import { minuteOfWorkDay } from './schedule-policy';
import type { DigestBreach } from './schedule.digest';
import {
  checkDay,
  MINUTES_PER_DAY,
  monthTotals,
  type Breach,
  type SchedulePolicy,
} from './schedule.rules';

export interface ScheduleInput {
  employeeId: number;
  /** null = this person's policy checks no schedule */
  schedule: SchedulePolicy | null;
  presenceGapSec: number;
  /** a workday for this person: not a day off, not a holiday, employed */
  checked: boolean;
  active: readonly Span[];
}

/**
 * Writes the schedule check of one work day, called by the day roll-up right
 * after it stores the day's hours. Rows exist only for checked days; a day
 * that stops being checked (schedule switched off, leave added) loses its row,
 * so the screen never shows a stale breach.
 */
@Injectable()
export class ScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  async writeDay(
    workDate: Date,
    people: readonly ScheduleInput[],
    now: Date,
  ): Promise<void> {
    if (people.length === 0) return;
    const ids = people.map((p) => p.employeeId);
    const onLeave = new Set(
      (
        await this.prisma.leave.findMany({
          where: { leaveDate: workDate, employeeId: { in: ids } },
          select: { employeeId: true },
        })
      ).map((l) => l.employeeId),
    );

    const nowMin = minuteOfWorkDay(now, workDate);
    const ops: Prisma.PrismaPromise<unknown>[] = [];

    for (const p of people) {
      const where = {
        employeeId_workDate: { employeeId: p.employeeId, workDate },
      };
      if (!p.schedule || !p.checked || onLeave.has(p.employeeId)) {
        ops.push(
          this.prisma.scheduleDay.deleteMany({
            where: { employeeId: p.employeeId, workDate },
          }),
        );
        continue;
      }
      const blocks = presenceSpans(p.active, p.presenceGapSec).map((s) => ({
        fromMin: minuteOfWorkDay(s.startedAt, workDate),
        toMin: minuteOfWorkDay(s.endedAt, workDate),
      }));
      const day = checkDay({
        blocks,
        policy: p.schedule,
        nowMin: Math.min(nowMin, MINUTES_PER_DAY),
      });
      const data = { ...day, computedAt: now };
      ops.push(
        this.prisma.scheduleDay.upsert({
          where,
          create: { employeeId: p.employeeId, workDate, ...data },
          update: data,
        }),
      );
    }

    await this.prisma.$transaction(ops);
  }
  /** Active staff whose policy checks a schedule — the Schedule screen's picker */
  async people(): Promise<{ id: number; fullName: string }[]> {
    return this.prisma.employee.findMany({
      where: { status: 'active', policy: { scheduleEnforced: true } },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });
  }

  async month(employeeId: number, yearMonth: string) {
    const from = new Date(`${yearMonth}-01T00:00:00.000Z`);
    const to = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0),
    );
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        policy: { select: { breakMinutes: true, scheduleEnforced: true } },
      },
    });
    if (!employee) return null;
    const rows = await this.prisma.scheduleDay.findMany({
      where: { employeeId, workDate: { gte: from, lte: to } },
      orderBy: { workDate: 'asc' },
    });
    const days = rows.map((r) => ({
      date: r.workDate.toISOString().slice(0, 10),
      arrivedMin: r.arrivedMin,
      leftMin: r.leftMin,
      breakStartMin: r.breakStartMin,
      breakMin: r.breakMin,
      lateMin: r.lateMin,
      earlyLeaveMin: r.earlyLeaveMin,
      balanceMin: r.balanceMin,
      breaches: r.breaches as Breach[],
      final: r.final,
    }));
    return {
      employee: { id: employee.id, fullName: employee.fullName },
      days,
      totals: monthTotals(days),
      requiredBreakMin: employee.policy?.scheduleEnforced
        ? (employee.policy.breakMinutes ?? 0)
        : null,
    };
  }

  /** Breaches recorded for a day, for the 18:30 summary */
  async breachesOn(workDate: Date): Promise<DigestBreach[]> {
    const rows = await this.prisma.scheduleDay.findMany({
      where: { workDate, NOT: { breaches: { isEmpty: true } } },
      select: {
        breaches: true,
        lateMin: true,
        earlyLeaveMin: true,
        breakMin: true,
        employee: {
          select: {
            fullName: true,
            policy: { select: { breakMinutes: true } },
          },
        },
      },
      orderBy: { employee: { fullName: 'asc' } },
    });
    return rows.map((r) => ({
      fullName: r.employee.fullName,
      breaches: r.breaches as Breach[],
      lateMin: r.lateMin,
      earlyLeaveMin: r.earlyLeaveMin,
      breakMin: r.breakMin,
      requiredBreakMin: r.employee.policy?.breakMinutes ?? 0,
    }));
  }
}
