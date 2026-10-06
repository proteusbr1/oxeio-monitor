import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { JOB_TIMEZONE, RunLock, SCHEDULING_ENABLED } from './scheduling';
import { type DrainResult, SummaryService } from './summary.service';

export interface SummaryRefreshResult {
  workDate: Date | null;
  employees: number;
  /** The call returned because the previous run was still going. */
  skipped: boolean;
  ms: number;
  /**
   * How many late-arriving old days were recomputed in this tick.
   * Careful: `null` when `skipped`; nothing ran.
   */
  drained: DrainResult | null;
}

/**
 * **Summary refresh**: every 15 minutes, today's `daily_summary` (and the
 * current month's rollup).
 *
 * Why a rollup at all: the Live Board, heatmap and pace cards would
 * otherwise have to merge `activity_segments` every time, over about a
 * hundred thousand rows a month for 15 people. A 15-minute-old number is
 * fine here, because "who is online right now" is answered from the
 * heartbeat, not from the rollup.
 */
@Injectable()
export class SummaryRefreshJob {
  private readonly logger = new Logger(SummaryRefreshJob.name);
  private readonly lock = new RunLock();

  constructor(private readonly summary: SummaryService) {}

  /**
   * Careful: **`:05/:20/:35/:50`**, not `:00/:15/:30/:45`. The interval is
   * still exactly 15 minutes, just shifted by five. Day close runs at exactly
   * 00:15; if two jobs upserted the same `monthly_summary` row at the same
   * moment, this job could later overwrite it with a monthly total read
   * **before** yesterday's summary finished writing. The upsert itself is
   * atomic, so no data would be corrupted, but the monthly number would stay
   * 15 minutes stale until the next tick. Shifting by five minutes means the
   * collision never happens.
   *
   * Careful: `disabled` plus the `if` below are two locks, and both are needed.
   *
   * In tests `SummaryModule` does not import `ScheduleModule.forRoot()`, so
   * the decorator is just metadata. But if someone building K02/K04 adds
   * `ScheduleModule.forRoot()` to `app.module.ts`, its explorer scans
   * **every** provider in the app, and this method would suddenly go live.
   * Hence a second lock outside the decorator.
   */
  @Cron('0 5,20,35,50 * * * *', {
    name: 'summary-refresh',
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    // If the previous run has not finished, skip the next tick entirely; there is no point
    // piling up and running the same update on the database several times.
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    if (!SCHEDULING_ENABLED) return;
    await this.runOnce();
  }

  /** Tests (or a future admin endpoint) can call this deliberately. */
  async runOnce(now: Date = new Date()): Promise<SummaryRefreshResult> {
    const startedAt = Date.now();

    /**
     * Careful: **both jobs go inside the same lock**: today first, then the
     * late-arriving old days. With separate locks they could run at once and
     * both upsert the same `monthly_summary` row.
     *
     * The order is deliberate too: today first, since that is what everyone
     * is looking at on screen.
     */
    const result = await this.lock.run(async () => {
      const today = await this.summary.refreshToday(now);
      const drained = await this.summary.drainDirty(now);
      return { today, drained };
    });

    if (result === null) {
      this.logger.warn('Previous summary refresh still going — skipping this tick');
      return { workDate: null, employees: 0, skipped: true, ms: 0, drained: null };
    }

    const { today, drained } = result;
    const ms = Date.now() - startedAt;
    this.logger.log(
      `summary refresh: ${today.workDate.toISOString().slice(0, 10)} · ` +
        `${today.employees} staff · ${ms}ms` +
        // Careful: counting old days is **always** logged. Silently changing
        // history is exactly what nobody could explain later.
        (drained.refreshed > 0 || drained.closed > 0 || drained.pending > 0
          ? ` · late days: ${drained.refreshed} recomputed` +
            (drained.closed > 0 ? `, ${drained.closed} in a closed month` : '') +
            (drained.pending > 0 ? `, ${drained.pending} still queued` : '')
          : ''),
    );

    return {
      workDate: today.workDate,
      employees: today.employees,
      skipped: false,
      ms,
      drained,
    };
  }
}
