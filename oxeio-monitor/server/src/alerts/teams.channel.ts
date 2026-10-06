import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { teamsCard } from './teams.card';

export type TeamsOutcome = 'sent' | 'not_configured' | 'failed';

/**
 * **Microsoft Teams channel**: the weekly summary goes to the office channel.
 *
 * The structure is exactly the same as <see cref="TelegramChannel"/>: one
 * address, one POST, and never throwing. Not a new architecture, just another channel.
 *
 * Careful: **with no config it stops quietly, it does not crash**, but it
 * writes a line to the log once at startup. Otherwise six months later
 * someone would be hunting for "why does nothing arrive in Teams", with the
 * answer hidden in `.env`.
 */
@Injectable()
export class TeamsChannel {
  private readonly logger = new Logger(TeamsChannel.name);
  private readonly webhook: string;

  /**
   * Careful: how long to wait for the send. The weekly job runs at night, so
   * slowness does no harm, but it **must not be left without a limit**:
   * otherwise if Teams did not respond the job would hang forever and next
   * week's job would not run either.
   */
  private static readonly TimeoutMs = 15_000;

  constructor(config: ConfigService) {
    this.webhook = config.get<string>('TEAMS_WEBHOOK_URL')?.trim() ?? '';

    if (!this.configured) {
      this.logger.log('No TEAMS_WEBHOOK_URL — Teams channel disabled');
    }
  }

  get configured(): boolean {
    /**
     * Careful: not just "non-empty" but **https too**. If http were set by
     * mistake the summary (staff names and hours) would go in plaintext. That
     * cannot be allowed to happen silently, so it is blocked here.
     */
    return this.webhook.startsWith('https://');
  }

  /**
   * One send. Careful: it **never throws**; the weekly job depends on it, and
   * Teams being down does not mean losing the numbers.
   */
  async send(title: string, text: string): Promise<TeamsOutcome> {
    if (!this.configured) return 'not_configured';

    try {
      const res = await fetch(this.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(teamsCard(title, text)),
        signal: AbortSignal.timeout(TeamsChannel.TimeoutMs),
      });

      /**
       * Careful: **200 does not mean it arrived.** Power Automate returns 200
       * even when the card structure is wrong, and nothing shows in the
       * channel: a silent failure. So the structure is kept pure in
       * `teams.card.ts` and **pinned in tests**; only the HTTP layer can be
       * seen here, and that is what is honestly reported.
       */
      if (!res.ok) {
        this.logger.warn(`Teams refused the message — HTTP ${res.status}`);
        return 'failed';
      }

      return 'sent';
    } catch (err) {
      // Careful: timeout, DNS, cert: all of them land here. The message is not
      // lost, because on failure the caller keeps the full text in the log.
      this.logger.warn(
        `Could not reach Teams: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'failed';
    }
  }
}
