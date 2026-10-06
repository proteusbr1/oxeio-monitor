import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { BackupState } from './ops.rules';

/**
 * This single row in the `settings` table holds the whole backup history.
 * Changing the schema is not allowed, and not needed: the question is small
 * ("when did it last succeed?"), so one key/value row is enough.
 */
export const BACKUP_STATE_KEY = 'ops.backup.state';

/** How it is stored on disk (in JSON): always ISO strings */
interface StoredBackupState {
  lastAttemptAt?: string | null;
  lastOutcome?: 'ok' | 'failed' | null;
  lastError?: string | null;
  lastSuccessAt?: string | null;
  lastSuccessFile?: string | null;
  lastSuccessBytes?: number | null;
  consecutiveFailures?: number;
  lastCopyOutcome?: 'ok' | 'failed' | null;
  lastCopyError?: string | null;
  lastCopyAt?: string | null;
  observedSince?: string | null;
}

/** Everything the health page shows: the raw facts outside the verdict */
export interface BackupSnapshot extends BackupState {
  lastError: string | null;
  lastSuccessFile: string | null;
  lastSuccessBytes: number | null;
  lastCopyError: string | null;
  lastCopyAt: Date | null;
}

/**
 * Writing and reading the backup state: the **single** source of truth.
 *
 * K02 (job), K04 (health) and G04 (alert) all need to know "how did the last
 * backup go". If each dug through the backup folder on its own, the three
 * answers would differ, and the worst case is a green health page while the
 * alert says there is no backup. Then nobody could decide which to trust, and
 * people usually trust the green one.
 */
@Injectable()
export class BackupStateStore {
  private readonly logger = new Logger(BackupStateStore.name);

  /**
   * When the process started: the last resort for `observedSince`. Without it a
   * freshly installed server would shout "no backup has ever run" in its first minute.
   */
  private readonly bootedAt = new Date();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Never throws. This function is called by both the health endpoint and the
   * alert check; if the settings table cannot be read, saying "no news of a
   * backup" is enough, and there is no reason for the whole health page to 500.
   */
  async read(configured: boolean): Promise<BackupSnapshot> {
    const stored = await this.load();

    return {
      configured,
      lastAttemptAt: toDate(stored.lastAttemptAt),
      lastOutcome: stored.lastOutcome ?? null,
      lastError: stored.lastError ?? null,
      lastSuccessAt: toDate(stored.lastSuccessAt),
      lastSuccessFile: stored.lastSuccessFile ?? null,
      lastSuccessBytes: stored.lastSuccessBytes ?? null,
      consecutiveFailures: stored.consecutiveFailures ?? 0,
      lastCopyOutcome: stored.lastCopyOutcome ?? null,
      lastCopyError: stored.lastCopyError ?? null,
      lastCopyAt: toDate(stored.lastCopyAt),
      observedSince: toDate(stored.observedSince) ?? this.bootedAt,
    };
  }

  /**
   * Records the result of one run.
   *
   * `consecutiveFailures` is counted here: 0 on success, +1 on failure. G04's
   * severity rises and falls entirely on this one number, so the counting
   * lives in one place; incrementing in two places would count two failed
   * nights in a row as four and fire critical on the very first night.
   */
  async record(outcome: {
    at: Date;
    ok: boolean;
    error?: string | null;
    fileName?: string | null;
    sizeBytes?: number | null;
    copy?: { ok: boolean; error?: string | null } | null;
  }): Promise<void> {
    const prev = await this.load();

    const next: StoredBackupState = {
      ...prev,
      lastAttemptAt: outcome.at.toISOString(),
      lastOutcome: outcome.ok ? 'ok' : 'failed',
      // The message is truncated: pg_dump's stderr can be thousands of lines, and
      // if all of it piled up in settings every health call would pull it in.
      lastError: outcome.ok ? null : (outcome.error ?? 'unknown error').slice(0, 500),
      consecutiveFailures: outcome.ok ? 0 : (prev.consecutiveFailures ?? 0) + 1,
      observedSince: prev.observedSince ?? this.bootedAt.toISOString(),
    };

    if (outcome.ok) {
      next.lastSuccessAt = outcome.at.toISOString();
      next.lastSuccessFile = outcome.fileName ?? null;
      next.lastSuccessBytes = outcome.sizeBytes ?? null;
    }

    if (outcome.copy) {
      next.lastCopyOutcome = outcome.copy.ok ? 'ok' : 'failed';
      next.lastCopyError = outcome.copy.ok
        ? null
        : (outcome.copy.error ?? 'unknown error').slice(0, 500);
      next.lastCopyAt = outcome.at.toISOString();
    }

    await this.save(next);
  }

  /** The job was not run because there is no config; that too is a recordable event */
  async markObserved(): Promise<void> {
    const prev = await this.load();
    if (prev.observedSince) return;
    await this.save({ ...prev, observedSince: this.bootedAt.toISOString() });
  }

  private async load(): Promise<StoredBackupState> {
    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: BACKUP_STATE_KEY },
        select: { value: true },
      });
      if (!row || typeof row.value !== 'object' || row.value === null) {
        return {};
      }
      return row.value as StoredBackupState;
    } catch (err) {
      this.logger.error(
        `Could not read backup state: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      return {};
    }
  }

  private async save(state: StoredBackupState): Promise<void> {
    const value = state as unknown as Prisma.InputJsonValue;
    try {
      await this.prisma.setting.upsert({
        where: { key: BACKUP_STATE_KEY },
        create: { key: BACKUP_STATE_KEY, value },
        update: { value },
      });
    } catch (err) {
      // The backup has already happened even if this write fails; throwing here
      // would log a successful backup as "failed".
      this.logger.error(
        `Could not write backup state: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
}

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
