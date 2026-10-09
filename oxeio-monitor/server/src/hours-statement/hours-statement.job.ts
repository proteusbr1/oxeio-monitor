import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { workDateOf, workWallOf } from '../agent/util/work-time';
import { FeaturesService } from '../features/features.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { SCHEDULING_ENABLED } from '../summary/scheduling';
import { HoursStatementService } from './hours-statement.service';
import { isDue } from './pay-period.rules';
import {
  MAX_DELIVERY_ATTEMPTS,
  StatementDeliveryService,
} from './statement-delivery.service';

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
}
