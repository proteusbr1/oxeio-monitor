import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';

import { nextLocalMidnight } from '../agent/util/work-time';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_TIMEZONE, RunLock, SCHEDULING_ENABLED } from './scheduling';
import { previousWorkDate } from './summary.math';
import { SummaryService } from './summary.service';

export interface DayCloseResult {
  /** The work date that was closed. */
  workDate: Date | null;
  sessionsClosed: number;
  employees: number;
  skipped: boolean;
}

/**
 * **Day close**: close sessions left open, finalise that day's summary,
 * update the monthly rollup.
 *
 * **Runs at 00:15, for the previous day, not at 23:30.** The K05 row in
 * 04-Features still says the old "11:30 pm", but that decision predates G30.
 * Since shifts were abolished, work after 11 pm is normal, so finalising the
 * day at 23:30 would leave out the last half hour of exactly the people who
 * work at night, every day.
 * Sources: [07 section 2.1-a and 6.4](../../../docs/07-Technical-Spec.md),
 * [08 G30](../../../docs/08-Gap-Analysis.md),
 * [02 daily layout](../../../docs/02-Workflow.md).
 *
 * Careful: "close" does **not** mean accumulating hours. Work time comes
 * only from `activity_segments`; closing sessions is bookkeeping so that
 * `ended_at` is not NULL forever (G24). So even if this job does not run,
 * nobody loses a second of hours; only the summary stays stale.
 */
@Injectable()
export class DayCloseJob {
  private readonly logger = new Logger(DayCloseJob.name);
  private readonly lock = new RunLock();

  constructor(
    private readonly prisma: PrismaService,
    private readonly summary: SummaryService,
  ) {}

  /** Careful: without `timeZone` this would run at 00:15 UTC = 6:15 am in a UTC+6 zone. */
  @Cron('0 15 0 * * *', {
    name: 'day-close',
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    // Careful: second lock; the reason is explained in `summary-refresh.job.ts`.
    if (!SCHEDULING_ENABLED) return;
    await this.runOnce();
  }

  /**
   * Closes the work day **before** `now`.
   *
   * Careful: the current day is deliberately left alone. At 00:15 many PCs
   * are still on, and closing their sessions now would cut the timeline midway.
   */
  async runOnce(now: Date = new Date()): Promise<DayCloseResult> {
    const target = previousWorkDate(now);

    const result = await this.lock.run(async () => {
      const sessionsClosed = await this.closeStaleSessions(target);
      const refreshed = await this.summary.refreshDate(target, now);
      return { sessionsClosed, employees: refreshed.employees };
    });

    if (result === null) {
      this.logger.warn('Previous day-close still going — skipping this tick');
      return { workDate: null, sessionsClosed: 0, employees: 0, skipped: true };
    }

    this.logger.log(
      `day-close ${target.toISOString().slice(0, 10)} · ` +
        `${result.sessionsClosed} sessions closed · summaries for ${result.employees} staff`,
    );

    return { workDate: target, ...result, skipped: false };
  }

  /**
   * Closes every `work_session` at or before `target` that is still open
   * (agent crash, PC unplugged, or an old agent).
   *
   * Careful: `ended_at` is set to **the session's own midnight**, not `now`.
   * This is the one silent trap here: closing an 11 August session at 00:15
   * on 12 August with "now" would push the session 15 minutes into the next
   * date, and the timeline would show a session in the early hours of
   * 12 August that never existed. (`ingest.service.ts` uses
   * `nextLocalMidnight` for the same reason, so `end_reason` is the same too:
   * `day_rollover`.)
   */
  private async closeStaleSessions(target: Date): Promise<number> {
    const open = await this.prisma.workSession.findMany({
      where: { endedAt: null, workDate: { lte: target } },
      select: { id: true, startedAt: true },
    });

    if (open.length === 0) return 0;

    // Sessions that fall on the same midnight go together, not one UPDATE per row.
    const byMidnight = new Map<number, bigint[]>();
    for (const s of open) {
      const at = nextLocalMidnight(s.startedAt).getTime();
      const ids = byMidnight.get(at);
      if (ids) ids.push(s.id);
      else byMidnight.set(at, [s.id]);
    }

    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const [at, ids] of byMidnight) {
      ops.push(
        this.prisma.workSession.updateMany({
          where: { id: { in: ids } },
          data: { endedAt: new Date(at), endReason: 'day_rollover' },
        }),
      );
    }

    await this.prisma.$transaction(ops);

    return open.length;
  }
}
