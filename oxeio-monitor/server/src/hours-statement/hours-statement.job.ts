import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { workDateOf, workWallOf } from '../agent/util/work-time';
import { AlertsService } from '../alerts/alerts.service';
import { FeaturesService } from '../features/features.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { SCHEDULING_ENABLED } from '../summary/scheduling';
import { HoursStatementService } from './hours-statement.service';
import { isDue, minutesPastSend } from './pay-period.rules';
import {
  MAX_DELIVERY_ATTEMPTS,
  StatementDeliveryService,
} from './statement-delivery.service';

/** Minutes after the send moment at which a period still not frozen raises an alert */
const OVERDUE_ALERT_MIN = 180;

/**
 * Every hour at minute 10: freeze and send every period whose send moment has
 * passed (several if the server was down for long), retry failed emails, and
 * keep one open period ahead. Deciding by the clock rather than firing at
 * 07:00 means a server that was down at 07:00 still sends at its next run.
 */
@Injectable()
export class HoursStatementJob {
  private readonly logger = new Logger(HoursStatementJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly statements: HoursStatementService,
    private readonly delivery: StatementDeliveryService,
    private readonly settings: AppSettingsService,
    private readonly features: FeaturesService,
    private readonly alerts: AlertsService,
  ) {}

  @Cron('0 10 * * * *', {
    name: 'hours-statement',
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    try {
      await this.tick(new Date());
    } catch (err) {
      this.logger.error(
        `Hours statement run failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async tick(now: Date): Promise<void> {
    if (!(await this.features.isOn('hoursStatement'))) return;
    const config = await this.settings.payPeriod();
    const today = workDateOf(now).toISOString().slice(0, 10);
    const wall = workWallOf(now);
    const nowMin = wall.getUTCHours() * 60 + wall.getUTCMinutes();

    // periods frozen in this run already had their attempt; retries start next hour
    const justSent = new Set<number>();
    // a freeze that throws (database trouble, a cutoff change mid-freeze)
    // is tried again next hour — and never keeps the retries below from running
    try {
      let open = await this.statements.ensureOpen(today, config.cutoffDay);
      while (
        isDue(
          open.endDate.toISOString().slice(0, 10),
          today,
          nowMin,
          config.sendTime,
        )
      ) {
        await this.statements.snapshot(open.id, now);
        await this.delivery.deliver(open.id);
        justSent.add(open.id);
        open = await this.statements.ensureOpen(today, config.cutoffDay);
      }
    } catch (err) {
      this.logger.error(
        `Hours statement could not be frozen: ${err instanceof Error ? err.message : err}`,
      );
    }

    try {
      await this.retryUnsent(justSent);
    } catch (err) {
      this.logger.error(
        `Hours statement retries failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    try {
      await this.alertIfOverdue(today, nowMin, config.sendTime);
    } catch (err) {
      this.logger.error(
        `Hours statement overdue check failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async retryUnsent(justSent: ReadonlySet<number>): Promise<void> {
    // `pending`: frozen but never sent — a restart between the snapshot and
    // the email (every release restarts the server) must not leave it unsent
    const unsent = await this.prisma.payPeriod.findMany({
      where: {
        snapshotAt: { not: null },
        deliveryStatus: { in: ['pending', 'failed'] },
        deliveryAttempts: { lt: MAX_DELIVERY_ATTEMPTS },
      },
      select: { id: true },
      orderBy: { startDate: 'asc' },
    });
    for (const p of unsent) {
      if (justSent.has(p.id)) continue;
      // one period's trouble never keeps the others from being sent
      try {
        await this.delivery.deliver(p.id);
      } catch (err) {
        this.logger.error(
          `Hours statement ${p.id} could not be resent: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /**
   * A period still not frozen this long after its send moment means the
   * freeze keeps failing: tell the owner (the alerts service throttles
   * repeats), since finance is waiting for the email.
   */
  private async alertIfOverdue(
    today: string,
    nowMin: number,
    sendTime: string,
  ): Promise<void> {
    const oldest = await this.prisma.payPeriod.findFirst({
      where: { snapshotAt: null },
      orderBy: { startDate: 'asc' },
    });
    if (!oldest) return;
    const end = oldest.endDate.toISOString().slice(0, 10);
    if (minutesPastSend(end, today, nowMin, sendTime) < OVERDUE_ALERT_MIN)
      return;
    await this.alerts.raise({
      type: 'statement_delivery_failed',
      severity: 'warning',
      deviceId: null,
      employeeId: null,
      title: 'The hours statement could not be prepared',
      detail: `Period ${oldest.startDate.toISOString().slice(0, 10)} to ${end} is still not frozen, ${Math.floor(OVERDUE_ALERT_MIN / 60)} hours after its send time. The server log says why; it is tried again every hour.`,
    });
  }
}
