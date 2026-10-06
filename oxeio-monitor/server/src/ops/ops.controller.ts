import { Controller, Get, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { RetentionJob, type RetentionResult } from '../summary/retention.job';
import { BackupJob } from './backup.job';
import { OpsHealthService, type OpsHealth } from './ops.health.service';

/** Reply of a manually triggered backup. Careful: no paths or passphrases. */
export interface ManualBackupResponse {
  ok: boolean;
  skipped: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  durationMs: number;
  error: string | null;
  copy: { configured: boolean; ok: boolean; error: string | null };
  rotated: number;
}

/**
 * **K04** — `GET /api/v1/ops/health`.
 *
 * The whole controller is owner-only, at class level, so any endpoint added
 * later is owner-only automatically.
 *
 * Managers cannot enter here either. The reply has disk size, backup history
 * and how many devices are silent: device/audit-type information (spec § 4.3)
 * which, seen together, can be used to draw a picture of the office infrastructure.
 *
 * The Docker healthcheck does **not** come here; it uses `/api/v1/health`
 * (public, `src/health/`). Mixing the two up would either show the container
 * as unhealthy forever (403) or make this information public.
 */
@Roles(UserRole.owner)
@Controller('ops')
export class OpsController {
  private readonly logger = new Logger(OpsController.name);

  constructor(
    private readonly health: OpsHealthService,
    private readonly backup: BackupJob,
    private readonly retention: RetentionJob,
  ) {}

  @Get('health')
  check(): Promise<OpsHealth> {
    return this.health.check();
  }

  /**
   * `POST /api/v1/ops/backup/run`: take a backup right now.
   *
   * It exists because a backup that was never tested is not a backup, it is a
   * guess. Instead of waiting for 02:30, it can be verified on install day:
   * is pg_dump found, is the passphrase right, is the external drive writable.
   *
   * `RunLock` prevents two dumps at the same time, even if the button is pressed repeatedly.
   */
  @Post('backup/run')
  @HttpCode(HttpStatus.OK)
  async runBackup(
    @CurrentUser() actor: SessionUser,
  ): Promise<ManualBackupResponse> {
    this.logger.warn(`Manual backup triggered — user ${actor.userId}`);
    const result = await this.backup.runOnce();

    return {
      ok: result.ok,
      skipped: result.skipped,
      fileName: result.fileName,
      sizeBytes: result.sizeBytes,
      durationMs: result.durationMs,
      error: result.error,
      copy: {
        configured: result.copy.configured,
        ok: result.copy.ok,
        // `target` is left out on purpose: there is no need to send the server's
        // file path to the browser.
        error: result.copy.error,
      },
      rotated: result.rotated,
    };
  }

  /**
   * **K01**: `POST /api/v1/ops/retention/run`, delete screenshots older than
   * 90 days right now.
   *
   * **It exists for the same reason as the backup one:** the 02:00 cron is
   * there, but a job nobody has ever seen run is a promise, not a mechanism. For
   * this job it matters even more: the policy tells staff in writing that
   * "screenshots delete themselves after 90 days". If that did not happen it
   * would be a broken promise, noticed only when the disk fills up.
   *
   * With no screenshots older than 90 days nothing is deleted and `marked: 0`
   * comes back. That is normal, and it shows the job can run.
   *
   * `RunLock` prevents two runs at once; on a clash with the cron it returns
   * `skipped: true`.
   */
  @Post('retention/run')
  @HttpCode(HttpStatus.OK)
  async runRetention(
    @CurrentUser() actor: SessionUser,
  ): Promise<RetentionResult> {
    this.logger.warn(`Manual retention sweep triggered — user ${actor.userId}`);
    return this.retention.runOnce();
  }
}
