import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { DayCloseJob } from './day-close.job';
import { RetentionJob } from './retention.job';
import { SCHEDULING_ENABLED } from './scheduling';
import { SummaryRefreshJob } from './summary-refresh.job';
import { ScheduleModule as ScheduleCheckModule } from '../schedule/schedule.module';
import { TasksModule } from '../tasks/tasks.module';
import { SummaryService } from './summary.service';

/**
 * Scheduled jobs for summaries and maintenance (K06, K05, K01).
 *
 * `ScheduleModule.forRoot()` is **here**, not in `app.module.ts`. Two reasons:
 *
 * 1. In tests (`NODE_ENV === 'test'`) the import is skipped, so the explorer
 *    never exists and no `@Cron` is registered anywhere. This is the
 *    strongest lock: not "the job exists but is off", there is no job at all.
 *
 * 2. `app.module.ts` need not be touched; adding `SummaryModule` is enough.
 *
 * Careful: when building K02 (pg_dump) or K04 (health), nobody should add
 * `ScheduleModule.forRoot()` **anywhere else**. Calling forRoot twice makes
 * two explorers try to register the same job twice. Every `@Cron` here has a
 * `name`, so that fails loudly at bootstrap ("cron job ... already exists"),
 * which is far better than silently running twice a day. Add new jobs in this
 * module, or move `ScheduleModule` into a separate shared module.
 */
@Module({
  /**
   * `TasksModule`: to mark tasks started from the task number found in a
   * window title (start detection). Careful: it sits in the same array as the conditional
   * `ScheduleModule` because that one is dropped in tests but this is not.
   */
  imports: [
    ...(SCHEDULING_ENABLED ? [ScheduleModule.forRoot()] : []),
    TasksModule,
    ScheduleCheckModule,
  ],
  providers: [SummaryService, SummaryRefreshJob, DayCloseJob, RetentionJob],
  // Exported so that tests or a future admin endpoint can call `runOnce()`
  // deliberately.
  exports: [SummaryService, SummaryRefreshJob, DayCloseJob, RetentionJob],
})
export class SummaryModule {}
