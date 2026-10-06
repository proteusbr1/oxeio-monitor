import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { WORK_TIMEZONE } from '../agent/util/work-time';
import {
  ERROR_REPORTING_SETTING_KEY,
  resolveErrorReporting,
  type ErrorReportingSaved,
} from '../error-reporting/error-reporting.rules';
import { OFFSITE_SETTING_KEY, resolveOffsite, type OffsiteSettings } from '../ops/offsite.settings';
import { PrismaService } from '../prisma/prisma.service';
import {
  ORGANIZATION_SETTING_KEY,
  resolveOrganization,
  type OrganizationSaved,
} from './organization';
import {
  BACKUP_SETTING_KEY,
  REGION_SETTING_KEY,
  UPDATE_KEY_SETTING_KEY,
  resolveBackupMode,
  resolveRegion,
  resolveUpdateKey,
  type RegionSaved,
  type RegionView,
} from './app-settings.rules';
import {
  STORAGE_SETTING_KEY,
  resolveStorage,
  type BackupKey,
  type StorageSaved,
} from './storage.settings';

/**
 * Dashboard-editable settings, read once and kept in memory.
 *
 * ⚠️ The cache is cleared on every save from this process, and this
 *    process is the only writer (one `api` container, 07 § 6.1) — so a save
 *    is seen at once, without a database read per request.
 */
@Injectable()
export class AppSettingsService {
  private readonly cache = new Map<string, unknown>();

  /** Drops the cache — for tests that empty the table underneath it */
  forget(): void {
    this.cache.clear();
  }

  constructor(private readonly prisma: PrismaService) {}

  async region(): Promise<RegionView> {
    const saved = await this.read<RegionSaved>(REGION_SETTING_KEY);
    return resolveRegion(saved, process.env, WORK_TIMEZONE);
  }

  async backupMode() {
    const saved = await this.read<{ mode?: string }>(BACKUP_SETTING_KEY);
    return resolveBackupMode(saved, process.env.BACKUP_MODE);
  }

  /** The company's name and country — setup wizard / Settings → Region, or ORG_NAME */
  async organization() {
    const saved = await this.read<OrganizationSaved>(ORGANIZATION_SETTING_KEY);
    return resolveOrganization(saved, process.env);
  }

  /** Sentry — Settings → Error reporting, or SENTRY_DSN in the .env */
  async errorReporting() {
    const saved = await this.read<ErrorReportingSaved>(ERROR_REPORTING_SETTING_KEY);
    return resolveErrorReporting(saved, process.env);
  }

  async updateKey() {
    const saved = await this.read<{ publicKey?: string | null }>(UPDATE_KEY_SETTING_KEY);
    return resolveUpdateKey(saved, process.env.AGENT_UPDATE_PUBLIC_KEY);
  }

  /** The offsite copy's Backblaze key (Settings → Backup), if there is one */
  async backupKey(): Promise<BackupKey | null> {
    const saved = await this.read<Partial<OffsiteSettings>>(OFFSITE_SETTING_KEY);
    const { settings } = resolveOffsite(saved, {
      keyId: process.env.B2_KEY_ID,
      appKey: process.env.B2_APP_KEY,
      bucket: process.env.B2_BUCKET,
    });
    return settings ? { keyId: settings.keyId, appKey: settings.appKey } : null;
  }

  async storageSaved(): Promise<StorageSaved | null> {
    return this.read<StorageSaved>(STORAGE_SETTING_KEY);
  }

  /** What the screenshot store is set to (the server uses it from the next start) */
  async storage() {
    return resolveStorage(
      await this.storageSaved(),
      (name) => process.env[name],
      await this.backupKey(),
    );
  }

  /** Replaces what is saved under `key` (the storage form sends it whole) */
  async replace(key: string, value: Record<string, unknown>, userId: number): Promise<void> {
    const next = value as Prisma.InputJsonValue;
    await this.prisma.setting.upsert({
      where: { key },
      update: { value: next, updatedById: userId },
      create: { key, value: next, updatedById: userId },
    });
    this.cache.delete(key);
  }

  /** Merges `value` into what is saved under `key` */
  async save(key: string, value: Record<string, unknown>, userId: number): Promise<void> {
    const current = (await this.read<Record<string, unknown>>(key)) ?? {};
    const next = { ...current, ...value } as Prisma.InputJsonValue;
    await this.prisma.setting.upsert({
      where: { key },
      update: { value: next, updatedById: userId },
      create: { key, value: next, updatedById: userId },
    });
    this.cache.delete(key);
  }

  private async read<T>(key: string): Promise<T | null> {
    if (this.cache.has(key)) return this.cache.get(key) as T | null;
    const row = await this.prisma.setting.findUnique({ where: { key }, select: { value: true } });
    const value =
      row && typeof row.value === 'object' && row.value !== null && !Array.isArray(row.value)
        ? (row.value as T)
        : null;
    this.cache.set(key, value);
    return value;
  }
}
