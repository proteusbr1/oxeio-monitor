import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { JOB_TIMEZONE, RunLock, SCHEDULING_ENABLED } from '../summary/scheduling';
import { DigestService, type DigestResult } from './digest.service';

/**
 * F07 — the daily digest at **6:30 pm (work zone)** every day.
 *
 * Careful: without `timeZone` the cron would run in the server's own time zone
 * (almost always UTC in Docker) — "6:30 pm" would then really be 12:30 am in
 * a UTC+6 zone such as Asia/Dhaka, so the email would arrive in the early hours of the next day and
 * "today's hours" would really be yesterday's.
 *
 * Careful: `disabled` **and** the `if` below — two locks, both needed (see the
 * same note in [summary-refresh.job.ts](../summary/summary-refresh.job.ts)).
 * Otherwise a single tick in tests would pick up someone else's fixtures in
 * the shared DB while building the report, and tests would break at random.
 *
 * Careful: `ScheduleModule.forRoot()` is **not** placed here — `SummaryModule`
 * does it and it is global. With two `forRoot()` calls, two explorers would
 * register the same job twice and crash at bootstrap (and until then the email
 * went out twice a day). So in tests (where `SummaryModule` builds no explorer)
 * this `@Cron` is just metadata.
 */
@Injectable()
export class DigestJob {
  private readonly logger = new Logger(DigestJob.name);
  private readonly lock = new RunLock();

  constructor(private readonly digest: DigestService) {}

  @Cron('0 30 18 * * *', {
    name: 'daily-digest',
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    if (!SCHEDULING_ENABLED) return;
    await this.runOnce();
  }

  /**
   * For tests or manual runs.
   *
   * **Never throws.** The digest is a helper to monitoring; a dead SMTP, or a
   * 500 thrown by `ReportsService` because the work policy was deleted — neither
   * should stop hour counting or taking agent data. A rejected promise escaping
   * a `setInterval`/cron callback is an unhandled rejection in Node, and that
   * brings the whole process down.
   */
  async runOnce(now: Date = new Date()): Promise<DigestResult | null> {
    const result = await this.lock.run(async () => {
      try {
        return await this.digest.runOnce(now);
      } catch (err) {
        this.logger.error(
          `Could not build the daily digest: ${err instanceof Error ? err.message : 'unknown error'}`,
          err instanceof Error ? err.stack : undefined,
        );
        return null;
      }
    });

    if (result === null) {
      // `null` can mean two things — the previous run is still going, or the catch above.
      // Both are visible separately in the log, so there is nothing more to say here.
      return null;
    }

    return result;
  }
}
