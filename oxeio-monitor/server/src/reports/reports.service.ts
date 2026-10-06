import { Injectable } from '@nestjs/common';

import type { ProductivityQuery, ReportRangeQuery, SummaryQuery } from './dto';
import { ReportsAttendanceService } from './reports.attendance.service';
import type { DownloadFormat } from './reports.download';
import { ReportsProductivityService } from './reports.productivity.service';
import { ReportsSummaryService } from './reports.summary.service';
import type {
  AttendanceReport,
  ProductivityReport,
  ReportFile,
  SummaryReport,
} from './reports.types';

/**
 * F01–F02/F04/F05/F08: reports and Excel export.
 *
 * **There are no money calculations here.** Everything about salary is in
 * `src/payroll/`, where `monthly_salary` is read; managers also see these
 * reports (§ 4.3), so a money column slipping in here would leak salaries.
 *
 * **Categories never enter the pay calculation**: F04's productive/unproductive
 * split is for viewing only; it has no effect on `worked_sec`, `credited_sec` or the target.
 *
 * This class is only the front door: the controller, the digests and the
 * month-end delivery all ask here. Each report is built in its own file:
 *   - F01 attendance: `ReportsAttendanceService` (reports.attendance.service.ts)
 *   - F02 summary: `ReportsSummaryService` (reports.summary.service.ts)
 *   - F04 productivity: `ReportsProductivityService` (reports.productivity.service.ts)
 *   - the common range / employees / target / meta: `ReportsContextService`
 *     (reports.context.service.ts)
 *   - download name, letterhead and export audit: `ReportsExportService`
 *     (reports.export.service.ts)
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly attendanceReport: ReportsAttendanceService,
    private readonly summaryReport: ReportsSummaryService,
    private readonly productivityReport: ReportsProductivityService,
  ) {}

  // ── F01 · attendance ───────────────────────────────────────────────────────

  attendance(q: ReportRangeQuery): Promise<AttendanceReport> {
    return this.attendanceReport.attendance(q);
  }

  attendanceFile(
    q: ReportRangeQuery,
    format: DownloadFormat,
    actorUserId: number,
    ip: string,
  ): Promise<ReportFile> {
    return this.attendanceReport.attendanceFile(q, format, actorUserId, ip);
  }

  // ── F02 · weekly / monthly summary ─────────────────────────────────────────

  summary(q: SummaryQuery): Promise<SummaryReport> {
    return this.summaryReport.summary(q);
  }

  summaryFile(
    q: SummaryQuery,
    format: DownloadFormat,
    actorUserId: number,
    ip: string,
  ): Promise<ReportFile> {
    return this.summaryReport.summaryFile(q, format, actorUserId, ip);
  }

  // ── F04 · productivity ────────────────────────────────────────────────────

  productivity(q: ProductivityQuery): Promise<ProductivityReport> {
    return this.productivityReport.productivity(q);
  }

  productivityFile(
    q: ProductivityQuery,
    actorUserId: number,
    ip: string,
  ): Promise<ReportFile> {
    return this.productivityReport.productivityFile(q, actorUserId, ip);
  }
}
