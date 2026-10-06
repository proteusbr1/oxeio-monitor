import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { FEATURES_SETTING_KEY } from '../features/features.rules';
import { PrismaService } from '../prisma/prisma.service';
import { PRIVACY_SETTING_KEY, resolvePrivacy, type PrivacySettings } from './privacy.rules';

@Injectable()
export class PrivacyService {
  /** read by the screenshot routes and the nightly job; `save()` refreshes it */
  private cached: PrivacySettings | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<PrivacySettings> {
    if (this.cached) return this.cached;
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: [PRIVACY_SETTING_KEY, FEATURES_SETTING_KEY] } },
    });
    const value = (key: string) => rows.find((r) => r.key === key)?.value ?? null;
    this.cached = resolvePrivacy(value(PRIVACY_SETTING_KEY), value(FEATURES_SETTING_KEY));
    return this.cached;
  }

  async save(settings: PrivacySettings, userId: number): Promise<PrivacySettings> {
    const value = { ...settings } as Prisma.InputJsonObject;
    await this.prisma.setting.upsert({
      where: { key: PRIVACY_SETTING_KEY },
      update: { value, updatedById: userId },
      create: { key: PRIVACY_SETTING_KEY, value, updatedById: userId },
    });
    this.cached = { ...settings };
    return this.cached;
  }

  /** Drops the cache — for tests that write the row directly */
  forget(): void {
    this.cached = null;
  }
}
