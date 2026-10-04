import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  FEATURES_SETTING_KEY,
  resolveFeatures,
  type FeatureKey,
  type Features,
} from './features.rules';

@Injectable()
export class FeaturesService {
  /**
   * Read on every guarded request, so it is cached; `save()` is the only
   * writer and it refreshes the cache. One api process, so no other copy can
   * go stale.
   */
  private cached: Features | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async all(): Promise<Features> {
    if (this.cached) return this.cached;

    const row = await this.prisma.setting.findUnique({
      where: { key: FEATURES_SETTING_KEY },
    });
    this.cached = resolveFeatures(row?.value ?? null);
    return this.cached;
  }

  async isOn(feature: FeatureKey): Promise<boolean> {
    return (await this.all())[feature];
  }

  async save(features: Features, userId: number): Promise<Features> {
    await this.prisma.setting.upsert({
      where: { key: FEATURES_SETTING_KEY },
      update: { value: features, updatedById: userId },
      create: { key: FEATURES_SETTING_KEY, value: features, updatedById: userId },
    });
    this.cached = { ...features };
    return this.cached;
  }

  /** Drops the cache — for tests that write the row directly */
  forget(): void {
    this.cached = null;
  }
}
