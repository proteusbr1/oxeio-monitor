import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * The actions written to `audit_log` (see spec § 2).
 * Screenshot viewing, report export and so on will be added in later modules.
 */
export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'change_password'
  | 'reset_password'
  | 'create_portal_account'
  | 'change_login_email'
  | 'view_screenshot'
  | 'export_report'
  /** Viewing salary: the most sensitive read, so its own action ([ADR-023](../../../docs/05-Options-Decisions.md)) */
  | 'payroll_view'
  | 'change_setting'
  | 'create_enrollment_code'
  | 'revoke_device'
  | 'upload_policy_doc'
  /**
   * **The one condition for rollout**: "no agent goes on anyone's PC without
   * a signature" ([01 § Rollout](../../../docs/01-Planning.md)). If who
   * recorded whose signature and when were merged into `change_setting`, six
   * months later the question "was their signature really taken?" could not be answered.
   *
   * Careful: `upload_policy_doc` is kept separate: that is for uploading a
   * scanned copy, which does not exist yet. This one only sets the **date**.
   */
  | 'policy_signed'
  /** A signature was recorded by mistake and taken back; rare, hence separate. */
  | 'policy_signed_cleared'
  | 'time_adjustment'
  | 'time_adjustment_revoke'
  /**
   * R1: month closed/reopened. This is **the moment the basis for pay is
   * fixed**, hence separate actions: merged into `change_setting`, the
   * question "when was August's calculation frozen, and who did it" could not
   * be answered six months later.
   *
   * Careful: keeping `month_reopened` **separate is the most important
   * part**. If someone reopens a month after pay and changes the numbers, it
   * is the only evidence. Merging the reopening record with the closing
   * record would erase the history.
   */
  | 'month_closed'
  | 'month_reopened'
  /**
   * **Marking a completed design as "not complete".**
   *
   * Careful: **this is the only undo action that leaves no trace of its
   * own.** Pressing Undo sets `completed_at`, `completed_via` and
   * `completed_by_id` all to `null`, so the proof that the task was ever
   * completed vanishes from the row. Without a log, even if someone did
   * Complete -> Undo -> Complete every day, the owner would never see it.
   *
   * Careful: it was added in response to the owner asking whether designers
   * should have this access at all. The real problem with that question was
   * not the right itself but **having no way to verify**. The log changes the
   * question from "do I trust them?" to "I can look if I need to".
   *
   * Careful: `meta` keeps **the values that were erased** (when it was
   * completed, who pressed it); they are no longer in the row, so the log is
   * the only place.
   */
  | 'design_undone'
  /**
   * **Deleting a dead ASIN**: the page no longer exists on Amazon.
   *
   * Careful: not merged into `change_setting`: one day the question "who
   * removed so many links, and when" will come up, and then one would have to
   * search among thousands of settings rows.
   */
  | 'design_deleted'
  /** R2: leave reduces the target, so a record of who added/removed it is needed */
  | 'leave_added'
  | 'leave_removed'
  /** Salary **change**: heavier than viewing (`payroll_view`) because it
   *  alters someone's income. When a value changes, meta keeps both before and after. */
  | 'salary_change'
  /**
   * **R21: deposit (security money).** Two separate names, and both are needed:
   *
   * - `deposit_policy_update`: changing the amount or the notice rule. If
   *   merged into `change_setting`, the question "from when is it 500, and who
   *   raised it" could not be answered six months later.
   *
   * - `deposit_settle`: **returning or forfeiting someone's deposited
   *   money.** This is the heaviest single decision in the system: one click
   *   can take several thousand taka out of someone's hands. `meta` keeps what
   *   the rule said (`noticeDaysGiven` versus `noticeDaysRule`) and what the
   *   owner did, because in an exception exactly that pair will need to be
   *   looked at later.
   */
  | 'deposit_policy_update'
  | 'deposit_settle'
  | 'employee_create'
  | 'employee_update'
  | 'employee_deactivate'
  | 'employee_reactivate'
  | 'device_restore'
  | 'alert_acknowledge'
  /** D06: the owner changing a category rule. Written through `change_setting`,
   *  who made which site "unproductive" and when could not be filtered. */
  | 'change_category_rule'
  | 'recategorize'
  /**
   * **I06: 2FA.** Eight separate names, not one `change_setting`: if "who
   * turned off their own 2FA and when" and "who changed the theme and when"
   * fell in the same filter, the first would never be found, yet in an account
   * takeover investigation that is exactly the first question.
   */
  | '2fa_setup'
  | '2fa_enable'
  | '2fa_enable_failed'
  | '2fa_disable'
  | '2fa_disable_failed'
  | '2fa_recovery_regenerate'
  /** Signing in with a recovery code: rare and sensitive, hence a separate action */
  | '2fa_recovery_used'
  | '2fa_failed'
  /** The account page: own name or look changed, other devices signed out */
  | 'update_profile'
  | 'sign_out_other_sessions'
  /** K02: `POST /ops/backup/run`, a manual backup (the nightly cron is not audited) */
  | 'backup_run'
  /**
   * **H04**: registering a new agent version for rollout.
   *
   * A separate action, not `change_setting`: this is the decision about
   * **which software runs** on 15 PCs. If a bad build ships, "who released it
   * and when" is the first question, and in the same filter as theme changes
   * it could not be found.
   */
  | 'publish_agent_version'
  /**
   * The owner downloaded the MSI. Older agents (before 0.4.1) have no
   * "Install update" in the tray, so those PCs must be updated by hand
   * (09-Build-Log.md, the 18 August entry on rollout visibility).
   * Careful: before installers circulate by hand, it must be known who downloaded which.
   */
  | 'agent_version.download'
  /** Halting via `halted` is also here: as heavy a decision as starting a rollout */
  | 'change_agent_rollout'
  /**
   * **The system advanced a stage itself**: after a real machine survived six
   * hours in the canary or partial stage.
   *
   * Careful: **deliberately not merged with `change_agent_rollout`.** That one
   * says "a person decided", and this one says "the condition was met": two
   * entirely different responsibilities. If a bad build ships, the first
   * question will be "who spread it", and in one filter the answer could not be found.
   *
   * Careful: `userId` is always `null` here: no person pressed anything, and
   * there is nothing to hide about that.
   */
  | 'agent_version.rollout_auto';

export interface AuditEntry {
  userId?: number | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string | number;
  ipAddress?: string | null;
  meta?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * An audit write failure does not block the main work, but it does not stay
   * silent either. (Better to shout in the log than lose who viewed whose screenshot.)
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: entry.userId ?? null,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId:
            entry.targetId === undefined ? null : String(entry.targetId),
          ipAddress: entry.ipAddress ?? null,
          meta: entry.meta,
        },
      });
    } catch (err) {
      this.logger.error(
        `Could not write audit_log: ${entry.action}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
