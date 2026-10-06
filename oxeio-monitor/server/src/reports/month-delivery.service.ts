import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AlertMailer } from '../alerts/alerts.mailer';
import { TelegramChannel } from '../alerts/telegram.channel';
import { digestRecipients } from '../digest/digest.recipients';
import { PrismaService } from '../prisma/prisma.service';
import { XLSX_MIME } from './reports.download';
import {
  monthCaption,
  monthRange,
  monthReportName,
} from './month-delivery.rules';
import { ReportsService } from './reports.service';
import { summaryWorkbook } from './reports.sheets';

/**
 * **R26: when a month is closed, the figures file goes out by itself.**
 *
 * Reports used to be **on-demand downloads** only, and the digest was **text**
 * only. After closing a month the owner had to remember to open the page,
 * pick a range and download the file, and on the day they forgot there would
 * be no permanent copy of that month.
 *
 * **This never throws and never stops a month from closing.**
 * `MonthCloseService.close()` calls it fire-and-forget, after the commit. The
 * reason is measured: an upload of a few MB can take up to 60 seconds, and
 * awaiting it would hold the owner's HTTP request that long; throwing would
 * turn a **fully successful** month close into a 500, and they would retry and
 * get a 409 ("the month is already closed").
 *
 * **Which report goes:** the month's **summary** (hours), not payroll. This is
 * a deliberate decision, not laziness: the payroll sheet has **salaries**, and
 * a Telegram message sits on an outside service's servers. Sending salaries
 * there should be the owner's own decision, not something code does by itself.
 * If needed it can be added later with an explicit setting.
 */
@Injectable()
export class MonthDeliveryService {
  private readonly logger = new Logger(MonthDeliveryService.name);
  private readonly orgName: string;
  private readonly digestEmailTo: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly telegram: TelegramChannel,
    private readonly mailer: AlertMailer,
    config: ConfigService,
  ) {
    this.orgName = config.get<string>('ORG_NAME')?.trim() || 'oXeio Monitoring';
    this.digestEmailTo = config.get<string>('DIGEST_EMAIL_TO')?.trim();
  }

  /**
   * Builds one month's file and sends it to whichever channels are configured.
   *
   * Returns what happened where, for tests and a future ops screen.
   * It never throws; everything inside is wrapped in try/catch, so the call
   * site's `.catch()` is a second net, not the only one.
   */
  async deliverClosedMonth(yearMonth: string): Promise<{
    telegram: 'sent' | 'not_configured' | 'failed' | 'skipped';
    email: 'sent' | 'not_configured' | 'failed' | 'skipped';
  }> {
    try {
      const { from, to } = monthRange(yearMonth);

      /**
       * `summary()` + `summaryWorkbook()`, not `summaryFile()`.
       *
       * The reason is the honesty of the audit ledger: `*File()` writes an
       * `export_report` row inside, which needs a **user id**. Called as a job,
       * someone's name would have to go there, and the ledger would show a
       * download no person made, ruining the answer to "who looked at my figures".
       */
      const report = await this.reports.summary({
        from,
        to,
        groupBy: 'month',
      });

      // No point sending a file with no rows: an empty sheet would read as
      // "nobody worked", when there may simply be no data.
      if (report.rows.length === 0) {
        this.logger.warn(
          `${yearMonth} closed, but the summary has no rows — nothing was sent`,
        );
        return { telegram: 'skipped', email: 'skipped' };
      }

      const bytes = await summaryWorkbook(report);
      const filename = monthReportName(yearMonth, 'xlsx');

      const caption = monthCaption({
        orgName: this.orgName,
        yearMonth,
        people: new Set(report.rows.map((r) => r.employeeId)).size,
        totalHours: report.rows.reduce((sum, r) => sum + r.creditedHours, 0),
      });

      const telegram = await this.telegram.sendDocument(
        { bytes, filename, contentType: XLSX_MIME },
        caption,
      );

      const email = await this.emailIt(yearMonth, caption, bytes, filename);

      this.logger.log(
        `${yearMonth} report — telegram: ${telegram}, email: ${email} (${filename}, ${bytes.byteLength} bytes)`,
      );

      return { telegram, email };
    } catch (err) {
      // The month is already closed; a failure here does not touch that
      this.logger.error(
        `Could not deliver the ${yearMonth} report: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      return { telegram: 'failed', email: 'failed' };
    }
  }

  /**
   * Recipients are chosen with `digestRecipients()`: **managers are excluded**.
   * This file has every employee's name and hours, the same as an owner-only
   * screen; sending it by email must not sidestep the role wall.
   */
  private async emailIt(
    yearMonth: string,
    body: string,
    bytes: Buffer,
    filename: string,
  ): Promise<'sent' | 'not_configured' | 'failed'> {
    if (!this.mailer.configured) return 'not_configured';

    const owners = await this.prisma.user.findMany({
      where: { role: 'owner', isActive: true },
      select: { email: true },
    });

    const to = digestRecipients({
      explicit: this.digestEmailTo,
      owners: owners.map((o) => o.email),
    });
    if (to.length === 0) return 'not_configured';

    return this.mailer.send(
      to,
      `${this.orgName} — ${yearMonth} closed`,
      body,
      [{ filename, content: bytes, contentType: XLSX_MIME }],
    );
  }
}
