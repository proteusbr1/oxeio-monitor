import { Module } from '@nestjs/common';

import { AlertsModule } from '../alerts/alerts.module';
import { SummaryModule } from '../summary/summary.module';
import { HoursStatementJob } from './hours-statement.job';
import { HoursStatementService } from './hours-statement.service';
import { StatementDeliveryService } from './statement-delivery.service';

/** Pay periods and the hours statement for hourly staff (Settings → Modules: hoursStatement) */
@Module({
  imports: [SummaryModule, AlertsModule],
  providers: [
    HoursStatementService,
    StatementDeliveryService,
    HoursStatementJob,
  ],
  exports: [HoursStatementService],
})
export class HoursStatementModule {}
