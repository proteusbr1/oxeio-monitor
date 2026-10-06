import { statfs } from 'node:fs/promises';
import { parse, resolve } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { storageRoot } from '../common/storage.config';
import {
  SCREENSHOT_STORAGE,
  type ScreenshotStorage,
} from '../storage/screenshot-storage';
import { DISK_CRITICAL_PCT, DISK_WARN_PCT } from './alerts.constants';
import { diskUsedPct, diskVerdict, humanBytes } from './alerts.rules';
import { AlertsService } from './alerts.service';

/**
 * G03: warn when the server's own disk is 80% / 95% full.
 *
 * It watches the drive where screenshots accumulate (`STORAGE_ROOT`), not the
 * system drive. With 15 people's pictures coming in every day, that drive is
 * the one that fills up, and when it does the result is not merely "pictures
 * are not saved": agent uploads fail, ingest stalls and hours go uncounted. So
 * it is wrong to treat this as an ordinary housekeeping alert.
 */
@Injectable()
export class DiskCheck {
  private readonly logger = new Logger(DiskCheck.name);
  private readonly storageRoot: string;
  /** The unreadable-path complaint is logged once, not every 15 minutes */
  private warnedUnreadable = false;

  constructor(
    private readonly alerts: AlertsService,
    config: ConfigService,
    @Inject(SCREENSHOT_STORAGE) private readonly storage: ScreenshotStorage,
  ) {
    this.storageRoot = resolve(
      storageRoot(config),
    );
  }

  async runOnce(now = new Date()): Promise<number> {
    const stats = await this.readStats();
    if (!stats) return 0;

    const usedPct = diskUsedPct(stats);
    const verdict = diskVerdict(usedPct);
    if (!verdict) return 0;

    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const rounded = Math.round(usedPct * 10) / 10;

    return this.alerts.raiseMany(
      [
        {
          type: verdict.type,
          severity: verdict.severity,
          // Disk is not about a device or an employee: both null, so the
          // throttle key holds only the type (one per server).
          deviceId: null,
          employeeId: null,
          title:
            verdict.severity === 'critical'
              ? `Disk almost full — ${rounded}%`
              : `Disk ${rounded}% full`,
          detail:
            `${this.storageRoot} has ${humanBytes(freeBytes)} free ` +
            `(of ${humanBytes(totalBytes)}). ` +
            // With screenshots in a bucket this disk holds the database and
            // the backups, not the images, so the advice has to say so
            (this.storage.driver === 's3'
              ? verdict.severity === 'critical'
                ? `Past ${DISK_CRITICAL_PCT}% — screenshots are in ${this.storage.location}, so this is the database and the backups. Remove old backups now.`
                : `Past ${DISK_WARN_PCT}% — screenshots are in ${this.storage.location}; check the backups folder and the database size.`
              : verdict.severity === 'critical'
                ? `Past ${DISK_CRITICAL_PCT}% — once space runs out both screenshot upload and ingest will stall. Remove old backups now.`
                : `Past ${DISK_WARN_PCT}% — check that the retention job is running properly.`),
          meta: {
            path: this.storageRoot,
            usedPct: rounded,
            freeBytes,
            totalBytes,
          },
        },
      ],
      now,
    );
  }

  /**
   * If `STORAGE_ROOT` has not been created yet, `statfs` throws. In that case
   * the drive root is checked: the number is for the same volume, and raising
   * the alert is the real goal. If both fail it **stops quietly**: being
   * unable to read the disk is not an alertable event, and throwing from here
   * would kill the timer and stop the other checks too.
   */
  private async readStats(): Promise<{
    blocks: number;
    bfree: number;
    bavail: number;
    bsize: number;
  } | null> {
    for (const path of [this.storageRoot, parse(this.storageRoot).root]) {
      if (!path) continue;
      try {
        const fs = await statfs(path);
        return {
          blocks: Number(fs.blocks),
          bfree: Number(fs.bfree),
          bavail: Number(fs.bavail),
          bsize: Number(fs.bsize),
        };
      } catch {
        continue;
      }
    }

    if (!this.warnedUnreadable) {
      this.warnedUnreadable = true;
      this.logger.warn(
        `Could not read disk info (${this.storageRoot}) — the G03 check is not running`,
      );
    }
    return null;
  }
}
