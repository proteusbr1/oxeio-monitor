import { Module } from '@nestjs/common';

import { DashboardDayService } from './dashboard.day.service';
import { DashboardLiveService } from './dashboard.live.service';
import { DashboardTrendService } from './dashboard.trend.service';
import { EmployeeActivityController } from './employee-activity.controller';
import { LiveController } from './live.controller';

/**
 * Live board and a single employee's day in detail.
 *
 * PrismaModule is global, so it does not need to be imported here
 * (PayrollModule gets by with empty `imports` for the same reason).
 */
@Module({
  controllers: [LiveController, EmployeeActivityController],
  providers: [DashboardLiveService, DashboardDayService, DashboardTrendService],
  /**
   * Note: the hourly snapshot job (`SnapshotService`) used to call this; that
   * job was removed (it sent 11 messages a day, and the owner wanted a single
   * daily report). The export stays: "who is working right now" should still
   * have exactly one calculation.
   */
  exports: [DashboardLiveService, DashboardDayService, DashboardTrendService],
})
export class DashboardModule {}
