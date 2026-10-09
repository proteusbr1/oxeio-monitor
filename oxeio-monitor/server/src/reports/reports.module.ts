import { Module } from '@nestjs/common';

import { TelegramChannel } from '../alerts/telegram.channel';
import { MonthDeliveryService } from './month-delivery.service';
import { ReportsController } from './reports.controller';
import { ReportsAttendanceService } from './reports.attendance.service';
import { ReportsContextService } from './reports.context.service';
import { ReportsExportService } from './reports.export.service';
import { ReportsProductivityService } from './reports.productivity.service';
import { ReportsService } from './reports.service';
import { ReportsSummaryService } from './reports.summary.service';

/**
 * F01 · F02 · F04 · F05 · F08.
 *
 * `PayrollModule` (F03) is separate: it is owner-only and reads `monthly_salary`.
 *
 * `ActivityModule` is **not** imported here, even though F04 now uses
 * `activity/activity.math.ts`; the two do not conflict. `activity.math.ts` is a
 * file of pure functions, not an `@Injectable`, so importing it shares one
 * **definition**, it does not join up the DI graph. That was the whole point:
 * the productivity calculation lives in one place (ADR, 09 § 4), while queries
 * and routes stay separate.
 *
 * Applying category rules (ingest) and reading the rules' results (reports) are
 * still two separate jobs: F04 runs its own `app_categories` query and does not
 * touch `AppCategoryService`'s cache (because there a rule with a bad regex is
 * dropped, yet old rows still carry that id).
 */
@Module({
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportsContextService,
    ReportsExportService,
    ReportsAttendanceService,
    ReportsSummaryService,
    ReportsProductivityService,
    MonthDeliveryService,
    /**
     * `TelegramChannel` is **provided again** here, not by importing
     * `AlertsModule`, because `AlertsModule` does not export it (only
     * `AlertsService`). It is a stateless transport (it reads settings on every
     * call), so a second instance shares no state.
     */
    TelegramChannel,
  ],
  /**
   * F07 (`DigestModule`) calls this very service; it does not read
   * `daily_summary` and work out the target itself. So the daily email and the
   * printed report **never state two different hours**; if the holiday calendar
   * or the daily target's split changes, both change together.
   *
   * Exporting means only the service, not the controller: the role wall
   * (`@Roles(owner, manager)`) is placed on the controller and stays there. The
   * module that uses the service is **itself** responsible for deciding who it
   * shows (so the digest by default emails only owners).
   */
  exports: [ReportsService, MonthDeliveryService],
})
export class ReportsModule {}
