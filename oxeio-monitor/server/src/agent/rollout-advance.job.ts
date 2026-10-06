import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  JOB_TIMEZONE,
  RunLock,
  SCHEDULING_ENABLED,
} from '../summary/scheduling';
import {
  ROLLOUT_FRESH_MINUTES,
  ROLLOUT_SOAK_HOURS,
  stageToAdvanceTo,
  type DeviceProof,
} from './rollout';

export interface RolloutAdvanceResult {
  version: string | null;
  from: string | null;
  to: string | null;
  /** How many devices run this version (whether or not they give proof). */
  onVersion: number;
  skipped: boolean;
}

/**
 * **H04 - the rollout advances by itself.**
 *
 * The owner reported that staff were not getting the updates and every single
 * PC had to be installed manually.
 *
 * Careful: **the cause was not a bug but a missing step.** All the machinery of
 * a staged rollout existed (buckets, percentages, pilot, emergency brake), but
 * the only way to move `canary -> partial -> all` was a **manual click** in
 * Settings. If nobody clicked, a new version would sit at 7% forever, so 11 of
 * 12 PCs would never even be offered it, and the only way left would be to go
 * to each machine and install by hand.
 *
 * This is the most familiar pattern in this project, again: **the contract is
 * written, the caller is not.**
 *
 * Careful: **this job does not remove the G58 safety.** The stage advances only
 * when a **real machine** has run the new build for six hours and is **still
 * responding**. So the meaning of canary is intact; its outcome just no longer
 * waits for somebody's click.
 *
 * Careful: `halted` never opens by itself; the emergency brake cannot be left to
 * anything automatic (see the note in `nextStage()`).
 */
@Injectable()
export class RolloutAdvanceJob {
  private readonly logger = new Logger(RolloutAdvanceJob.name);
  private readonly lock = new RunLock();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Careful: once an hour, at minute 7, not on the round hour. The other jobs
   *    (`:00`, `:15`) run on round times; it is better not to add load at the
   *    same moment, and it also makes it easy to tell whose lines are whose when
   *    reading the log.
   *
   * Careful: once an hour is enough: the soak is six hours, so there is nothing
   *    to check more often. In the worst case a stage therefore advances after
   *    six hours and one minute.
   */
  @Cron('0 7 * * * *', {
    name: 'rollout-advance',
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    // Careful: the second lock; the reason is explained in `summary-refresh.job.ts`.
    if (!SCHEDULING_ENABLED) return;
    await this.runOnce();
  }

  async runOnce(now: Date = new Date()): Promise<RolloutAdvanceResult> {
    const idle: RolloutAdvanceResult = {
      version: null,
      from: null,
      to: null,
      onVersion: 0,
      skipped: false,
    };

    const result = await this.lock.run(async () => {
      /**
       * **Exactly the version that `UpdateService.offerFor()` offers**: the
       * newest non-halted one. Careful: advancing the stage of any older version
       * means nothing, since nobody is offered it, so the change would be silent
       * and confusing.
       */
      const latest = await this.prisma.agentVersion.findFirst({
        where: { rolloutStage: { not: 'halted' } },
        orderBy: { releasedAt: 'desc' },
      });

      if (latest === null) return idle;

      /**
       * Careful: devices are **filtered by status**; a revoked PC's heartbeat is
       *    no proof. Careful: `agentVersion` is matched exactly; a machine still
       *    on an older build says nothing about this build.
       */
      const devices = await this.prisma.device.findMany({
        where: { status: 'active', agentVersion: latest.version },
        select: { agentVersionSince: true, lastSeenAt: true },
      });

      const proofs: DeviceProof[] = devices.map((d) => ({
        versionSince: d.agentVersionSince,
        lastSeenAt: d.lastSeenAt,
      }));

      // The decision is not made here but in the pure function in `rollout.ts`.
      /**
       * **The time of the stage change is passed too**, as the floor of the soak
       * clock. Careful: without it, a machine that had passed six hours on canary
       * would push `partial -> all` on the very next tick as well, and the 50%
       * stage would effectively be skipped.
       */
      const to = stageToAdvanceTo(
        latest.rolloutStage,
        proofs,
        now,
        ROLLOUT_SOAK_HOURS,
        latest.stageChangedAt,
      );

      if (to === null) {
        return { ...idle, version: latest.version, onVersion: devices.length };
      }

      const updated = await this.prisma.agentVersion.update({
        where: { version: latest.version },
        // Careful: the clock is reset **here**; otherwise the next stage would
        //    advance immediately too, and the stages would all pass in one tick.
        data: { rolloutStage: to, stageChangedAt: now },
      });

      /**
       * **It is written to the audit log, and that is not optional.** Changing
       * the stage used to be always a person's action, so a name was on record.
       * If a machine did it now, the log would be empty, and someone would see
       * "7% yesterday, 100% today" with no answer to who or what did it.
       *
       * Careful: why it advanced is recorded too (`onVersion`); otherwise there
       * would be nothing to answer with when asked later.
       */
      await this.audit.record({
        // Careful: `null`; no person pressed anything, and there is nothing to hide.
        userId: null,
        action: 'agent_version.rollout_auto',
        targetType: 'agent_version',
        targetId: latest.version,
        meta: {
          from: latest.rolloutStage,
          to: updated.rolloutStage,
          onVersion: devices.length,
          soakHours: ROLLOUT_SOAK_HOURS,
          freshMinutes: ROLLOUT_FRESH_MINUTES,
        },
      });

      this.logger.log(
        `agent ${latest.version} rollout ${latest.rolloutStage} → ${updated.rolloutStage} ` +
          `· ${devices.length} device(s) on this build`,
      );

      return {
        version: latest.version,
        from: latest.rolloutStage,
        to: updated.rolloutStage,
        onVersion: devices.length,
        skipped: false,
      };
    });

    if (result === null) {
      this.logger.warn('Previous rollout check still going — skipping this tick');
      return { ...idle, skipped: true };
    }

    return result;
  }
}
