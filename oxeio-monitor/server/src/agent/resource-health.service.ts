import { Injectable, Logger } from '@nestjs/common';
import type { Device, Prisma } from '@prisma/client';

import { THROTTLE_HOURS } from '../alerts/alerts.constants';
import { PrismaService } from '../prisma/prisma.service';
import {
  describeResources,
  isOverCeiling,
  readResources,
  type DeviceResources,
} from './resources.rules';

/** pg_advisory_xact_lock namespace — next to capabilities' 8_413_002 */
const RESOURCE_LOCK = 8_413_003;

/**
 * Turns "the agent is over its resource ceiling" into an `agent_resources`
 * alert, and closes it when the agent is back under.
 *
 * Careful: the agent **restarts itself** above the ceiling (at a quiet moment,
 * at most once every few hours), so a raised alert usually resolves by itself
 * within minutes. It is still worth one notice: a PC that keeps coming back
 * here has a third-party DLL (`nvspcap64.dll` — the NVIDIA overlay) leaking
 * into the agent, and only a person can switch that overlay off.
 *
 * ⚠️ Only the **transitions** touch the alerts table: under → over raises,
 *    over → under resolves. The report comes with every heartbeat (15 devices ×
 *    every 30 s); a query per heartbeat for a state that almost never changes
 *    would be pure waste. `before` is the row as it was **before** this
 *    heartbeat's UPDATE, so the caller passes the device it already loaded.
 * ⚠️ Same throttle as `CapabilityHealthService`: within THROTTLE_HOURS the last
 *    alert is reopened, not a new one created, so a PC bouncing around the
 *    ceiling (restart, leak again, restart) notifies the owner once.
 */
@Injectable()
export class ResourceHealthService {
  private readonly logger = new Logger(ResourceHealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    device: Device,
    next: DeviceResources | null,
    now = new Date(),
  ): Promise<void> {
    // an agent older than the report: nothing to say
    if (next === null) return;

    const wasOver = isOverCeiling(readResources(device.resources));
    const isOver = isOverCeiling(next);
    if (wasOver === isOver) return;

    if (isOver) await this.raise(device, next, now);
    else await this.resolve(device.id, now);
  }

  private async raise(
    device: Device,
    report: DeviceResources,
    now: Date,
  ): Promise<void> {
    const detail = `Over the agent's resource ceiling: ${describeResources(report)}`;

    // ⚠️ Two heartbeats racing must not both see "no alert yet" and both
    //    create one (same guard as clock drift and capabilities).
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${RESOURCE_LOCK}::int, ${device.id}::int)::text AS locked`;

      const recent = await tx.alert.findFirst({
        where: {
          type: 'agent_resources',
          deviceId: device.id,
          acknowledgedAt: null,
          OR: [
            { resolvedAt: null },
            {
              createdAt: {
                gte: new Date(now.getTime() - THROTTLE_HOURS * 3_600_000),
              },
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

      const meta = { resources: report } as unknown as Prisma.InputJsonValue;

      if (recent) {
        await tx.alert.update({
          where: { id: recent.id },
          data: { detail, resolvedAt: null, meta },
        });
        return false;
      }

      await tx.alert.create({
        data: {
          type: 'agent_resources',
          severity: 'warning',
          deviceId: device.id,
          employeeId: device.employeeId,
          title: `The agent on ${device.hostname} is using too many resources`,
          detail,
          meta,
          channelsSent: [],
        },
      });
      return true;
    });

    if (created) {
      this.logger.warn(`device ${device.id}: ${detail} — raising an alert`);
    }
  }

  private async resolve(deviceId: number, now: Date): Promise<void> {
    await this.prisma.alert.updateMany({
      where: { type: 'agent_resources', deviceId, resolvedAt: null },
      data: { resolvedAt: now, resolvedReason: 'back under the resource ceiling' },
    });
  }
}
