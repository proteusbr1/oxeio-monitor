import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { workDateOf } from '../agent/util/work-time';
import { FeaturesService } from '../features/features.service';
import { JOB_TIMEZONE, RunLock, SCHEDULING_ENABLED } from '../summary/scheduling';
import { TasksService } from './tasks.service';

/**
 * Every day at 08:00 (work zone): hand out tasks from the pool to everyone who
 * receives tasks.
 *
 * The time is shortly before work starts, so the list is ready when people sit
 * down and nobody has to press anything.
 *
 * Without `timeZone`, cron would run in the server's own timezone (UTC in
 * Docker), so "8 am" would be a different hour in the work zone.
 *
 * Careful: `disabled` and the `if` below are two locks and both are needed.
 * Without them, one tick during tests would distribute into other people's
 * fixtures on the shared DB.
 *
 * Important: it also runs on holidays, on purpose. The hand-out does not
 * count hours; skipping holidays would leave some hands empty the next
 * morning. Someone who already holds 30 gets nothing anyway.
 */
@Injectable()
export class TasksJob {
  private readonly logger = new Logger(TasksJob.name);
  private readonly lock = new RunLock();
  /** Separate lock so returning and distributing never block each other */
  private readonly returnLock = new RunLock();
  /** Top-up has its own lock so the hourly tick never blocks distribution */
  private readonly topUpLock = new RunLock();

  constructor(
    private readonly tasks: TasksService,
    private readonly features: FeaturesService,
  ) {}

  /** Tasks switched off in Settings → Modules: hand out nothing */
  private async off(): Promise<boolean> {
    return !(await this.features.isOn('tasks'));
  }

  @Cron('0 0 8 * * *', {
    name: 'task-distribution',
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    if (!SCHEDULING_ENABLED) return;
    await this.runOnce();
  }

  /**
   * End of day: return untouched tasks to the pool.
   *
   * Important: 23:55, not 08:00, on purpose. Returning right before the
   * morning hand-out would pull tasks out of the hands of someone who
   * started work at 07:00. Doing it at night leaves the morning list clean.
   *
   * It runs before midnight because once the date rolls over, the answer to
   * "was this touched today?" changes, and today's in-progress tasks would
   * be returned as well.
   *
   * Also runs on holidays: the hand-out does not count hours, and there is no
   * reason to keep hands full on a holiday.
   */
  @Cron('0 55 23 * * *', {
    name: 'task-return',
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async returnScheduled(): Promise<void> {
    if (!SCHEDULING_ENABLED) return;
    await this.returnOnce();
  }

  /**
   * Hourly check of each assignee's hand during working hours.
   *
   * Important: this is not a copy of the morning hand-out. That one tops
   * everybody up to 30; this only touches people who could not reach 25 today.
   * If a hand is full, `topUpSize()` returns 0, so most ticks do nothing.
   *
   * Running only after an event (`markDone`/`skip`) is not enough: someone with
   * zero tasks can never trigger one, yet they are exactly who the rule is
   * for. This happens when the pool is short in the morning, because
   * `allocationSizes` serves staff in code order and the last person gets none.
   *
   * 9:00-19:00 only, since nobody works outside that and scanning the pool is
   * pointless. Minute 5 rather than on the hour, to avoid needless database
   * load when other jobs run at the same time.
   */
  @Cron('0 5 9-19 * * *', {
    name: 'task-top-up',
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async topUpScheduled(): Promise<void> {
    if (!SCHEDULING_ENABLED) return;
    await this.topUpOnce();
  }

  /** For tests or manual runs. Never throws. */
  async topUpOnce(now: Date = new Date()): Promise<void> {
    await this.topUpLock.run(async () => {
      try {
        if (await this.off()) return;
        await this.tasks.topUpAll(now);
      } catch (err) {
        this.logger.error(
          `Top-up sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  /** For tests or manual runs. Never throws. */
  async returnOnce(now: Date = new Date()): Promise<void> {
    await this.returnLock.run(async () => {
      try {
        if (await this.off()) return;
        await this.tasks.returnUnworked(workDateOf(now));
      } catch (err) {
        this.logger.error(
          `Return failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  /** For tests or manual runs. Never throws. */
  async runOnce(now: Date = new Date()): Promise<void> {
    await this.lock.run(async () => {
      try {
        if (await this.off()) return;
        await this.tasks.distribute(now);
      } catch (err) {
        this.logger.error(
          `Distribution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}
