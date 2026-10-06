import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';

import { BackupCheck } from '../alerts/backup.check';
import { JOB_TIMEZONE, SCHEDULING_ENABLED } from '../summary/scheduling';
import { BackupService, type BackupResult } from './backup.service';
import { BACKUP_CRON } from './ops.constants';

/** Name used to look the job up in `SchedulerRegistry`; same as the `@Cron` name */
const JOB_NAME = 'db-backup';

/**
 * **K02 · K03** — the 03:30 nightly backup (spec § 6.4).
 *
 * Careful: `ScheduleModule.forRoot()` is deliberately **not** added here.
 * `SummaryModule` already does it, and forRoot is **global**: its explorer
 * scans every provider in the app, so this `@Cron` is picked up anyway. Calling
 * forRoot twice would make two explorers register the same job name twice and
 * crash at bootstrap.
 *
 * Careful: that dependency is **invisible**. If someone removed `SummaryModule`
 * or changed the test-mode condition, the backup would silently stop, and it
 * would be discovered on the day of a restore. So bootstrap checks that the job
 * really is registered and complains loudly if not. (G04 would catch it too,
 * but 26 hours later; this catches it immediately.)
 */
@Injectable()
export class BackupJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupJob.name);

  constructor(
    private readonly backup: BackupService,
    private readonly check: BackupCheck,
    /**
     * `@Optional()`: tests never load `ScheduleModule`, so this provider is not
     * in the container. Without Optional the whole app would fail to bootstrap
     * in tests.
     */
    @Optional()
    @Inject(SchedulerRegistry)
    private readonly registry: SchedulerRegistry | null,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!SCHEDULING_ENABLED) return;

    const registered = (() => {
      try {
        return this.registry?.doesExist('cron', JOB_NAME) ?? false;
      } catch {
        return false;
      }
    })();

    if (!registered) {
      this.logger.error(
        `The nightly backup job (${JOB_NAME}) was not registered — is ScheduleModule.forRoot() ` +
          'present anywhere? Backups will not run in this state.',
      );
      return;
    }

    this.logger.log(
      (await this.backup.isExternal())
        ? 'Nightly backup off — the database is backed up by another tool (BACKUP_MODE=external)'
        : `Nightly backup enabled (${BACKUP_CRON}, ${JOB_TIMEZONE})` +
            (this.backup.configured ? '' : ' — but there is no BACKUP_PASSPHRASE, so it will not run'),
    );
  }

  /**
   * Without `timeZone`, 03:30 UTC is 09:30 in Asia/Dhaka (UTC+6): a dump over the whole
   * database right as the office starts. The heaviest job at the busiest time.
   */
  @Cron(BACKUP_CRON, {
    name: JOB_NAME,
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    // Second lock: besides `disabled`, same as the retention job
    if (!SCHEDULING_ENABLED) return;
    await this.runOnce();
  }

  /**
   * The backup, then the G04 check right away.
   *
   * The check is called here so news of a failure does not wait up to an hour.
   * The periodic check (`OpsScheduler`) keeps running separately; its job is
   * different: catching the state where the job **never ran at all**, in which
   * case this line would never have run.
   */
  async runOnce(now = new Date()): Promise<BackupResult> {
    const result = await this.backup.runOnce(now);
    await this.check.runOnce(new Date());
    return result;
  }
}
