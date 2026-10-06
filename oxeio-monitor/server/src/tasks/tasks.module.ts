import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { OnScreenService } from './on-screen.service';
import { TasksSettingsController } from './tasks-settings.controller';
import { TasksSettingsService } from './tasks-settings.service';
import { MyTasksController, TasksController } from './tasks.controller';
import { TasksJob } from './tasks.job';
import { TasksService } from './tasks.service';

/**
 * Tasks: adding, daily hand-out, completion, and Settings → Tasks.
 *
 * Note: `ScheduleModule.forRoot()` is deliberately not imported here;
 * `SummaryModule` already makes it global. A second forRoot would register
 * every `@Cron` twice and the hand-out would run twice a day.
 */
@Module({
  imports: [AuditModule],
  controllers: [TasksController, MyTasksController, TasksSettingsController],
  providers: [TasksService, TasksJob, OnScreenService, TasksSettingsService],
  // `SummaryService` marks tasks started from window titles, reading the
  // start-detection apps from the settings
  exports: [TasksService, TasksSettingsService],
})
export class TasksModule {}
