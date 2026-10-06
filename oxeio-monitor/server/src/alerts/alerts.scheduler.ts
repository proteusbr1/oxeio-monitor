import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { AgentDownCheck } from './agent-down.check';
import { AgentTamperCheck } from './agent-tamper.check';
import {
  SYNTHETIC_INPUT_TICK_MS,
  AGENT_DOWN_TICK_MS,
  DISK_TICK_MS,
  DISPATCH_TICK_MS,
  NO_ACTIVITY_TICK_MS,
  OVERLAP_TICK_MS,
  STARTUP_GRACE_MIN,
  TAMPER_TICK_MS,
} from './alerts.constants';
import { AlertDispatcher } from './alerts.dispatcher';
import { isWithinStartupGrace } from './alerts.rules';
import { DeviceOverlapCheck } from './device-overlap.check';
import { DiskCheck } from './disk.check';
import { NoActivityCheck } from './no-activity.check';
import { SyntheticInputCheck } from './synthetic-input.check';

/**
 * All of the alert module's scheduled checks run from here.
 *
 * Careful: `@nestjs/schedule` is deliberately not used here, even though the
 * rollup job (`src/summary/`) uses it. `ScheduleModule.forRoot()` is a
 * **global** module and its explorer scans **all** providers of the app for
 * `@Cron`. So whether my checks run would depend on who put `forRoot` where.
 * For alerts the cost of getting that wrong is high: if they do not run nobody
 * knows, and if they run twice the emails double. A plain `setInterval` is
 * less clever, but the behavior here is fully predictable, and with no `@Cron`
 * decorator an outside explorer finds nothing in this class.
 */
@Injectable()
export class AlertsScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AlertsScheduler.name);
  private readonly bootedAt = new Date();
  private readonly timers: NodeJS.Timeout[] = [];
  /** Careful: if the previous round is still running, the next is skipped (no pile-up) */
  private readonly running = new Set<string>();

  constructor(
    private readonly agentDown: AgentDownCheck,
    private readonly tamper: AgentTamperCheck,
    private readonly disk: DiskCheck,
    private readonly noActivity: NoActivityCheck,
    private readonly overlap: DeviceOverlapCheck,
    private readonly synthetic: SyntheticInputCheck,
    private readonly dispatcher: AlertDispatcher,
  ) {}

  onApplicationBootstrap(): void {
    // Careful: no timers in tests. Otherwise a check would fire mid-test, raise
    // alerts on another agent's fixtures, and failures would show up at random.
    // Every check has a `runOnce()`, which is what tests call.
    if (process.env.NODE_ENV === 'test') {
      this.logger.log('NODE_ENV=test — alert scheduler not started');
      return;
    }

    this.schedule('agent-down', AGENT_DOWN_TICK_MS, async (now) => {
      // Closing the open alerts of returned agents also runs **outside** the
      // grace: an agent that has already checked in after the restart should
      // have its stale agent_down cleared right away. This never raises a
      // false alert, it only closes, so there is no reason to hold it back in the grace.
      await this.agentDown.resolveReturned(now);

      // The server has just started: everyone looks silent (because we were not there)
      if (isWithinStartupGrace(this.bootedAt, now)) {
        this.logger.debug(
          `startup grace (${STARTUP_GRACE_MIN}m) — agent_down check not yet`,
        );
        return 0;
      }
      return this.agentDown.runOnce(now);
    });

    this.schedule('agent-tamper', TAMPER_TICK_MS, (now) =>
      this.tamper.runOnce(now),
    );
    this.schedule('disk', DISK_TICK_MS, (now) => this.disk.runOnce(now));
    this.schedule('no-activity', NO_ACTIVITY_TICK_MS, (now) =>
      this.noActivity.runOnce(now),
    );
    this.schedule('device-overlap', OVERLAP_TICK_MS, (now) =>
      this.overlap.runOnce(now),
    );
    // Synthetic input. Runs on the server, so it cannot be switched off from
    // the machine of the person under suspicion.
    this.schedule('synthetic-input', SYNTHETIC_INPUT_TICK_MS, (now) =>
      this.synthetic.runOnce(now),
    );
    this.schedule('dispatch', DISPATCH_TICK_MS, (now) =>
      this.dispatcher.runOnce(now),
    );

    this.logger.log('Alert checks started (G01 · G02 · G03 · G06 · G07 · G32 · G46)');
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  /**
   * For running by hand: every check once.
   * Works even while the scheduler is off (e.g. in tests).
   */
  async runAllOnce(now = new Date()): Promise<number> {
    const counts = await Promise.all([
      this.agentDown.runOnce(now),
      this.tamper.runOnce(now),
      this.disk.runOnce(now),
      this.noActivity.runOnce(now),
      this.overlap.runOnce(now),
    ]);
    // Close open agent_down alerts of returned agents (not counted in the raise count)
    await this.agentDown.resolveReturned(now);
    await this.dispatcher.runOnce(now);
    return counts.reduce((a, b) => a + b, 0);
  }

  private schedule(
    name: string,
    everyMs: number,
    task: (now: Date) => Promise<number>,
  ): void {
    const timer = setInterval(() => {
      void this.tick(name, task);
    }, everyMs);

    // unref: the timer must not keep the process alive. Otherwise Node would
    // keep waiting even after the shutdown hook ran, delaying a container restart.
    timer.unref();
    this.timers.push(timer);
  }

  /**
   * Every tick is wrapped in try/catch.
   *
   * A rejected promise escaping a setInterval callback is an unhandled
   * rejection in Node, and that takes the whole server down. A brief database
   * timeout must never cost us "monitoring stopped".
   */
  private async tick(
    name: string,
    task: (now: Date) => Promise<number>,
  ): Promise<void> {
    if (this.running.has(name)) {
      this.logger.warn(`${name} check: previous run still going — skipping this tick`);
      return;
    }

    this.running.add(name);
    try {
      await task(new Date());
    } catch (err) {
      this.logger.error(
        `${name} check failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.running.delete(name);
    }
  }
}
