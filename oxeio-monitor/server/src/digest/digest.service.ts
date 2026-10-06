import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  WORK_TIMEZONE,
  dhakaClock,
  workDateOf,
} from '../agent/util/dhaka-time';
import { AlertMailer, type SendOutcome } from '../alerts/alerts.mailer';
import { TelegramChannel } from '../alerts/telegram.channel';
import { FeaturesService } from '../features/features.service';
import { PrismaService } from '../prisma/prisma.service';
import { monthBoundsOf, toIsoDate } from '../reports/reports.range';
import { ReportsService } from '../reports/reports.service';
import { buildDigest, digestBody, digestSubject, type Digest } from './digest.math';
import {
  designTargetOf,
  designView,
  type DesignView,
} from '../summary/design.rules';
import { asPreBlock, telegramDigest } from './digest.telegram';

/** In the letterhead and email title — the same env as `reports.service.ts` */
const DEFAULT_ORG_NAME = 'oXeio Monitoring';

export interface DigestResult {
  workDate: string;
  employees: number;
  behind: number;
  recipients: number;
  outcome: SendOutcome;
}

/**
 * **F07** — the daily digest email (6:30 pm, Dhaka).
 *
 * The numbers are produced **through `ReportsService`** — F01 (one day,
 * today) and F02 (1st of the month → today). Reading `daily_summary` directly
 * to work out the target would create a new implementation of each of the
 * holiday calendar, weekly off days, join/leave dates and the daily target
 * split. Then one day the email and the report would give two different hours,
 * and the owner would trust neither.
 *
 * Careful: do **not assume this class never throws** — `ReportsService`
 * throws a 500 if it finds no active work policy. A failing digest must not
 * take the server down, so the exception is caught in `DigestJob` (the one
 * place, for both scheduled and manual calls).
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);
  private readonly orgName: string;
  private readonly explicitRecipients: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly mailer: AlertMailer,
    private readonly telegram: TelegramChannel,
    config: ConfigService,
    private readonly features: FeaturesService,
  ) {
    this.orgName = config.get<string>('ORG_NAME')?.trim() || DEFAULT_ORG_NAME;

    // Careful: there is **no fallback** to `ALERT_EMAIL_TO`. Alerts and the
    //    digest are different things: an alert says "something broke", the
    //    digest says "who worked how many hours". With one shared list, someone
    //    who only watches server health would get everyone's hours every day.
    this.explicitRecipients = (config.get<string>('DIGEST_EMAIL_TO') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async runOnce(now: Date = new Date()): Promise<DigestResult> {
    const digest = await this.collect(now);
    const recipients = await this.recipients();

    const subject = digestSubject(digest);
    const body = digestBody(digest, this.orgName);

    const outcome = await this.mailer.send(recipients, subject, body);

    /**
     * **Telegram too** — the owner's request: a daily work report for staff on
     * Telegram, showing who is working and who is not.
     *
     * Careful: **alongside the email, not instead of it**. Whichever is
     * configured gets it; even without SMTP (as now) it goes to Telegram.
     *
     * Careful: **the weekly digest's group guard is not here** — this is
     * correct, not an oversight: `TelegramChannel.send()` itself sends to the
     * configured chat, and the owner chose that chat himself. The extra guard
     * on the weekly one exists because it is **far more detailed** (each
     * employee's hours for the whole week); the daily one is a short summary.
     */
    /**
     * Careful: **the email body no longer goes to Telegram.** It used to go
     * verbatim — one list of all staff plus eight lines of "How to read these
     * numbers". On a phone that is a grey wall, and the owner's two questions
     * (*who worked how many hours*, *who reached the target*) got lost in it.
     *
     * The email is **unchanged** — the detailed explanation is fine there. Two
     * media, two looks, but the numbers come from the same `Digest`, so the
     * two never say different things.
     */
    const plain = telegramDigest(digest, this.orgName, {
      silentPcs: await this.silentPcsToday(now),
      atTime: dhakaClock(now),
      designs: await this.designsToday(digest.workDate),
    });

    const telegramOutcome = await this.telegram.sendHtml(asPreBlock(plain), plain);

    if (telegramOutcome === 'sent') {
      this.logger.log('Daily digest also sent to Telegram');
    } else if (telegramOutcome === 'failed') {
      this.logger.warn('Daily digest could not be sent to Telegram — see the body below');
    }

    /**
     * Careful: if SMTP is missing (or sending fails) it is **a log, not a
     * crash** — and the whole body goes to the log, not just "could not send".
     * Even while email is off the numbers should be kept somewhere; otherwise
     * on the day SMTP is fixed the earlier days would be lost for good.
     *
     * Careful: logging is safe because the body has only names and hours — no
     * domain, app name or screenshot path (see `digest.math.ts`).
     */
    if (outcome === 'sent') {
      this.logger.log(
        `Digest sent · ${digest.workDate} · ` +
          `${digest.totals.employees} staff · ${digest.behind.length} behind · ` +
          `${recipients.length} recipients`,
      );
    } else {
      this.logger.warn(
        `Digest was not emailed (${outcome}) — full summary below:\n${subject}\n${body}`,
      );
    }

    return {
      workDate: digest.workDate,
      employees: digest.totals.employees,
      behind: digest.behind.length,
      recipients: recipients.length,
      outcome,
    };
  }

  /**
   * How many **distinct** PCs were silent during work hours today.
   *
   * Careful: **distinct PCs are counted, not alerts.** If one machine goes
   * silent five times a day, five rows are created — counting them would look
   * alarming while the problem is a single one. `DISTINCT device_id` is the truth here.
   *
   * Careful: never throws — this one line must not hold up the whole report.
   */
  private async silentPcsToday(now: Date): Promise<number> {
    try {
      const since = new Date(now.getTime() - 24 * 3_600_000);
      const rows = await this.prisma.alert.findMany({
        where: {
          type: 'agent_down',
          createdAt: { gte: since },
          deviceId: { not: null },
        },
        select: { deviceId: true },
        distinct: ['deviceId'],
      });

      return rows.length;
    } catch (err) {
      this.logger.warn(
        `Could not count silent PCs: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * How many designs each person made today — by `empCode`.
   *
   * Careful: **only `staff_type = 'designer'`**, and only when the target is
   * on. Counting everyone would put researchers on the list daily as "0/25" —
   * an accusation, not information.
   *
   * Careful: never throws — the design count is an extra measure; it must not
   * hold up the whole daily report.
   */
  private async designsToday(
    workDate: string,
  ): Promise<Map<string, DesignView>> {
    const out = new Map<string, DesignView>();

    // design targets switched off in Settings → Modules: no design lines
    if (!(await this.features.isOn('designTargets'))) return out;

    try {
      /**
       * Careful: **all active employees**, not only designers — because the
       * manager designs too (43 in three days). Who gets on the list is decided
       * by `designView()`: with a target, `24/25 ✅`; without one, just the
       * number; and nothing at all if they did nothing.
       */
      const staff = await this.prisma.employee.findMany({
        where: { status: 'active' },
        select: {
          id: true,
          empCode: true,
          staffType: true,
          dailyDesignTarget: true,
          policy: { select: { dailyDesignTarget: true } },
        },
      });
      if (staff.length === 0) return out;

      /**
       * **Only "finished" is counted** *(the owner's decision)*: files that are
       * merely opened must not count — only ones marked complete.
       *
       * Careful: this used to count `designCredit`, i.e. how many files were
       * **opened**. In the field the manager (OX-01) was showing "16" when he
       * had opened 19 files for a total of just **44 minutes**. An opened-count
       * cannot tell "the one who makes" from "the one who looks".
       *
       * Careful: `completed_at` is a timestamptz, so a raw query splits by the
       * Dhaka day; Prisma's `groupBy` cannot cut by date.
       */
      const rows = await this.prisma.$queryRaw<
        { employee_id: number; n: number }[]
      >`
        SELECT assigned_to_id AS employee_id, count(*)::int AS n
          FROM design_targets
         WHERE assigned_to_id = ANY(${staff.map((d) => d.id)}::int[])
           AND completed_at IS NOT NULL
           AND (completed_at AT TIME ZONE ${WORK_TIMEZONE})::date = ${workDate}::date
         GROUP BY 1
      `;
      const byId = new Map(rows.map((r) => [r.employee_id, Number(r.n)]));

      for (const d of staff) {
        const view = designView(
          d.staffType,
          byId.get(d.id) ?? 0,
          designTargetOf(d.dailyDesignTarget, d.policy?.dailyDesignTarget),
        );
        if (view !== null) out.set(d.empCode, view);
      }
    } catch (err) {
      this.logger.warn(
        `Could not count designs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return out;
  }

  /** Just the numbers — tests or a future preview can call it without email */
  async collect(now: Date = new Date()): Promise<Digest> {
    // Careful: "today" means **Dhaka's** today — with the server in UTC, at 6:30 pm
    //    the date of `new Date()` would still be right, but relying on it would be
    //    wrong and a manual run at 11 pm would be a day behind
    const today = workDateOf(now);
    const workDate = toIsoDate(today);
    const monthFrom = toIsoDate(monthBoundsOf(today).first);

    const [today1, month] = await Promise.all([
      this.reports.attendance({ from: workDate, to: workDate }),
      this.reports.summary({ from: monthFrom, to: workDate, groupBy: 'month' }),
    ]);

    return buildDigest({
      workDate,
      monthFrom,
      monthTo: workDate,
      today: today1.rows,
      month: month.rows,
      /**
       * The expectation comes from F02's **meta**, not from rows. The rows hold
       * the target for "1st of the month → today"; the meta holds the
       * calculation for exactly the window the tray, Live Board and Monthly
       * page use (tracking start → yesterday). Building it here by subtracting
       * from rows would make the email and the dashboard give two shortfalls
       * for the same employee.
       */
      expectedHours: month.meta.expectedHours,
    });
  }

  /**
   * Who receives it — `DIGEST_EMAIL_TO` if set, otherwise the active owners.
   *
   * Careful: managers are **not sent it by default**, although they can see
   * these numbers on the dashboard (§ 4.3). "Can see" and "gets it in the inbox
   * daily" are not the same — email is forwarded and stays in archives, and
   * who is sent it is the organisation's decision. If needed, an address can
   * be put in `DIGEST_EMAIL_TO`; widening the list on its own would silently
   * become policy.
   */
  private async recipients(): Promise<string[]> {
    if (this.explicitRecipients.length > 0) return this.explicitRecipients;

    const owners = await this.prisma.user.findMany({
      where: { role: 'owner', isActive: true },
      select: { email: true },
    });

    return owners.map((o) => o.email);
  }
}
