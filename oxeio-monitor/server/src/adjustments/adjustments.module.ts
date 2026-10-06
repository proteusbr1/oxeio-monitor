import { Module } from '@nestjs/common';

import { SummaryModule } from '../summary/summary.module';
import {
  AdjustmentsController,
  EmployeeAdjustmentsController,
} from './adjustments.controller';
import { AdjustmentsService } from './adjustments.service';

/**
 * **B14 · G35 · ADR-011e** - hours adjustments.
 *
 * Careful: `SummaryModule` is imported only for `SummaryService`, to recompute
 * the day's summary right after an adjustment. That module contains
 * `ScheduleModule.forRoot()`, but Nest modules are singletons, so importing it
 * does not run it a second time. That matters: two explorers would register
 * the same-named cron twice and crash at bootstrap (see the warning in
 * `summary.module.ts`).
 */
@Module({
  imports: [SummaryModule],
  controllers: [EmployeeAdjustmentsController, AdjustmentsController],
  providers: [AdjustmentsService],
  exports: [AdjustmentsService],
})
export class AdjustmentsModule {}
