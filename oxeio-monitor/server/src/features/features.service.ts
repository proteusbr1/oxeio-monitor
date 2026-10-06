import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  effectiveFeatures,
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

  /** The owner's switches, as saved */
  async switches(): Promise<Features> {
    if (this.cached) return this.cached;

    const row = await this.prisma.setting.findUnique({
      where: { key: FEATURES_SETTING_KEY },
    });
    this.cached = resolveFeatures(row?.value ?? null);
    return this.cached;
  }

  /** What is actually on: a child module is off while its parent is */
  async all(): Promise<Features> {
    return effectiveFeatures(await this.switches());
  }

  async isOn(feature: FeatureKey): Promise<boolean> {
    return (await this.all())[feature];
  }

  async save(features: Features, userId: number): Promise<Features> {
    // keys this version does not know are kept: the old `staffScreenshots`
    // switch is still read from here until Settings → Privacy is saved
    const row = await this.prisma.setting.findUnique({ where: { key: FEATURES_SETTING_KEY } });
    const kept =
      row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
        ? (row.value as Record<string, unknown>)
        : {};
    const value = { ...kept, ...features } as Prisma.InputJsonObject;
    await this.prisma.setting.upsert({
      where: { key: FEATURES_SETTING_KEY },
      update: { value, updatedById: userId },
      create: { key: FEATURES_SETTING_KEY, value, updatedById: userId },
    });
    this.cached = { ...features };
    return effectiveFeatures(this.cached);
  }

  /** Drops the cache — for tests that write the row directly */
  forget(): void {
    this.cached = null;
  }
}
