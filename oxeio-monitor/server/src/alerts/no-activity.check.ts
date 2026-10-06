import { Injectable, Logger } from '@nestjs/common';

import { workDateOf } from '../agent/util/work-time';
import { PrismaService } from '../prisma/prisma.service';
import { isNoActivityWindow, shouldFlagNoActivity } from './alerts.rules';
import { AlertsService, type RaiseInput } from './alerts.service';

/**
 * G06: nobody did any work all day.
 *
 * The severity is deliberately `info`, not `warning`. "Nobody came in today"
 * is not an **error**, just information. Making it a warning would put it in
 * the same bracket as real errors (agent died, disk full), and the word
 * warning would lose its weight.
 *
 * Careful: this comment used to say "this system has no leave facility
 * (ADR-011d)", and that had been stale for a month. The leave register
 * arrived on 5 September, but this check only started reading the `leaves`
 * table on 6 September, so approved leave still raised alerts in between.
 * A stale comment is not just untidy: it leaves the next reader believing the wrong thing.
 */
@Injectable()
export class NoActivityCheck {
  private readonly logger = new Logger(NoActivityCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    // Outside the evening window the question is meaningless, so no query is made either
    if (!isNoActivityWindow(now)) return 0;

    const workDate = workDateOf(now);

    const [employees, holiday, worked, leaves] = await Promise.all([
      this.prisma.employee.findMany({
        where: { status: 'active' },
        select: {
          id: true,
          fullName: true,
          joinedOn: true,
          leftOn: true,
          policy: { select: { weeklyOffDays: true } },
        },
      }),
      this.prisma.holiday.findUnique({
        where: { holidayDate: workDate },
        select: { name: true },
      }),
      /**
       * Careful: raw `activity_segments`, not `daily_summary`.
       *
       * The rollup job runs every 15 minutes (§ 6.4), but if it is stopped or
       * behind, everyone would look like "did no work" and twelve false alerts
       * would go out. The raw table never lies.
       */
      this.prisma.activitySegment.groupBy({
        by: ['employeeId'],
        where: { workDate, countsAsWork: true },
        _count: { _all: true },
      }),
      /**
       * **Who is on leave today.**
       *
       * Careful: this query was **missing for a month**. The leave register
       * arrived, but no alert check ever read the `leaves` table, so "nobody
       * did any work today" went out even on approved leave days. In the
       * field: 11 false alerts on 3 leave days.
       */
      this.prisma.leave.findMany({
        where: { leaveDate: workDate },
        select: { employeeId: true },
      }),
    ]);

    const workedBy = new Map(worked.map((w) => [w.employeeId, w._count._all]));
    const onLeave = new Set(leaves.map((l) => l.employeeId));

    const inputs: RaiseInput[] = employees
      .filter((e) =>
        shouldFlagNoActivity({
          workedSegments: workedBy.get(e.id) ?? 0,
          weeklyOffDays: e.policy?.weeklyOffDays ?? [],
          isHoliday: holiday !== null,
          onLeave: onLeave.has(e.id),
          joinedOn: e.joinedOn,
          leftOn: e.leftOn,
          now,
        }),
      )
      .map((e) => ({
        type: 'no_activity_today' as const,
        severity: 'info' as const,
        deviceId: null,
        employeeId: e.id,
        title: `No work recorded today — ${e.fullName}`,
        detail:
          `${e.fullName} has no active segment at all today ` +
          `(${workDate.toISOString().slice(0, 10)}). If they were absent there is ` +
          'nothing to do; if they were in the office, check whether the agent is ' +
          'running on that PC.',
        meta: { workDate: workDate.toISOString().slice(0, 10) },
      }));

    if (inputs.length === 0) return 0;

    this.logger.log(`${inputs.length} staff have no work recorded today`);
    return this.alerts.raiseMany(inputs, now);
  }
}
