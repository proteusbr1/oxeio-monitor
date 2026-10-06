import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  formatWorkDate,
  spreadIntoHourBuckets,
  spreadTeamIntoHourBuckets,
} from './dashboard.math';
import type { HourlyChart, TeamPulse, Timeline } from './dashboard.types';
import { resolveWorkDate } from './dashboard.work-date';

/**
 * One day in detail: one employee's timeline and hourly chart, and the team's
 * rhythm of the day for the live board (`GET /live/pulse`).
 *
 * Careful: no calculation is written here — status, buckets and dates all
 * live in `dashboard.math.ts`. This class only fetches and arranges data.
 */
@Injectable()
export class DashboardDayService {
  constructor(private readonly prisma: PrismaService) {}

  /** All segments of that work day, in time order */
  async timeline(employeeId: number, rawDate?: string): Promise<Timeline> {
    const workDate = resolveWorkDate(rawDate);
    const employee = await this.requireEmployee(employeeId);

    const rows = await this.prisma.activitySegment.findMany({
      where: { employeeId, workDate },
      select: {
        id: true,
        deviceId: true,
        state: true,
        startedAt: true,
        endedAt: true,
        durationSec: true,
      },
      orderBy: { startedAt: 'asc' },
    });

    const totals = { activeSec: 0, idleSec: 0, lockedSec: 0 };
    for (const r of rows) {
      if (r.state === 'active') totals.activeSec += r.durationSec;
      else if (r.state === 'idle') totals.idleSec += r.durationSec;
      else totals.lockedSec += r.durationSec;
    }

    return {
      employeeId,
      empCode: employee.empCode,
      fullName: employee.fullName,
      date: formatWorkDate(workDate),
      // Careful: `id` is a BigInt — BigInt JSON serialisation is not set up in
      // app.setup.ts, so returning it directly would throw "Do not know how to
      // serialize a BigInt" while building the response, giving a 500.
      // A string is safe anyway — a JS number silently loses precision above
      // about 9,007 trillion.
      segments: rows.map((r) => ({ ...r, id: r.id.toString() })),
      totals,
    };
  }

  /** 24 buckets, each holding active seconds */
  async hourly(employeeId: number, rawDate?: string): Promise<HourlyChart> {
    const workDate = resolveWorkDate(rawDate);
    await this.requireEmployee(employeeId);

    // Careful: only `countsAsWork` — if idle or locked time entered the hourly
    // chart, the answer to "how much work in which hour" would be inflated.
    const rows = await this.prisma.activitySegment.findMany({
      where: { employeeId, workDate, countsAsWork: true },
      select: { startedAt: true, endedAt: true, durationSec: true },
      orderBy: { startedAt: 'asc' },
    });

    const buckets = spreadIntoHourBuckets(rows, workDate);

    return {
      employeeId,
      date: formatWorkDate(workDate),
      buckets: buckets.map((activeSec, hour) => ({ hour, activeSec })),
      totalActiveSec: buckets.reduce((a, b) => a + b, 0),
    };
  }
  /**
   * **The team's rhythm for the day**, for the live board's chart.
   *
   * Careful: without this the board could not draw any time line: `/live` sends
   * only the **current** state, and `/employees/:id/hourly` covers one person.
   * To get ten people's rhythm the browser would make ten calls — on every
   * refresh, from every open tab. So the sum is done on the server, in **one** query.
   *
   * Careful: deliberately **not merged** with `/live`. The board refreshes
   * every 30 seconds, but the day's rhythm does not change that fast — fetching
   * an hour bucket every 30 seconds means fetching the same answer 120 times.
   * Kept separate, the web can call it at its own (slow) pace.
   */
  async teamPulse(rawDate?: string): Promise<TeamPulse> {
    const workDate = resolveWorkDate(rawDate);

    // Careful: only `countsAsWork`, as in `hourly()` — if idle or locked time
    // entered, the answer to "how much work in which hour" would be inflated.
    const rows = await this.prisma.activitySegment.findMany({
      where: { workDate, countsAsWork: true },
      select: {
        employeeId: true,
        startedAt: true,
        endedAt: true,
        durationSec: true,
      },
      orderBy: { startedAt: 'asc' },
    });

    const hours = spreadTeamIntoHourBuckets(rows, workDate);

    return {
      date: formatWorkDate(workDate),
      hours,
      totalActiveSec: hours.reduce((a, h) => a + h.activeSec, 0),
      /**
       * The most people **at once** in the day — the chart's y-axis stands on
       * this. Computing it in the client would work too, but then the axis limit
       * and the data would come from two places.
       */
      peakPeople: hours.reduce((m, h) => Math.max(m, h.people), 0),
    };
  }

  private async requireEmployee(
    employeeId: number,
  ): Promise<{ empCode: string; fullName: string }> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { empCode: true, fullName: true },
    });
    if (!employee) throw new NotFoundException('No such staff member');
    return employee;
  }
}
