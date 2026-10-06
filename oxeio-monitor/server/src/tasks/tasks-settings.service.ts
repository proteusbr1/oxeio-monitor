import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { FeaturesService } from '../features/features.service';
import { PrismaService } from '../prisma/prisma.service';
import { startDetectionApps } from '../summary/task-start.rules';
import {
  resolveTasksSettings,
  TASKS_SETTING_KEY,
  type TasksSettings,
  type TasksSettingsView,
} from './tasks-settings.rules';

/**
 * Reads and saves Settings → Tasks.
 *
 * Careful: deliberately not cached. It is read once per summary run and once
 * per list page, and a cache would need clearing in every test that writes
 * the row directly — hidden state is not worth one small query.
 */
@Injectable()
export class TasksSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly features: FeaturesService,
  ) {}

  async get(): Promise<TasksSettings> {
    const row = await this.prisma.setting.findUnique({
      where: { key: TASKS_SETTING_KEY },
      select: { value: true },
    });
    return resolveTasksSettings(row?.value ?? null);
  }

  async view(): Promise<TasksSettingsView> {
    const settings = await this.get();
    const active =
      settings.startDetection.apps.length > 0 &&
      (await this.features.isOn('appTracking'));
    return { ...settings, active };
  }

  async save(settings: TasksSettings, userId: number): Promise<void> {
    const value = settings as unknown as Prisma.InputJsonObject;
    await this.prisma.setting.upsert({
      where: { key: TASKS_SETTING_KEY },
      update: { value, updatedById: userId },
      create: { key: TASKS_SETTING_KEY, value, updatedById: userId },
    });
  }

  /**
   * The apps whose titles are read right now, lower-cased; **empty when
   * start detection is off** for any reason: no apps listed, Apps & websites
   * off, or the Tasks module itself off.
   */
  async detectionApps(): Promise<Set<string>> {
    const { startDetection } = await this.get();
    if (startDetection.apps.length === 0) return new Set();

    const features = await this.features.all();
    if (!features.appTracking || !features.tasks) return new Set();

    return startDetectionApps(startDetection.apps);
  }
}
