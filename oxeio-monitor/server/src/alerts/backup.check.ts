import { Injectable, Logger } from '@nestjs/common';

import { BackupService } from '../ops/backup.service';
import { BackupStateStore } from '../ops/backup.state';
import { backupAlertText, backupVerdict } from '../ops/ops.rules';
import { AlertsService } from './alerts.service';

/**
 * **G04**: alert when a backup fails.
 *
 * **When a backup succeeds, this class says nothing.** There is no "backup
 * went fine" email. Daily confirmations end up in a filter within a week, and
 * so does the message for the day the backup did **not** happen; reporting
 * every day is the surest way to lose the news in the end.
 *
 * The check is **separate** from the backup job, and that is its main value.
 * The job can report a failure only if it runs. The most dangerous state is
 * the job not running at all: the server was down at 3:30 AM, the scheduler
 * was not registered, or the container is in a crash loop. The only way to
 * catch that silence is to look at the clock from outside: "how many hours
 * ago was the last successful backup?"
 *
 * Careful: `type` is always `backup_failed` and deviceId/employeeId are both
 * null, so the throttle key is just the type (one per server), one per 6 hours.
 */
@Injectable()
export class BackupCheck {
  private readonly logger = new Logger(BackupCheck.name);

  constructor(
    private readonly state: BackupStateStore,
    private readonly backup: BackupService,
    private readonly alerts: AlertsService,
  ) {}

  /**
   * BACKUP_MODE=external: nothing to watch here — and an alert left open
   * from before the switch ("backup not configured") is closed.
   *
   * Also called at boot and when the mode is saved on screen: the hourly
   * tick starts over at every restart, so waiting for it kept a stale
   * "BACKUP_PASSPHRASE is not set" open long after the switch.
   */
  async closeIfExternal(now = new Date()): Promise<boolean> {
    if (!(await this.backup.isExternal())) return false;

    await this.alerts.resolveOpenOfType(
      'backup_failed',
      'BACKUP_MODE=external — the database is backed up outside oXeio',
      now,
    );
    return true;
  }

  async runOnce(now = new Date()): Promise<number> {
    if (await this.closeIfExternal(now)) return 0;

    const snapshot = await this.state.read(this.backup.configured);
    const verdict = backupVerdict(snapshot, now);

    // Everything is fine: nothing to say
    if (!verdict) return 0;

    const { title, detail } = backupAlertText(verdict);

    this.logger.warn(`Backup problem (${verdict.problem}): ${title}`);

    return this.alerts.raiseMany(
      [
        {
          type: 'backup_failed',
          severity: verdict.severity,
          deviceId: null,
          employeeId: null,
          title,
          detail:
            detail +
            // The last error message is appended because without it the owner
            // would have to log into the server and read the logs, and then the
            // alert would only cause worry, not give direction.
            (snapshot.lastError ? ` (last error: ${snapshot.lastError})` : ''),
          meta: {
            problem: verdict.problem,
            hoursSinceSuccess: verdict.hoursSinceSuccess,
            consecutiveFailures: snapshot.consecutiveFailures,
          },
        },
      ],
      now,
    );
  }
}
