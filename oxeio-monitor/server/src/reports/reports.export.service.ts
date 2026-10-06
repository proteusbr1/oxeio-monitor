import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../audit/audit.service';
import {
  MIME_OF,
  reportFilename,
  type DownloadFormat,
} from './reports.download';
import type { ReportFile, ReportMeta } from './reports.types';

/**
 * The organisation's name printed on the letterhead.
 * Careful: if `ORG_NAME` is missing the letterhead is not blank; at least the
 * product's name goes in, because a paper with no heading could not say whose company it is.
 */
const DEFAULT_ORG_NAME = 'oXeio Monitoring';

/**
 * Turning a built report into a download: the letterhead's organisation name,
 * the file name and MIME type, and the audit record of the export.
 */
@Injectable()
export class ReportsExportService {
  readonly orgName: string;

  constructor(
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.orgName =
      config.get<string>('ORG_NAME')?.trim() || DEFAULT_ORG_NAME;
  }

  /**
   * An export is an event: who downloaded which range in which format is
   * recorded (§ 7).
   *
   * `format` used to be hardcoded as `'xlsx'`. Had that not been changed when
   * PDF was added, the audit log would have **lied**: someone downloading a PDF
   * would still be recorded as xlsx, yet "who took what" is supposed to be
   * answered from the audit.
   */
  async fileOf(
    report: string,
    meta: ReportMeta,
    rows: number,
    format: DownloadFormat,
    out: { buffer: Buffer; actorUserId: number; ip: string },
  ): Promise<ReportFile> {
    await this.audit.record({
      userId: out.actorUserId,
      action: 'export_report',
      targetType: 'report',
      targetId: report,
      ipAddress: out.ip,
      meta: { from: meta.from, to: meta.to, rows, format },
    });

    return {
      filename: reportFilename(report, meta.from, meta.to, format),
      mime: MIME_OF[format],
      buffer: out.buffer,
    };
  }
}
