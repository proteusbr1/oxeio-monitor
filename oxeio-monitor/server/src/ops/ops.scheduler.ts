import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { BackupCheck } from '../alerts/backup.check';
import { TelegramChannel } from '../alerts/telegram.channel';
import { BACKUP_CHECK_TICK_MS, TELEGRAM_TICK_MS } from './ops.constants';

/**
 * G04's periodic check and G08's Telegram sweep.
 *
 * Like `AlertsScheduler`, a plain `setInterval`, not `@Cron`, for the same
 * reason: neither of these runs "at a specific time of day", and with `@Cron`
 * whether they run would depend on another module's `ScheduleModule.forRoot()`.
 * The nightly backup accepts that dependency (it needs a daily time with a
 * timezone), but here it is not needed.
 *
 * No timers in tests: otherwise during a test the sweep would set
 * `channels_sent` on alerts from another agent's fixtures, and failures would
 * show up in random places.
 */
@Injectable()
export class OpsScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OpsScheduler.name);
  private readonly timers: NodeJS.Timeout[] = [];
  /** If the previous round is still running, skip the next */
  private readonly running = new Set<string>();

  constructor(
    private readonly backupCheck: BackupCheck,
    private readonly telegram: TelegramChannel,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') {
      this.logger.log('NODE_ENV=test — ops scheduler not started');
      return;
    }

    this.schedule('backup-check', BACKUP_CHECK_TICK_MS, (now) =>
      this.backupCheck.runOnce(now),
    );
    // external mode: close a leftover backup alert now, not an hour from now
    void this.tick('backup-close', async (now) => {
      await this.backupCheck.closeIfExternal(now);
      return 0;
    });

    /**
     * **Set up unconditionally, on purpose.**
     *
     * It used to check `configured` first, but now the owner can set the token
     * from the screen **while the server runs**. With a startup condition they
     * would save, nothing would happen, and there would be no way to learn why
     * until the server restarted.
     *
     * With no config `runOnce()` returns zero anyway, so the cost is negligible.
     */
    this.schedule('telegram', TELEGRAM_TICK_MS, (now) =>
      this.telegram.runOnce(now),
    );

    this.logger.log(
      'ops checks started (G04 · G08)',
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  /** For manual runs; works even when the scheduler is off (e.g. in tests) */
  async runAllOnce(now = new Date()): Promise<number> {
    const raised = await this.backupCheck.runOnce(now);
    await this.telegram.runOnce(now);
    return raised;
  }

  private schedule(
    name: string,
    everyMs: number,
    task: (now: Date) => Promise<number>,
  ): void {
    const timer = setInterval(() => {
      void this.tick(name, task);
    }, everyMs);

    // unref: the timer must not keep the process alive
    timer.unref();
    this.timers.push(timer);
  }

  /**
   * Every tick is wrapped in try/catch: a rejected promise escaping a
   * `setInterval` callback brings the whole server down in Node. Monitoring
   * stopping while checking on the backup would be absurd.
   */
  private async tick(
    name: string,
    task: (now: Date) => Promise<number>,
  ): Promise<void> {
    if (this.running.has(name)) return;

    this.running.add(name);
    try {
      await task(new Date());
    } catch (err) {
      this.logger.error(
        `${name} check failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.running.delete(name);
    }
  }
}
