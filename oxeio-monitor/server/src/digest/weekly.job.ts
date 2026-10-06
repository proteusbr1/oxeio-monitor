import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { JOB_TIMEZONE, RunLock, SCHEDULING_ENABLED } from '../summary/scheduling';
import { weeklyScheduleOf } from './weekly.rules';
import { WeeklyDigestService, type WeeklyDigestResult } from './weekly.service';

/**
 * Careful: `process.env` is read **directly**, not through `ConfigService` —
 * deliberately, for the same reason as `summary/scheduling.ts`. The `@Cron(...)`
 * expression and options are evaluated **when the class is defined**, i.e. at
 * the moment the file is imported; Nest's DI container is not born yet, so
 * nothing injected is available.
 */
const SCHEDULE = weeklyScheduleOf(
  process.env.WEEKLY_DIGEST_DAY,
  process.env.WEEKLY_DIGEST_HOUR,
);

/**
 * **R3** — a summary to the owner's Telegram once a week.
 * Default Friday 6:00 pm (Dhaka); change with `WEEKLY_DIGEST_DAY` /
 * `WEEKLY_DIGEST_HOUR`.
 *
 * Careful: without `timeZone` the cron would run in the server's own time zone
 * (almost always UTC in Docker) — "Friday 6 pm" would then really be 12 am
 * **Saturday** in Dhaka, so the message would arrive on the first day of the
 * next week and the window would also shift by a day. For a day-based cron the
 * mistake does more harm than for the daily one: the weekday changes too.
 *
 * Careful: `disabled` **and** the `if` below — two locks, both needed (see the
 * note in `summary/summary-refresh.job.ts`).
 *
 * Careful: `ScheduleModule.forRoot()` is **not** placed here — `SummaryModule`
 * does it and it is global. With two `forRoot()` calls, two explorers would
 * register the same job twice, and until then the message went out twice a week.
 */
@Injectable()
export class WeeklyDigestJob {
  private readonly logger = new Logger(WeeklyDigestJob.name);
  private readonly lock = new RunLock();

  constructor(private readonly weekly: WeeklyDigestService) {
    // Careful: a bad env value does not silently fall back to the default.
    // Otherwise someone writing `WEEKLY_DIGEST_DAY=Friday` would wait for
    // Monday, and the only way to realise "it is not working" would be the
    // message not arriving seven days later.
    for (const problem of SCHEDULE.ignored) this.logger.error(problem);

    this.logger.log(
      `Weekly summary scheduled for ISO day ${SCHEDULE.isoDay} at ` +
        `${String(SCHEDULE.hour).padStart(2, '0')}:00 ${JOB_TIMEZONE}`,
    );
  }

  @Cron(SCHEDULE.expression, {
    name: 'weekly-digest',
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
   * **Never throws** — like `DigestJob`. The weekly summary is a helper to
   * monitoring; a dead Telegram token, or a 500 thrown by `ReportsService`
   * because the work policy was deleted — neither should stop hour counting or
   * taking agent data. A rejected promise escaping a cron callback is an
   * unhandled rejection in Node, and that brings the whole process down.
   *
   * `null` can come back for two reasons — the previous run is still going
   * (`RunLock`), or the catch below. Both are visible separately in the log, so
   * the calling code does not need to tell them apart.
   */
  async runOnce(now: Date = new Date()): Promise<WeeklyDigestResult | null> {
    return this.lock.run(async () => {
      try {
        return await this.weekly.runOnce(now);
      } catch (err) {
        this.logger.error(
          `Could not build the weekly summary: ${err instanceof Error ? err.message : 'unknown error'}`,
          err instanceof Error ? err.stack : undefined,
        );
        return null;
      }
    });
  }
}
