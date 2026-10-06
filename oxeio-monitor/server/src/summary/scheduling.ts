/**
 * Shared safeguards for the three scheduled jobs (summary refresh, day close, retention).
 *
 * Careful: `process.env` is read directly here, not through `ConfigService`,
 * on purpose. The options of the `@Cron(...)` decorator are evaluated **when
 * the class is defined**, i.e. the moment the file is imported, before Nest's
 * DI container exists. No injected service can be reached there.
 */

import { WORK_TIMEZONE } from '../agent/util/work-time';

/**
 * The scheduler is completely off in tests.
 *
 * Careful: this is the most important line in the module. If the retention
 * job ticked once during a test, it would delete fixture screenshots **and
 * the files on disk**, and the failing test would show up somewhere else,
 * with a cause that is almost impossible to find.
 */
export const SCHEDULING_ENABLED = process.env.NODE_ENV !== 'test';

/**
 * Careful: every daily `@Cron` must pass this. Without it cron would run in
 * the server's own time zone (almost always UTC in Docker), so "00:15 at
 * night" would really be 6:15 pm, and the day-close job would run in the
 * middle of the day and mark an incomplete day as "final".
 */
// Same zone as every work date (`WORK_TIMEZONE`, default Asia/Dhaka)
export const JOB_TIMEZONE = WORK_TIMEZONE;

/** A job runs only once at a time, within the same process. */
export class RunLock {
  private running = false;

  /**
   * `null` if already running, otherwise the result of `fn()`.
   *
   * Careful: this guards only **inside** the process. `@Cron`'s
   * `waitForCompletion` stops two consecutive ticks, but a test or a future
   * admin endpoint calling `runOnce()` directly could overlap with a tick.
   *
   * Careful: it does not stop multiple **instances**. In v1 there is a single
   * `oxeio-api` container (07 section 6.1), so this is enough. If it is ever
   * scaled out, a Postgres advisory lock will be needed, and then remember
   * that `pg_advisory_lock` is **session-based**: if unlock goes to another
   * connection from Prisma's pool, the lock is never released. Use
   * `pg_try_advisory_xact_lock` inside a `$transaction` instead; it releases
   * itself on commit.
   */
  async run<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.running) return null;

    this.running = true;
    try {
      return await fn();
    } finally {
      // Without `finally`, a single exception would leave the job stuck as
      // "running" forever, and it would never run again until a server restart.
      this.running = false;
    }
  }
}
