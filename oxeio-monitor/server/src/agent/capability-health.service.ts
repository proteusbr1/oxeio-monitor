import { Injectable, Logger } from '@nestjs/common';
import type { Device, Prisma } from '@prisma/client';

import { THROTTLE_HOURS } from '../alerts/alerts.constants';
import { PrismaService } from '../prisma/prisma.service';
import {
  describeFailed,
  failedCapabilities,
  sameCapabilities,
  sanitizeCapabilities,
  type Capabilities,
} from './capabilities.rules';

/** pg_advisory_xact_lock namespace — next to clock drift's 8_413_001 */
const CAPABILITY_LOCK = 8_413_002;

/**
 * Keeps the agent's capability report and turns a part that is down into an
 * alert.
 *
 * ⚠️ Written only when the report changes. It is sent with every heartbeat
 *    (15 devices × every 30 s), and almost always says the same thing.
 * ⚠️ Only `failed` alerts (`failedCapabilities`). `degraded` is shown on the
 *    device list and nowhere else — it covers passing states, and alerting on
 *    them would page the owner all day.
 * ⚠️ One alert per device, however many parts are down: the alert says "this
 *    PC needs a look", the device list says which part. It is resolved when
 *    no part is `failed` any more.
 * ⚠️ A part that keeps failing and recovering must not send a new alert each
 *    time: within THROTTLE_HOURS the last alert is reopened instead of a new
 *    one created. It was already delivered, so nobody is notified again.
 */
@Injectable()
export class CapabilityHealthService {
  private readonly logger = new Logger(CapabilityHealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(device: Device, raw: unknown, now = new Date()): Promise<void> {
    const next = sanitizeCapabilities(raw);
    // an agent older than the report — keep what we had, raise nothing
    if (next === null) return;

    const before = sanitizeCapabilities(device.capabilities);
    if (sameCapabilities(before, next)) return;

    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        capabilities: next as Prisma.InputJsonValue,
        capabilitiesAt: now,
      },
    });

    if (failedCapabilities(next).length === 0) {
      await this.resolve(device.id, now);
    } else {
      await this.raise(device, next, now);
    }
  }

  private async raise(
    device: Device,
    report: Capabilities,
    now: Date,
  ): Promise<void> {
    const detail = `Not working: ${describeFailed(report)}`;

    // ⚠️ Same guard as clock drift: two heartbeats racing must not both see
    //    "no alert yet" and both create one.
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${CAPABILITY_LOCK}::int, ${device.id}::int)::text AS locked`;

      // open, or created within the throttle window — either way the owner
      // has already been told about this PC
      const recent = await tx.alert.findFirst({
        where: {
          type: 'agent_capability',
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

      if (recent) {
        // keep it current, and reopen it if it had been resolved
        await tx.alert.update({
          where: { id: recent.id },
          data: {
            detail,
            resolvedAt: null,
            meta: { capabilities: report } as Prisma.InputJsonValue,
          },
        });
        return false;
      }

      await tx.alert.create({
        data: {
          type: 'agent_capability',
          severity: 'warning',
          deviceId: device.id,
          employeeId: device.employeeId,
          title: `Part of the agent is not working on ${device.hostname}`,
          detail,
          meta: { capabilities: report } as Prisma.InputJsonValue,
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
      where: { type: 'agent_capability', deviceId, resolvedAt: null },
      data: { resolvedAt: now },
    });
  }
}
