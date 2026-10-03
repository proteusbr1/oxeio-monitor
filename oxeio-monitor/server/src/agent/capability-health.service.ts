import { Injectable, Logger } from '@nestjs/common';
import type { Device, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  brokenCapabilities,
  describeBroken,
  sameCapabilities,
  sanitizeCapabilities,
  type Capabilities,
} from './capabilities.rules';

/** pg_advisory_xact_lock namespace — next to clock drift's 8_413_001 */
const CAPABILITY_LOCK = 8_413_002;

/**
 * Keeps the agent's capability report and turns a broken part into an alert.
 *
 * ⚠️ Written only when the report changes. It is sent with every heartbeat
 *    (15 devices × every 30 s), and almost always says the same thing.
 * ⚠️ One open alert per device, however many parts are broken: the alert
 *    says "this PC needs a look", the device page says which part. It is
 *    resolved when every part is back to ok or off by policy.
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

    const broken = brokenCapabilities(next);
    if (broken.length === 0) {
      await this.resolve(device.id, now);
    } else {
      await this.raise(device, next);
    }
  }

  private async raise(device: Device, report: Capabilities): Promise<void> {
    const detail = describeBroken(report);

    // ⚠️ Same guard as clock drift: two heartbeats racing must not both see
    //    "no open alert" and both create one.
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${CAPABILITY_LOCK}::int, ${device.id}::int)::text AS locked`;

      const open = await tx.alert.findFirst({
        where: {
          type: 'agent_capability',
          deviceId: device.id,
          acknowledgedAt: null,
          resolvedAt: null,
        },
        select: { id: true },
      });

      if (open) {
        // already told; keep the alert current with what is broken now
        await tx.alert.update({
          where: { id: open.id },
          data: {
            detail,
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
