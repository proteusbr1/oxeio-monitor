import { Controller, Get, Ip, Query, StreamableFile } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { ProductivityQuery, ReportRangeQuery, SummaryQuery } from './dto';
import { ReportsService } from './reports.service';
import type {
  AttendanceReport,
  ProductivityReport,
  ReportFile,
  SummaryReport,
} from './reports.types';
import { RequiresFeature } from '../features/requires-feature';

/**
 * F01 · F02 · F04 · F05 · F08: reports and Excel export.
 *
 * The roles are set **at class level** (not on methods): owner and manager can
 * both view and download reports (§ 4.3), but staff cannot. If someone adds a
 * new report later it is automatically limited to these two; written on a
 * method, a new endpoint would silently end up within everyone's reach.
 *
 * Payroll is **not** here: `/reports/payroll` is in a separate module,
 * owner-only. Brought into this controller, managers would get the salary sheet
 * too, inside this class-level `@Roles`.
 */
@Roles(UserRole.owner, UserRole.manager)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * F01 · F06 — `GET /api/v1/reports/attendance?from=&to=&format=json|xlsx|pdf`
   */
  @Get('attendance')
  async attendance(
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
    @Query() q: ReportRangeQuery,
  ): Promise<AttendanceReport | StreamableFile> {
    if (q.format === 'xlsx' || q.format === 'pdf') {
      return download(
        await this.reports.attendanceFile(q, q.format, actor.userId, ip),
      );
    }
    return this.reports.attendance(q);
  }

  /**
   * F02 · F06 —
   * `GET /api/v1/reports/summary?from=&to=&groupBy=week|month&format=json|xlsx|pdf`
   */
  @Get('summary')
  async summary(
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
    @Query() q: SummaryQuery,
  ): Promise<SummaryReport | StreamableFile> {
    if (q.format === 'xlsx' || q.format === 'pdf') {
      return download(
        await this.reports.summaryFile(q, q.format, actor.userId, ip),
      );
    }
    return this.reports.summary(q);
  }

  /**
   * F04 — `GET /api/v1/reports/productivity?from=&to=&format=json|xlsx`
   * Careful: no `pdf` here. `ProductivityQuery` blocks it in the DTO itself, so
   * `?format=pdf` gets a clear 400, not quietly JSON.
   */
  @RequiresFeature('appTracking')
  @Get('productivity')
  async productivity(
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
    @Query() q: ProductivityQuery,
  ): Promise<ProductivityReport | StreamableFile> {
    if (q.format === 'xlsx') {
      return download(await this.reports.productivityFile(q, actor.userId, ip));
    }
    return this.reports.productivity(q);
  }
}

/**
 * The headers are given in `StreamableFile`'s options, not via `@Res()`. Taking
 * `@Res()` switches off Nest's own response pipeline (interceptors,
 * serialisation) for that handler, yet the same method's JSON branch needs it.
 *
 * Careful: the MIME and the name are **both given by the service**
 * (`ReportFile`). Picking the MIME again here from the format could one day
 * send a `.pdf` file with the `xlsx` MIME, and the browser would try to open
 * it in Excel and say "file corrupt".
 *
 * The file name is ASCII (`reportFilename` in `reports.download.ts`): a
 * non-ASCII name in Content-Disposition would need RFC 5987 encoding,
 * otherwise clients would save it under a broken name.
 */
function download(file: ReportFile): StreamableFile {
  return new StreamableFile(file.buffer, {
    type: file.mime,
    disposition: `attachment; filename="${file.filename}"`,
    length: file.buffer.byteLength,
  });
}
