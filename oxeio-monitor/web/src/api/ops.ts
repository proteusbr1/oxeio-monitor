import { api } from './client';

/**
 * Server health and manually triggered jobs (K02, K04).
 *
 * Server source: `server/src/ops/ops.health.service.ts` and `ops.controller.ts`.
 *
 * Careful: everything here is owner-only, at class level. The response has disk
 * size, backup history and how many devices are silent; together they sketch the
 * office's infrastructure, so even managers do not get in.
 *
 * Do not confuse this with `GET /health`, which is the public liveness check
 * (the Docker healthcheck and the Live Board depend on it).
 */

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface OpsHealth {
  status: HealthStatus;
  /** Empty array = all fine. */
  problems: string[];
  checkedAt: string;
  uptimeSec: number;

  db: { up: boolean; latencyMs: number | null };

  disk: {
    path: string;
    usedPct: number | null;
    freeBytes: number | null;
    totalBytes: number | null;
    free: string | null;
    total: string | null;
  };

  backup: {
    /**
     * `external` = BACKUP_MODE=external: the database is backed up outside
     * oXeio and this server neither runs nor watches it. Optional for older
     * servers (= internal).
     */
    mode?: 'internal' | 'external';
    configured: boolean;
    copyConfigured: boolean;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastOutcome: 'ok' | 'failed' | null;
    lastError: string | null;
    lastSize: string | null;
    consecutiveFailures: number;
    hoursSinceSuccess: number | null;
    copyOutcome: 'ok' | 'failed' | null;
    copyError: string | null;
    /**
     * Exactly the verdict G04 looks at when raising an alert. `null` = all fine.
     *
     * Careful: "says nothing on success". Silence is the good news here, and that
     * silence is what gives the news its value (`ops.rules.ts` section G04).
     */
    problem: 'not_configured' | 'failed' | 'never' | 'stale' | null;
  };

  devices: {
    active: number;
    /**
     * Careful: count only. Everyone being silent at night is normal, so status does not go bad.
     */
    silent: number;
    silenceThresholdMin: number;
  };

  queue: {
    pendingAlerts: number;
    openAlerts: number;
    screenshotsAwaitingPurge: number;
  };
}

export function getOpsHealth(signal?: AbortSignal): Promise<OpsHealth> {
  return api<OpsHealth>('/ops/health', { signal });
}

/** Careful: the response deliberately contains no file path or passphrase. */
export interface ManualBackupResult {
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
 * Why it exists: a backup that has never been tested is not a backup, it is a
 * guess. This lets you verify on install day instead of waiting for 02:30.
 */
export function runBackupNow(): Promise<ManualBackupResult> {
  return api<ManualBackupResult>('/ops/backup/run', { method: 'POST' });
}

export interface RetentionResult {
  cutoff: string | null;
  marked: number;
  filesDeleted: number;
  filesMissing: number;
  rowsDeleted: number;
  failed: number;
  unsafePaths: number;
  skipped: boolean;
}

/**
 * K01: the policy tells staff in writing that "screenshots are deleted
 * automatically after 90 days". The nightly cron exists, but unless it can be
 * seen working, that is a promise, not a mechanism.
 */
export function runRetentionNow(): Promise<RetentionResult> {
  return api<RetentionResult>('/ops/retention/run', { method: 'POST' });
}
