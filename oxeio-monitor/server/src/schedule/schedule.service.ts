import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { presenceSpans, type Span } from '../summary/summary.math';
import { minuteOfWorkDay } from './schedule-policy';
import {
  checkDay,
  MINUTES_PER_DAY,
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
}
