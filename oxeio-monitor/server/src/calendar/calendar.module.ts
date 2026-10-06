import { Module } from '@nestjs/common';

import { ReportsModule } from '../reports/reports.module';
import { HolidaySyncService } from './holiday-sync.service';
import { HolidaysController } from './holidays.controller';
import { HolidaysService } from './holidays.service';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';
import { MonthCloseController } from './month-close.controller';
import { MonthCloseService } from './month-close.service';
import { WorkPoliciesController } from './work-policies.controller';
import { WorkPoliciesService } from './work-policies.service';

/**
 * The working calendar: holidays, work policies (targets, days off, the
 * screenshot window), agreed leave and closed months.
 * ReportsModule: closing a month sends the monthly report.
 */
@Module({
  imports: [ReportsModule],
  controllers: [
    HolidaysController,
    WorkPoliciesController,
    LeaveController,
    MonthCloseController,
  ],
  providers: [HolidaysService, HolidaySyncService, WorkPoliciesService, LeaveService, MonthCloseService],
  // the setup wizard imports the country's public holidays and switches the update on
  exports: [HolidaysService, HolidaySyncService],
})
export class CalendarModule {}
