import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';

import { workDateOf } from '../agent/util/work-time';
import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { JOB_TIMEZONE, RunLock, SCHEDULING_ENABLED } from '../summary/scheduling';
import { HolidaysService } from './holidays.service';

/**
 * Public holidays kept up to date by themselves (Settings → Policies &
 * holidays › Public holidays › "Keep up to date").
 *
 * Every night it makes sure this year and next year have been imported from
 * the public calendar of the company's country (public-holidays.ts). Rules:
 *  · **each year once.** A year that was imported is never imported again,
 *    so a holiday the owner deleted (a day the company works anyway) never
 *    comes back by itself. "Update now" also only fills years not done yet.
 *  · **only months after the current one.** A holiday added to this month or
 *    an earlier one would change targets and pay already counted — the same
 *    rule as a manual import.
 *  · a date that already is a holiday is left as it is.
 *  · when the calendar cannot be reached the year is not marked done, so the
 *    next night tries again.
 */

export const HOLIDAY_SYNC_SETTING_KEY = 'holidays.auto';

export interface HolidaySyncSaved {
  enabled?: boolean;
  /** years already imported automatically (or by the setup wizard) */
  years?: number[];
  lastRunAt?: string;
  /** what the last run did, in a sentence, for the settings card */
  lastResult?: string;
}

export interface HolidaySyncView {
  enabled: boolean;
  /** the company's country (Settings → Company & region); null = nothing to update */
  country: string | null;
  years: number[];
  lastRunAt: string | null;
  lastResult: string | null;
}

@Injectable()
export class HolidaySyncService {
  private readonly logger = new Logger(HolidaySyncService.name);
  private readonly lock = new RunLock();

  constructor(
    private readonly prisma: PrismaService,
    private readonly holidays: HolidaysService,
    private readonly settings: AppSettingsService,
  ) {}

  async view(): Promise<HolidaySyncView> {
    const saved = await this.saved();
    const { country } = await this.settings.organization();
    return {
      enabled: saved.enabled === true,
      country,
      years: saved.years ?? [],
      lastRunAt: saved.lastRunAt ?? null,
      lastResult: saved.lastResult ?? null,
    };
  }

  /** On or off; turning it on runs at once, so the owner sees the result */
  async setEnabled(enabled: boolean, userId: number | null, now = new Date()): Promise<HolidaySyncView> {
    await this.write({ ...(await this.saved()), enabled }, userId);
    if (enabled) await this.runOnce(now);
    return this.view();
  }

  /** The setup wizard imported these years itself — remember them, and switch on */
  async markImported(years: number[], userId: number): Promise<void> {
    const saved = await this.saved();
    const done = [...new Set([...(saved.years ?? []), ...years])].sort();
    await this.write({ ...saved, enabled: true, years: done }, userId);
  }

  // 04:15, after the backup (03:30) — any hour away from the daylight-saving night works
  @Cron('0 15 4 * * *', {
    name: 'holiday-sync',
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    await this.runOnce(new Date());
  }

  /** Imports this year and next if not done yet. `null` = already running. */
  async runOnce(now = new Date(), fetchImpl: typeof fetch = fetch): Promise<HolidaySyncView | null> {
    return this.lock.run(async () => {
      const saved = await this.saved();
      if (saved.enabled !== true) return this.view();

      const { country } = await this.settings.organization();
      if (!country) {
        await this.write({ ...saved, lastRunAt: now.toISOString(), lastResult: 'No country set — choose it in Settings → Company & region' }, null);
        return this.view();
      }

      const year = Number(workDateOf(now).toISOString().slice(0, 4));
      const done = new Set(saved.years ?? []);
      const notes: string[] = [];
      let added = 0;

      for (const y of [year, year + 1]) {
        if (done.has(y)) continue;
        try {
          const plan = await this.holidays.importPublicAutomatically(country, y, now, fetchImpl);
          added += plan.created;
          done.add(y);
          notes.push(`${y}: ${plan.created} added`);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          notes.push(`${y}: not reached — will try again tomorrow`);
          this.logger.warn(`Holiday update for ${country} ${y} failed: ${why}`);
        }
      }

      const result = notes.length === 0 ? `Up to date (${year} and ${year + 1})` : notes.join(' · ');
      await this.write(
        { ...saved, years: [...done].sort(), lastRunAt: now.toISOString(), lastResult: result },
        null,
      );
      if (added > 0) this.logger.log(`Public holidays for ${country}: ${result}`);
      return this.view();
    });
  }

  private async saved(): Promise<HolidaySyncSaved> {
    const row = await this.prisma.setting.findUnique({ where: { key: HOLIDAY_SYNC_SETTING_KEY } });
    const value = row?.value;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as HolidaySyncSaved) : {};
  }

  private async write(value: HolidaySyncSaved, userId: number | null): Promise<void> {
    const json = value as Prisma.InputJsonObject;
    await this.prisma.setting.upsert({
      where: { key: HOLIDAY_SYNC_SETTING_KEY },
      update: { value: json, ...(userId === null ? {} : { updatedById: userId }) },
      create: { key: HOLIDAY_SYNC_SETTING_KEY, value: json, updatedById: userId },
    });
  }
}
