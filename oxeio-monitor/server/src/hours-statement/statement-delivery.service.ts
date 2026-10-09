import { Injectable, Logger } from '@nestjs/common';
import type { StatementDelivery } from '@prisma/client';

import { AlertsService } from '../alerts/alerts.service';
import { XLSX_MIME } from '../reports/reports.download';
import { Mailer } from '../mail/mailer';
import { MailRecipients } from '../mail/recipients.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { HoursStatementService } from './hours-statement.service';
import { statementMail } from './statement-mail';
import { statementWorkbook } from './statement-sheet';

/** One snapshot is sent at most this many times by the job (once an hour) before the owner is told */
export const MAX_DELIVERY_ATTEMPTS = 24;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Sends a frozen statement. Never throws: the outcome is stored on the period. */
@Injectable()
export class StatementDeliveryService {
  private readonly logger = new Logger(StatementDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly statements: HoursStatementService,
    private readonly mailer: Mailer,
    private readonly recipients: MailRecipients,
    private readonly settings: AppSettingsService,
    private readonly alerts: AlertsService,
  ) {}

  async deliver(periodId: number): Promise<StatementDelivery> {
    const period = await this.prisma.payPeriod.findUniqueOrThrow({
      where: { id: periodId },
      include: {
        lines: {
          include: { employee: { select: { fullName: true, empCode: true } } },
          orderBy: { employee: { fullName: 'asc' } },
        },
      },
    });
    if (period.lines.length === 0)
      return this.record(periodId, 'no_staff', null);

    const to = await this.recipients.for('hoursStatement');
    if (to.length === 0) return this.record(periodId, 'no_recipients', null);

    try {
      const lang = (await this.settings.region()).language.value;
      const org = (await this.settings.organization()).name;
      const start = iso(period.startDate);
      const end = iso(period.endDate);
      const lines = period.lines.map((l) => ({
        fullName: l.employee.fullName,
        empCode: l.employee.empCode,
        toPostMin: l.toPostMin,
        carryInSec: l.carryInSec,
        leaveDays: l.leaveDays,
        holidayDays: l.holidayDays,
        noDataDays: l.noDataDays,
        fromDate: iso(l.fromDate),
        toDate: iso(l.toDate),
        measuredSec: l.measuredSec,
      }));
      const base = (
        process.env.PUBLIC_URL?.trim() ||
        process.env.CORS_ORIGIN?.trim() ||
        ''
      ).replace(/\/$/, '');
      const mail = statementMail({
        lang,
        org,
        start,
        end,
        lines,
        link: base ? `${base}/hours?period=${period.id}` : null,
      });
      const file = await statementWorkbook({
        start,
        end,
        lines,
        days: await this.statements.days(
          { start, end },
          period.lines.map((l) => l.employeeId),
        ),
      });

      const result = await this.mailer.deliver(to, {
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        attachments: [
          {
            filename: `oxeio-hours-${start}_${end}.xlsx`,
            content: file,
            contentType: XLSX_MIME,
          },
        ],
      });
      return this.record(
        periodId,
        result.outcome === 'sent'
          ? 'sent'
          : result.outcome === 'not_configured'
            ? 'not_configured'
            : 'failed',
        result.error ?? null,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(
        `Hours statement ${periodId} could not be built: ${error}`,
      );
      return this.record(periodId, 'failed', error);
    }
  }

  private async record(
    periodId: number,
    status: StatementDelivery,
    error: string | null,
  ): Promise<StatementDelivery> {
    const period = await this.prisma.payPeriod.update({
      where: { id: periodId },
      data: {
        deliveryStatus: status,
        deliveryError: error,
        deliveryAttempts: { increment: 1 },
        ...(status === 'sent' ? { sentAt: new Date() } : {}),
      },
    });
    if (
      status === 'failed' &&
      period.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS
    ) {
      await this.alerts.raise({
        type: 'statement_delivery_failed',
        severity: 'warning',
        deviceId: null,
        employeeId: null,
        title: 'The hours statement email could not be sent',
        detail: `Period ${iso(period.startDate)} to ${iso(period.endDate)}: ${error ?? 'unknown error'}. Check Settings → Notifications, then resend it from the Hours statement screen.`,
      });
    }
    return status;
  }
}
