import { Body, Controller, Get, Ip, Patch } from '@nestjs/common';
import { UserRole, type Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { RequiresFeature } from '../features/requires-feature';
import {
  cleanApps,
  START_APP_PATTERN,
  START_APPS_MAX,
  TASKS_SETTING_KEY,
  type TasksSettings,
  type TasksSettingsView,
} from './tasks-settings.rules';
import { TasksSettingsService } from './tasks-settings.service';

class StartDetectionDto {
  /** Process names, e.g. `["Excel.exe", "WINWORD.EXE"]`; `[]` switches detection off */
  @IsArray()
  @ArrayMaxSize(START_APPS_MAX)
  @IsString({ each: true })
  @Matches(START_APP_PATTERN, {
    each: true,
    message: 'each app must be a program name such as Excel.exe (no path)',
  })
  apps!: string[];
}

class SaveTasksSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => StartDetectionDto)
  startDetection?: StartDetectionDto;
}

/**
 * Settings → Tasks (owner only; 404 while the Tasks module is off).
 *
 * `GET`  → `{ startDetection: { apps: string[] }, active: boolean }`
 * `PATCH { startDetection?: { apps: string[] } }` → the same shape
 */
@Roles(UserRole.owner)
@RequiresFeature('tasks')
@Controller('settings/tasks')
export class TasksSettingsController {
  constructor(
    private readonly settings: TasksSettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  read(): Promise<TasksSettingsView> {
    return this.settings.view();
  }

  @Patch()
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveTasksSettingsDto,
    @Ip() ip: string,
  ): Promise<TasksSettingsView> {
    const before = await this.settings.get();
    const after: TasksSettings = {
      startDetection: {
        apps: dto.startDetection
          ? cleanApps(dto.startDetection.apps)
          : before.startDetection.apps,
      },
    };

    const from = before.startDetection.apps;
    const to = after.startDetection.apps;
    const changed = from.length !== to.length || from.some((a, i) => a !== to[i]);
    if (changed) {
      await this.settings.save(after, actor.userId);
      await this.audit.record({
        userId: actor.userId,
        action: 'change_setting',
        targetType: 'setting',
        targetId: TASKS_SETTING_KEY,
        ipAddress: ip,
        meta: { op: 'tasks', startDetectionApps: { from, to } } as Prisma.InputJsonObject,
      });
    }
    return this.settings.view();
  }
}
