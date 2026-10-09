import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  DISPATCH_BATCH,
  DISPATCH_MAX_AGE_HOURS,
  MAX_EMAIL_ATTEMPTS,
} from './alerts.constants';
import { Mailer } from '../mail/mailer';
import { MailRecipients } from '../mail/recipients.service';
import { severityLabel } from './alerts.rules';

const PENDING_SELECT = {
  id: true,
  type: true,
  severity: true,
  title: true,
  detail: true,
  createdAt: true,
  device: { select: { hostname: true } },
  employee: { select: { fullName: true } },
} satisfies Prisma.AlertSelect;

type PendingAlert = Prisma.AlertGetPayload<{ select: typeof PENDING_SELECT }>;

/**
 * Picks up alerts that have not gone to any channel yet (`channels_sent` empty)
 * and sends them by email.
 *
 * Sending is kept separate from where alerts are created, for three reasons:
 *
 *  1. **Clock-drift alerts are covered automatically.** clock_drift alerts are
 *     inserted by src/agent/clock-drift.service.ts, not by us. It leaves
 *     `channels_sent = {}` too, so it goes out by email through here, and we
 *     never have to **create** clock_drift anywhere (no risk of double inserts).
 *  2. A slow or dead SMTP server must not slow the checks down.
 *  3. With a single sending path, "did this alert go out by email?" is always
 *     answered by the `channels_sent` column.
 */
@Injectable()
export class AlertDispatcher {
  private readonly logger = new Logger(AlertDispatcher.name);
  /**
   * Deliberately in-memory. After a server restart the count starts over, which
   * is the right behavior: restarts are usually done to fix the config.
   */
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly recipientsOf: MailRecipients,
  ) {}

  /** Returns how many alerts were settled (sent or given up on) */
  async runOnce(now = new Date()): Promise<number> {
    const pending = await this.prisma.alert.findMany({
      where: {
        channelsSent: { isEmpty: true },
        createdAt: {
          gte: new Date(now.getTime() - DISPATCH_MAX_AGE_HOURS * 3_600_000),
        },
      },
      select: PENDING_SELECT,
      orderBy: { createdAt: 'asc' },
      take: DISPATCH_BATCH,
    });

    if (pending.length === 0) return 0;

    if (!(await this.mailer.isConfigured())) {
      return this.markLogged(pending);
    }

    const recipients = await this.recipients();
    // The whole batch goes in **one** email. If twelve PCs shut down together,
    // that is one mail with twelve lines, not twelve mails: the last flood barrier.
    const outcome = await this.mailer.send(
      recipients,
      subjectFor(pending),
      bodyFor(pending),
    );

    if (outcome === 'sent') {
      await this.markSent(pending, 'email');
      for (const a of pending) this.attempts.delete(a.id.toString());
      return pending.length;
    }

    if (outcome === 'not_configured') {
      return this.markLogged(pending);
    }

    return this.countFailures(pending);
  }

  /**
   * No SMTP: the alert is still not lost, it goes to the log.
   * Careful: `log` is written into `channels_sent` so the next sweep does not
   * pick up the same alerts again; otherwise the same line would be logged
   * every minute and the real pending alerts would be stuck behind that batch.
   */
  private async markLogged(pending: PendingAlert[]): Promise<number> {
    for (const a of pending) {
      this.logger.warn(`[Alert] ${lineFor(a)}`);
    }
    await this.markSent(pending, 'log');
    return pending.length;
  }

  private async markSent(
    pending: PendingAlert[],
    channel: 'email' | 'log' | 'email_failed',
  ): Promise<void> {
    await this.prisma.alert.updateMany({
      where: { id: { in: pending.map((a) => a.id) } },
      data: { channelsSent: [channel] },
    });
  }

  /**
   * Could not be sent: we give up after three attempts.
   *
   * Careful: retrying forever would let one bad config block the whole queue,
   * and new alerts piling up behind it would never reach the front.
   */
  private async countFailures(pending: PendingAlert[]): Promise<number> {
    const exhausted: PendingAlert[] = [];

    for (const a of pending) {
      const key = a.id.toString();
      const count = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, count);
      if (count >= MAX_EMAIL_ATTEMPTS) exhausted.push(a);
    }

    if (exhausted.length === 0) return 0;

    for (const a of exhausted) {
      this.logger.error(`[Alert · email failed] ${lineFor(a)}`);
      this.attempts.delete(a.id.toString());
    }
    await this.markSent(exhausted, 'email_failed');
    return exhausted.length;
  }

  /**
   * Who receives it: the list saved on screen, else the old environment
   * variable, else the active owners' emails (see `mail/recipients.rules.ts`).
   *
   * Careful: managers are not emailed. Alerts carry hostnames and staff names,
   * and this list is the same data as the owner-only endpoint; emailing it must
   * not become a way around the role wall.
   */
  private recipients(): Promise<string[]> {
    return this.recipientsOf.for('alerts');
  }
}

function subjectFor(pending: PendingAlert[]): string {
  const worst = pending.some((a) => a.severity === 'critical')
    ? 'critical'
    : pending.some((a) => a.severity === 'warning')
      ? 'warning'
      : 'info';

  return pending.length === 1
    ? `[oXeio · ${severityLabel(worst)}] ${pending[0].title}`
    : `[oXeio · ${severityLabel(worst)}] ${pending.length} new alerts`;
}

function bodyFor(pending: PendingAlert[]): string {
  const lines = pending.map((a) => `• ${lineFor(a)}`);
  return [
    'From the oXeio monitoring server:',
    '',
    ...lines,
    '',
    'Acknowledge these on the dashboard Alerts page to clear them from the list.',
  ].join('\n');
}

/** Never a URL, window text or file name: only the hostname and staff name */
function lineFor(a: PendingAlert): string {
  const who = [a.employee?.fullName, a.device?.hostname]
    .filter(Boolean)
    .join(' · ');
  const when = a.createdAt.toISOString();
  const detail = a.detail ? ` — ${a.detail}` : '';
  return `[${severityLabel(a.severity)}] ${a.title}${who ? ` (${who})` : ''}${detail} · ${when}`;
}
