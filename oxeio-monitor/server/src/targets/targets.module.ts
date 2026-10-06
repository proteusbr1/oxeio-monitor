import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { FileTraceService } from './file-trace.service';
import { MyTargetsController, TargetsController } from './targets.controller';
import { TargetsJob } from './targets.job';
import { TargetsService } from './targets.service';

/**
 * Design targets: submission, distribution, completion.
 *
 * Note: `ScheduleModule.forRoot()` is deliberately not imported here;
 * `SummaryModule` already makes it global. A second forRoot would register
 * every `@Cron` twice and distribution would run twice a day.
 */
@Module({
  imports: [AuditModule],
  controllers: [TargetsController, MyTargetsController],
  providers: [TargetsService, TargetsJob, FileTraceService],
  // `SummaryService` calls this to close targets based on file names
  exports: [TargetsService],
})
export class TargetsModule {}
