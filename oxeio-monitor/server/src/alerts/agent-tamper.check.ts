import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  SHUTDOWN_PAIR_WINDOW_MIN,
  TAMPER_EVENT_TYPES,
  TAMPER_LOOKBACK_MIN,
  UNINSTALL_EVENT_TYPES,
} from './alerts.constants';
import {
  CLEAN_STOP_CONTEXT,
  isTamperStop,
  tamperSeverity,
  type StopEvent,
} from './alerts.rules';
import { AlertsService, type RaiseInput } from './alerts.service';

/** The most events looked at in one pass; keeps the query small even if a queue builds up. */
const MAX_EVENTS_PER_RUN = 500;

/**
 * G02 - an attempt to stop or uninstall the agent.
 *
 * This is the only check where a **false alert** is considered less harmful
 * than silence. Every other check stays quiet when in doubt; this one speaks.
 * An agent that is quietly switched off means that day's hours are nowhere, and
 * nobody notices until month end, when nothing can be done.
 */
@Injectable()
export class AgentTamperCheck {
  private readonly logger = new Logger(AgentTamperCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    const since = new Date(now.getTime() - TAMPER_LOOKBACK_MIN * 60_000);

    const stops = await this.prisma.event.findMany({
      where: {
        type: { in: [...TAMPER_EVENT_TYPES] },
        // Careful: `receivedAt`, not `occurredAt`. The agent stores events while
        //    offline, so an agent_stop from three days ago can arrive today.
        //    Searching by event time would never catch those late arrivals.
        receivedAt: { gte: since },
        deviceId: { not: null },
      },
      select: {
        deviceId: true,
        employeeId: true,
        type: true,
        occurredAt: true,
      },
      orderBy: { occurredAt: 'asc' },
      take: MAX_EVENTS_PER_RUN,
    });

    if (stops.length === 0) return 0;

    const context = await this.shutdownContext(stops);
    const tampered = stops.filter((s) =>
      isTamperStop(s as StopEvent, context),
    );
    if (tampered.length === 0) return 0;

    const hostnames = await this.hostnames(tampered.map((t) => t.deviceId));

    const inputs: RaiseInput[] = tampered.map((t) => {
      const host = hostnames.get(t.deviceId ?? -1) ?? `device #${t.deviceId}`;
      const uninstall = UNINSTALL_EVENT_TYPES.includes(t.type);

      return {
        type: 'agent_killed' as const,
        severity: tamperSeverity(t.type),
        deviceId: t.deviceId,
        employeeId: t.employeeId,
        title: uninstall
          ? `Agent uninstall attempt — ${host}`
          : `Agent was stopped — ${host}`,
        detail: uninstall
          ? `Someone tried to remove the agent on ${host} (${t.type}).`
          : `The agent stopped on ${host}, but there is no logoff, shutdown or ` +
            'update nearby — so the agent was stopped while the PC stayed on.',
        meta: {
          eventType: t.type,
          occurredAt: t.occurredAt.toISOString(),
          hostname: host,
        },
      };
    });

    this.logger.warn(`${inputs.length} possible tampering events found`);
    return this.alerts.raiseMany(inputs, now);
  }

  /**
   * The logoff/shutdown events of those devices, from around the time of the
   * stop. They decide which agent_stop is normal and which is not.
   */
  private async shutdownContext(
    stops: readonly { deviceId: number | null; occurredAt: Date }[],
  ): Promise<StopEvent[]> {
    const deviceIds = [
      ...new Set(
        stops
          .map((s) => s.deviceId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const times = stops.map((s) => s.occurredAt.getTime());
    const pad = SHUTDOWN_PAIR_WINDOW_MIN * 60_000;

    const rows = await this.prisma.event.findMany({
      where: {
        deviceId: { in: deviceIds },
        /**
         * Careful: the list is **no longer hand-written here**. It used to be,
         * and that became a second copy of the rule: `isTamperStop()` looked at
         * one list, the query at another. This trap showed up exactly when
         * `agent_update` was added: even after adding it to the rule, the query
         * **never fetched the row**, so the pair never matched and false alerts
         * kept firing as before.
         */
        type: { in: [...CLEAN_STOP_CONTEXT] },
        occurredAt: {
          gte: new Date(Math.min(...times) - pad),
          lte: new Date(Math.max(...times) + pad),
        },
      },
      select: { deviceId: true, type: true, occurredAt: true },
    });

    return rows.map((r) => ({
      deviceId: r.deviceId,
      type: r.type,
      occurredAt: r.occurredAt,
    }));
  }

  private async hostnames(
    ids: readonly (number | null)[],
  ): Promise<Map<number, string>> {
    const wanted = ids.filter((id): id is number => id !== null);
    const devices = await this.prisma.device.findMany({
      where: { id: { in: wanted } },
      select: { id: true, hostname: true },
    });
    return new Map(devices.map((d) => [d.id, d.hostname]));
  }
}
