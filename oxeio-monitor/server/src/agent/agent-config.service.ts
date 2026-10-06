import { createHash } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import type { Device } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { LOCAL_OFFSET_MIN, WORK_TIMEZONE } from './util/work-time';

export interface AgentConfig {
  idleThresholdSec: number;
  slotMinutes: number;
  /** 'HH:MM' - when null, screenshots are taken around the clock (ADR-011c). */
  screenshotFrom: string | null;
  screenshotTo: string | null;
  timezone: string;
  /**
   * Minutes east of UTC for `timezone` (Asia/Dhaka = 360). Sent as a number
   * so the agent does not need a tz database: the server only accepts zones
   * without DST, so one fixed offset is the whole story.
   */
  utcOffsetMinutes: number;
  monthlyTargetHours: number;
  heartbeatSec: number;
  appTracking: { enabled: boolean; minDurationSec: number };
  screenshot: {
    /**
     * false = the policy turned screenshots off. The agent still samples the
     * screen for the jiggler check; older agents ignore the field and keep
     * taking screenshots.
     */
    enabled: boolean;
    format: 'webp';
    quality: number;
    maxWidth: number;
    allMonitors: boolean;
  };
}

@Injectable()
export class AgentConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The config the agent runs with. It comes from the work policy, so a
   * threshold changed on the dashboard reaches all 15 PCs on the next config sync.
   */
  async build(policyId: number | null): Promise<{
    version: string;
    config: AgentConfig;
  }> {
    const policy = policyId
      ? await this.prisma.workPolicy.findUnique({ where: { id: policyId } })
      : await this.prisma.workPolicy.findFirst({ where: { isActive: true } });

    if (!policy) throw new NotFoundException('No active work policy found');

    const config: AgentConfig = {
      idleThresholdSec: policy.idleThresholdSec,
      slotMinutes: policy.slotMinutes,
      screenshotFrom: policy.screenshotFrom,
      screenshotTo: policy.screenshotTo,
      // The server's zone, not `policy.timezone`: every work date the server
      // computes uses WORK_TIMEZONE, and the agent must cut days the same way
      timezone: WORK_TIMEZONE,
      utcOffsetMinutes: LOCAL_OFFSET_MIN,
      monthlyTargetHours: Number(policy.monthlyTargetHours),
      heartbeatSec: 30,
      appTracking: { enabled: true, minDurationSec: 5 },
      screenshot: {
        enabled: policy.screenshotsEnabled,
        format: 'webp',
        quality: 70,
        maxWidth: 1920,
        allMonitors: true,
      },
    };

    return { version: this.versionOf(config), config };
  }

  /** The policy the device's staff member is on; the active default if none. */
  async buildForDevice(
    device: Device,
  ): Promise<{ version: string; config: AgentConfig }> {
    if (device.employeeId === null) return this.build(null);

    const employee = await this.prisma.employee.findUnique({
      where: { id: device.employeeId },
      select: { policyId: true },
    });
    return this.build(employee?.policyId ?? null);
  }

  /**
   * The config's hash is its version, so no separate column or counter is needed.
   * The agent sends its version in the heartbeat; on a mismatch a `reload_config`
   * command is sent.
   */
  private versionOf(config: AgentConfig): string {
    return createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);
  }
}
