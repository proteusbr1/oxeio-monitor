import { statfs } from 'node:fs/promises';
import { parse, resolve } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { diskUsedPct, humanBytes } from '../alerts/alerts.rules';
import { storageRoot } from '../common/storage.config';
import { PrismaService } from '../prisma/prisma.service';
import {
  SCREENSHOT_STORAGE,
  type ScreenshotStorage,
} from '../storage/screenshot-storage';
import { BackupService } from './backup.service';
import { BackupStateStore } from './backup.state';
import { HEALTH_SILENCE_MIN } from './ops.constants';
import {
  backupVerdict,
  healthVerdict,
  type BackupVerdict,
  type HealthStatus,
} from './ops.rules';

export interface OpsHealth {
  status: HealthStatus;
  /** Empty array = everything is fine */
  problems: string[];
  checkedAt: string;
  uptimeSec: number;

  db: { up: boolean; latencyMs: number | null };

  /** Where screenshots live — `local` (this disk) or `s3` (a bucket) */
  screenshotStorage: { driver: 'local' | 's3'; location: string; reachable: boolean };
  disk: {
    path: string;
    usedPct: number | null;
    freeBytes: number | null;
    totalBytes: number | null;
    free: string | null;
    total: string | null;
  };

  backup: {
    /** `external` = backed up outside oXeio; the fields below are then unused */
    mode: 'internal' | 'external';
    configured: boolean;
    copyConfigured: boolean;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastOutcome: 'ok' | 'failed' | null;
    lastError: string | null;
    lastFile: string | null;
    lastSizeBytes: number | null;
    lastSize: string | null;
    consecutiveFailures: number;
    hoursSinceSuccess: number | null;
    copyOutcome: 'ok' | 'failed' | null;
    copyError: string | null;
    /** The very verdict G04 uses when it raises the alert */
    problem: BackupVerdict['problem'] | null;
  };

  devices: {
    active: number;
    /** Only counted; does not worsen status, since everyone being silent at night is normal */
    silent: number;
    silenceThresholdMin: number;
  };

  queue: {
    /** Not yet sent on any channel */
    pendingAlerts: number;
    /** Not yet acknowledged */
    openAlerts: number;
    /** Marked by retention, file/row not yet gone */
    screenshotsAwaitingPurge: number;
  };
}

/**
 * **K04**: the server's detailed health (owner-only).
 *
 * `src/health/` (`GET /api/v1/health`) is untouched: that is **liveness**:
 * public, small, fast, and the Docker healthcheck and Live Board rest on it.
 * The reply here has disk size, backup history and how many devices are
 * silent, all information from which an outsider could draw a picture of the
 * inside of the office. Merging the two would either hide liveness (Docker could
 * no longer healthcheck) or make this information public.
 */
@Injectable()
export class OpsHealthService {
  private readonly logger = new Logger(OpsHealthService.name);
  private readonly storageRoot: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: BackupStateStore,
    private readonly backup: BackupService,
    config: ConfigService,
    @Inject(SCREENSHOT_STORAGE) private readonly storage: ScreenshotStorage,
  ) {
    this.storageRoot = resolve(storageRoot(config));
  }

  async check(now = new Date()): Promise<OpsHealth> {
    const db = await this.pingDb();

    // If the DB cannot be read there is no point running the other queries: they
    // would fail with the same error and the health endpoint itself would 500, so
    // there is no answer at exactly the moment someone asks "what happened to the server".
    const counts = db.up
      ? await this.counts(now)
      : { active: 0, silent: 0, pendingAlerts: 0, openAlerts: 0, awaitingPurge: 0 };

    const disk = await this.readDisk();
    const storeReachable = await this.storage.reachable();
    const snapshot = await this.state.read(this.backup.configured);
    // external backups are not this server's to judge (BACKUP_MODE)
    const backupMode = await this.backup.mode();
    const verdict = backupMode === 'external' ? null : backupVerdict(snapshot, now);

    const verdictSummary = healthVerdict({
      dbUp: db.up,
      diskUsedPct: disk.usedPct,
      backup: verdict,
      activeDevices: counts.active,
      silentDevices: counts.silent,
      pendingAlerts: counts.pendingAlerts,
      ...(this.storage.driver === 's3'
        ? {
            screenshotStore: {
              location: this.storage.location,
              reachable: storeReachable,
            },
          }
        : {}),
    });

    return {
      status: verdictSummary.status,
      problems: verdictSummary.problems,
      checkedAt: now.toISOString(),
      uptimeSec: Math.floor(process.uptime()),
      db,
      screenshotStorage: {
        driver: this.storage.driver,
        location: this.storage.location,
        reachable: storeReachable,
      },
      disk: {
        path: this.storageRoot,
        usedPct: disk.usedPct,
        freeBytes: disk.freeBytes,
        totalBytes: disk.totalBytes,
        free: disk.freeBytes === null ? null : humanBytes(disk.freeBytes),
        total: disk.totalBytes === null ? null : humanBytes(disk.totalBytes),
      },
      backup: {
        mode: backupMode,
        configured: snapshot.configured,
        copyConfigured: this.backup.copyTarget !== null,
        lastSuccessAt: snapshot.lastSuccessAt?.toISOString() ?? null,
        lastAttemptAt: snapshot.lastAttemptAt?.toISOString() ?? null,
        lastOutcome: snapshot.lastOutcome,
        lastError: snapshot.lastError,
        lastFile: snapshot.lastSuccessFile,
        lastSizeBytes: snapshot.lastSuccessBytes,
        lastSize:
          snapshot.lastSuccessBytes === null
            ? null
            : humanBytes(snapshot.lastSuccessBytes),
        consecutiveFailures: snapshot.consecutiveFailures,
        hoursSinceSuccess: verdict?.hoursSinceSuccess ?? hoursSince(snapshot.lastSuccessAt, now),
        copyOutcome: snapshot.lastCopyOutcome,
        copyError: snapshot.lastCopyError,
        problem: verdict?.problem ?? null,
      },
      devices: {
        active: counts.active,
        silent: counts.silent,
        silenceThresholdMin: HEALTH_SILENCE_MIN,
      },
      queue: {
        pendingAlerts: counts.pendingAlerts,
        openAlerts: counts.openAlerts,
        screenshotsAwaitingPurge: counts.awaitingPurge,
      },
    };
  }

  /** Latency is kept too: "the DB is up but takes 8 seconds" cannot be expressed
   *  with `up: true`, yet it is the most common kind of slowness. */
  private async pingDb(): Promise<{ up: boolean; latencyMs: number | null }> {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { up: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      this.logger.error(
        `Health: DB ping failed — ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      return { up: false, latencyMs: null };
    }
  }

  private async counts(now: Date): Promise<{
    active: number;
    silent: number;
    pendingAlerts: number;
    openAlerts: number;
    awaitingPurge: number;
  }> {
    const silenceFloor = new Date(now.getTime() - HEALTH_SILENCE_MIN * 60_000);

    const [active, silent, pendingAlerts, openAlerts, awaitingPurge] =
      await Promise.all([
        this.prisma.device.count({ where: { status: 'active' } }),
        this.prisma.device.count({
          where: {
            status: 'active',
            // Devices with `lastSeenAt: null` are silent too: enrolled but never
            // sent anything. G01 does not alert on them, but health should count
            // them: "3 of 15 never spoke" is news about the installation.
            OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: silenceFloor } }],
          },
        }),
        this.prisma.alert.count({ where: { channelsSent: { isEmpty: true } } }),
        // Twin of alerts.service's openCount. "open" = acknowledgedAt and
        // resolvedAt both NULL; otherwise alerts the server closed itself would
        // make the number wrong on the health page (even if the other page is right).
        this.prisma.alert.count({ where: { acknowledgedAt: null, resolvedAt: null } }),
        this.prisma.screenshot.count({ where: { deletedAt: { not: null } } }),
      ]);

    return { active, silent, pendingAlerts, openAlerts, awaitingPurge };
  }

  /**
   * Same technique as `disk.check.ts`: without `STORAGE_ROOT`, the drive root is
   * looked at (same volume, same number). If both fail, `null`; the health page
   * then says "disk info could not be read" instead of returning a 500.
   */
  private async readDisk(): Promise<{
    usedPct: number | null;
    freeBytes: number | null;
    totalBytes: number | null;
  }> {
    for (const path of [this.storageRoot, parse(this.storageRoot).root]) {
      if (!path) continue;
      try {
        const fs = await statfs(path);
        const stats = {
          blocks: Number(fs.blocks),
          bfree: Number(fs.bfree),
          bavail: Number(fs.bavail),
          bsize: Number(fs.bsize),
        };
        return {
          usedPct: Math.round(diskUsedPct(stats) * 10) / 10,
          freeBytes: stats.bavail * stats.bsize,
          totalBytes: stats.blocks * stats.bsize,
        };
      } catch {
        continue;
      }
    }
    return { usedPct: null, freeBytes: null, totalBytes: null };
  }
}

function hoursSince(at: Date | null, now: Date): number | null {
  if (!at) return null;
  return Math.floor((now.getTime() - at.getTime()) / 3_600_000);
}
