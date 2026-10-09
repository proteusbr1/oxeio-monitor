import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { workDateOf } from '../agent/util/work-time';
import { PrismaService } from '../prisma/prisma.service';
import { isWorkday, presenceSpans, type Span } from '../summary/summary.math';
import {
  minuteOfWorkDay,
  SCHEDULE_SELECT,
  schedulePolicyOf,
} from './schedule-policy';
import type { DigestBreach } from './schedule.digest';
import {
  checkDay,
  MINUTES_PER_DAY,
  monthTotals,
  type Breach,
  type SchedulePolicy,
} from './schedule.rules';

/** One person on the Live Board's "Schedule today" card */
export interface TodayPerson {
  employeeId: number;
  fullName: string;
  startMin: number;
  endMin: number;
  requiredBreakMin: number;
  breakFromMin: number;
  breakToMin: number;
  /** false on a day off, a holiday, recorded leave or outside employment */
  checkedToday: boolean;
  arrivedMin: number | null;
  leftMin: number | null;
  breakStartMin: number | null;
  breakMin: number;
  lateMin: number;
  earlyLeaveMin: number;
  breaches: Breach[];
  final: boolean;
}

export interface ScheduleDayInput {
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
 * that stops being checked (schedule switched off, leave or a holiday added,
 * a day off, before the first or after the last day) loses its row, so the
 * screen never shows a stale breach. What changes those inputs queues the
 * day for a recount (summary/recount.ts › markDirty).
 */
@Injectable()
export class ScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  async writeDay(
    workDate: Date,
    people: readonly ScheduleDayInput[],
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
    const unchecked: number[] = [];
    const ops: Prisma.PrismaPromise<unknown>[] = [];

    for (const p of people) {
      if (!p.schedule || !p.checked || onLeave.has(p.employeeId)) {
        unchecked.push(p.employeeId);
        continue;
      }
      const where = {
        employeeId_workDate: { employeeId: p.employeeId, workDate },
      };
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

    // one delete for every day that is no longer checked
    ops.unshift(
      this.prisma.scheduleDay.deleteMany({
        where: {
          workDate,
          OR: [
            { employeeId: { in: unchecked } },
            // people outside this run (deactivated) whose employment does
            // not cover the day: a last day moved back leaves rows behind
            {
              employee: {
                OR: [
                  { leftOn: { lt: workDate } },
                  { joinedOn: { gt: workDate } },
                ],
              },
            },
          ],
        },
      }),
    );
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

  /**
   * Today's check for everyone on a schedule, as the last roll-up left it —
   * the Live Board's card. The day counts as checked by the same rules the
   * roll-up uses (summary.service › refreshDate, writeDay); a stored row
   * always does, since rows exist only for checked days.
   */
  async today(now: Date = new Date()): Promise<{
    workDate: string;
    nowMin: number;
    people: TodayPerson[];
  }> {
    const workDate = workDateOf(now);
    const employees = await this.prisma.employee.findMany({
      where: { status: 'active', policy: { scheduleEnforced: true } },
      select: {
        id: true,
        fullName: true,
        joinedOn: true,
        leftOn: true,
        policy: { select: { weeklyOffDays: true, ...SCHEDULE_SELECT } },
      },
      orderBy: { fullName: 'asc' },
    });
    const scheduled = employees.flatMap((e) => {
      const schedule = schedulePolicyOf(e.policy);
      return schedule ? [{ ...e, schedule }] : [];
    });
    const ids = scheduled.map((e) => e.id);
    const [rows, leave, holiday] = await Promise.all([
      this.prisma.scheduleDay.findMany({
        where: { workDate, employeeId: { in: ids } },
      }),
      this.prisma.leave.findMany({
        where: { leaveDate: workDate, employeeId: { in: ids } },
        select: { employeeId: true },
      }),
      this.prisma.holiday.findUnique({ where: { holidayDate: workDate } }),
    ]);
    const rowBy = new Map(rows.map((r) => [r.employeeId, r]));
    const onLeave = new Set(leave.map((l) => l.employeeId));
    const holidays = new Set(holiday ? [workDate.getTime()] : []);

    const people = scheduled.map((e): TodayPerson => {
      const row = rowBy.get(e.id);
      const checkedToday =
        row !== undefined ||
        (isWorkday(workDate, e.policy?.weeklyOffDays ?? [], holidays) &&
          (e.joinedOn === null || e.joinedOn <= workDate) &&
          (e.leftOn === null || e.leftOn >= workDate) &&
          !onLeave.has(e.id));
      return {
        employeeId: e.id,
        fullName: e.fullName,
        startMin: e.schedule.startMin,
        endMin: e.schedule.endMin,
        requiredBreakMin: e.schedule.breakMin,
        breakFromMin: e.schedule.breakFromMin,
        breakToMin: e.schedule.breakToMin,
        checkedToday,
        arrivedMin: row?.arrivedMin ?? null,
        leftMin: row?.leftMin ?? null,
        breakStartMin: row?.breakStartMin ?? null,
        breakMin: row?.breakMin ?? 0,
        lateMin: row?.lateMin ?? 0,
        earlyLeaveMin: row?.earlyLeaveMin ?? 0,
        breaches: (row?.breaches ?? []) as Breach[],
        final: row?.final ?? false,
      };
    });
    return {
      workDate: workDate.toISOString().slice(0, 10),
      nowMin: minuteOfWorkDay(now, workDate),
      people,
    };
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
        policy: {
          select: {
            breakMinutes: true,
            scheduleEnforced: true,
            officeFrom: true,
            officeTo: true,
          },
        },
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
    const enforced = employee.policy?.scheduleEnforced === true;
    return {
      employee: { id: employee.id, fullName: employee.fullName },
      days,
      totals: monthTotals(days),
      // the schedule as it stands now ('HH:MM'); null when none is checked
      requiredBreakMin: enforced ? (employee.policy?.breakMinutes ?? 0) : null,
      officeFrom: enforced ? (employee.policy?.officeFrom ?? null) : null,
      officeTo: enforced ? (employee.policy?.officeTo ?? null) : null,
    };
  }

  /** Breaches recorded for a day, for the 18:30 summary */
  async breachesOn(workDate: Date): Promise<DigestBreach[]> {
    const rows = await this.prisma.scheduleDay.findMany({
      where: {
        workDate,
        NOT: { breaches: { isEmpty: true } },
        employee: { status: 'active' },
      },
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
