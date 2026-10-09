import { Module } from '@nestjs/common';

import { AlertsModule } from '../alerts/alerts.module';
import { SummaryModule } from '../summary/summary.module';
import { HoursStatementController } from './hours-statement.controller';
import { HoursStatementJob } from './hours-statement.job';
import { HoursStatementService } from './hours-statement.service';
import { PayPeriodController } from './pay-period.controller';
import { StatementDeliveryService } from './statement-delivery.service';

/** Pay periods and the hours statement for hourly staff (Settings → Modules: hoursStatement) */
@Module({
  imports: [SummaryModule, AlertsModule],
  controllers: [HoursStatementController, PayPeriodController],
  providers: [
    HoursStatementService,
    StatementDeliveryService,
    HoursStatementJob,
  ],
  exports: [HoursStatementService],
})
export class HoursStatementModule {}
