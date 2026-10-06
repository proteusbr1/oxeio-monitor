import { Injectable, Logger } from '@nestjs/common';

import { workDateOf } from '../agent/util/work-time';
import { PrismaService } from '../prisma/prisma.service';
import { AGENT_SILENCE_MIN } from './alerts.constants';
import {
  agentDownCandidates,
  isAgentWatchOpen,
  recoveredAlertIds,
  silentMinutes,
  CLEAN_STOP_EVENTS,
  type DeviceSilence,
} from './alerts.rules';
import { AlertsService, type RaiseInput } from './alerts.service';

/** How far back to look for clean stop events; keeps the query small. */
const STOP_LOOKBACK_DAYS = 7;

/**
 * G01 - an agent silent for 10 minutes (spec § 6.4, every 5 minutes).
 *
 * Careful: "silent" does not always mean "a problem". Someone shutting down
 *    their PC and going home is silent too. The difference is made by
 *    `isExpectedSilence()` in alerts.rules.ts; the details are there.
 */
@Injectable()
export class AgentDownCheck {
  private readonly logger = new Logger(AgentDownCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    const silenceFloor = new Date(now.getTime() - AGENT_SILENCE_MIN * 60_000);

    const [devices, holiday, fallbackPolicy, leaves] = await Promise.all([
      this.prisma.device.findMany({
        where: {
          // Revoked devices are excluded; their silence is the whole point.
          status: 'active',
          lastSeenAt: { not: null, lt: silenceFloor },
        },
        select: {
          id: true,
          hostname: true,
          lastSeenAt: true,
          employeeId: true,
          employee: {
            select: {
              fullName: true,
              policy: {
                select: {
                  officeFrom: true,
                  officeTo: true,
                  weeklyOffDays: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.holiday.findUnique({
        where: { holidayDate: workDateOf(now) },
        select: { name: true },
      }),
      /**
       * Careful: a fallback for devices not bound to any employee (employeeId
       *    null); otherwise they would stay outside the office-hours rule and
       *    raise alerts at night too.
       */
      this.prisma.workPolicy.findFirst({
        where: { isActive: true },
        select: { officeFrom: true, officeTo: true, weeklyOffDays: true },
      }),
      /**
       * **Who is on leave today** (G157).
       *
       * Careful: this query was **missing for a month**. The leave register
       * arrived with R2/G130, but no alert check ever read `leaves`, so "agent
       * silent" notices went out even on days the owner had approved leave.
       * In the field: 11 false alerts over 3 leave days, 8 of them of this kind.
       */
      this.prisma.leave.findMany({
        where: { leaveDate: workDateOf(now) },
        select: { employeeId: true },
      }),
    ]);

    if (devices.length === 0) return 0;

    /**
     * **Silence is expected when the office is closed.**
     *
     * Careful: the filter is here, not inside `agentDownCandidates()`. That
     *    function asks "is there an explanation for this silence?", while this
     *    asks "does the question even make sense right now?". They are
     *    different, so they stay separate.
     *
     * Careful: devices are **not removed, only the alert is not raised**.
     *    `lastSeenAt` is stored as before, so when the office opens in the
     *    morning, a PC that is still silent will get its alert.
     */
    /**
     * Careful: **a PC of someone on leave is naturally silent**, and the filter
     * is here, not in `isAgentWatchOpen()`. That function answers the **office's**
     * question ("is it working time now?"), whereas leave concerns **one
     * person**. Mixing the two would let one person's leave switch off the
     * watch for the whole team.
     */
    const onLeave = new Set(leaves.map((l) => l.employeeId));

    const open = devices
      .filter((d) => d.employeeId === null || !onLeave.has(d.employeeId))
      .filter((d) =>
        isAgentWatchOpen({
          now,
          officeFrom:
            d.employee?.policy?.officeFrom ??
            fallbackPolicy?.officeFrom ??
            null,
          officeTo:
            d.employee?.policy?.officeTo ?? fallbackPolicy?.officeTo ?? null,
          weeklyOffDays:
            d.employee?.policy?.weeklyOffDays ??
            fallbackPolicy?.weeklyOffDays ??
            [],
          isHoliday: holiday !== null,
        }),
      );

    if (open.length === 0) {
      this.logger.debug(
        `${devices.length} devices silent, but nobody is expected yet — not raising`,
      );
      return 0;
    }

    const lastStops = await this.lastCleanStops(
      open.map((d) => d.id),
      now,
    );

    const silences: DeviceSilence[] = open.map((d) => ({
      deviceId: d.id,
      lastSeenAt: d.lastSeenAt,
      lastCleanStopAt: lastStops.get(d.id) ?? null,
    }));

    const down = new Set(
      agentDownCandidates(silences, now).map((s) => s.deviceId),
    );
    if (down.size === 0) return 0;

    const inputs: RaiseInput[] = open
      .filter((d) => down.has(d.id))
      .map((d) => {
        const minutes = silentMinutes(d.lastSeenAt, now) ?? 0;
        return {
          type: 'agent_down' as const,
          severity: 'warning' as const,
          deviceId: d.id,
          employeeId: d.employeeId,
          title: `Agent silent — ${d.hostname}`,
          detail:
            `${d.hostname}${d.employee ? ` (${d.employee.fullName})` : ''} ` +
            `has sent nothing for ${minutes} minutes, and no shutdown event arrived either. ` +
            'Check whether the PC is on, the network is working, and the agent is running.',
          meta: { silentMinutes: minutes, hostname: d.hostname },
        };
      });

    this.logger.warn(`${inputs.length} devices silent with no explanation`);
    return this.alerts.raiseMany(inputs, now);
  }

  /**
   * A returning agent: close its open agent_down alert automatically.
   *
   * The **mirror** of `runOnce`: that **raises** an alert on a silent device,
   * this **closes** the open alert of a device that speaks again
   * (`recoveredAlertIds`). So in the morning the owner sees only the PCs that
   * are really down now, not a dozen stale warnings from PCs that went off at
   * night and came back.
   *
   * Careful: the ingest hot path (device-auth.guard) is not touched: same
   *    `lastSeenAt` column, same scheduler, no extra cost per request.
   */
  async resolveReturned(now = new Date()): Promise<number> {
    const open = await this.prisma.alert.findMany({
      where: {
        type: 'agent_down',
        acknowledgedAt: null,
        resolvedAt: null,
        deviceId: { not: null },
      },
      select: {
        id: true,
        device: { select: { status: true, lastSeenAt: true } },
      },
    });
    if (open.length === 0) return 0;

    const ids = recoveredAlertIds(
      open.map((a) => ({
        alertId: a.id,
        deviceActive: a.device?.status === 'active',
        lastSeenAt: a.device?.lastSeenAt ?? null,
      })),
      now,
    );
    return this.alerts.resolveMany(ids, 'agent returned', now);
  }

  /**
   * The **latest clean stop event** of each device.
   *
   * Careful: `groupBy` is used, not `findMany + distinct`. Prisma's `distinct`
   *    pulls every row and filters in memory, and the events table grows fast.
   *    Here the work is done in the database with `MAX(occurred_at)`.
   */
  private async lastCleanStops(
    deviceIds: number[],
    now: Date,
  ): Promise<Map<number, Date>> {
    const rows = await this.prisma.event.groupBy({
      by: ['deviceId'],
      where: {
        deviceId: { in: deviceIds },
        type: { in: [...CLEAN_STOP_EVENTS] },
        occurredAt: {
          gte: new Date(now.getTime() - STOP_LOOKBACK_DAYS * 86_400_000),
        },
      },
      _max: { occurredAt: true },
    });

    const map = new Map<number, Date>();
    for (const row of rows) {
      if (row.deviceId !== null && row._max.occurredAt) {
        map.set(row.deviceId, row._max.occurredAt);
      }
    }
    return map;
  }
}
