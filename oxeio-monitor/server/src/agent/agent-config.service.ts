import { createHash } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import type { Device } from '@prisma/client';

import { FeaturesService } from '../features/features.service';
import { PrismaService } from '../prisma/prisma.service';
import { WORK_TIMEZONE, workOffsetMinutesAt, workZoneTransitions } from './util/work-time';

export interface AgentConfig {
  idleThresholdSec: number;
  slotMinutes: number;
  /** 'HH:MM' - when null, screenshots are taken around the clock (ADR-011c). */
  screenshotFrom: string | null;
  screenshotTo: string | null;
  timezone: string;
  /**
   * Minutes east of UTC for `timezone` **right now** (e.g. Asia/Kolkata = 330).
   * Agents before 0.5 know only this number. It is part of the config hash, so
   * when daylight saving changes it those agents are told to reload.
   */
  utcOffsetMinutes: number;
  /**
   * The offset in force from the start of last month, then each change for
   * about a year ahead: newer agents cut days exactly where the server does,
   * daylight saving included, without the PC's own time-zone data. Changes
   * once a month (the window moves), which is one config reload a month.
   */
  zoneTransitions: { at: string; offsetMinutes: number }[];
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
  constructor(
    private readonly prisma: PrismaService,
    // Settings → Modules: Screenshots and Apps & websites stop the capture itself
    private readonly features: FeaturesService,
  ) {}

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
    const modules = await this.features.all();

    const config: AgentConfig = {
      idleThresholdSec: policy.idleThresholdSec,
      slotMinutes: policy.slotMinutes,
      screenshotFrom: policy.screenshotFrom,
      screenshotTo: policy.screenshotTo,
      // The server's zone, not `policy.timezone`: every work date the server
      // computes uses WORK_TIMEZONE, and the agent must cut days the same way
      timezone: WORK_TIMEZONE,
      utcOffsetMinutes: workOffsetMinutesAt(new Date()),
      zoneTransitions: transitionWindow(new Date()),
      monthlyTargetHours: Number(policy.monthlyTargetHours),
      heartbeatSec: 30,
      appTracking: { enabled: modules.appTracking, minDurationSec: 5 },
      screenshot: {
        // the agent still samples the screen (idle detection needs it); only pictures stop
        enabled: modules.screenshots && policy.screenshotsEnabled,
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

/**
 * From the first day of last month (UTC) to 13 months after it. Anchored to
 * the month, not to "now", so the config hash — and with it the agents'
 * reload — changes once a month instead of on every request.
 */
export function transitionWindow(now: Date): { at: string; offsetMinutes: number }[] {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 12, 1));
  return workZoneTransitions(from, to).map((t) => ({
    at: t.at.toISOString(),
    offsetMinutes: t.offsetMinutes,
  }));
}
