import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  TelegramChannel,
  type TelegramOutcome,
} from '../alerts/telegram.channel';
import { TeamsChannel } from '../alerts/teams.channel';
import { AlertMailer } from '../alerts/alerts.mailer';
import { digestRecipients } from './digest.recipients';
import { PrismaService } from '../prisma/prisma.service';
import { parseWorkDate, toIsoDate } from '../reports/reports.range';
import { ReportsService } from '../reports/reports.service';
import {
  buildWeekly,
  weeklyGateOf,
  weeklyMessage,
  weeklyWindow,
  WEEKLY_ALLOW_GROUP_ENV,
  type ObservedDay,
  type Weekly,
  type WeeklyGate,
  type WeeklyMessage,
  type WeeklyWindow,
} from './weekly.rules';
import { AppSettingsService } from '../settings/app-settings.service';

/** What is on the letterhead and in the email subject; same env as `digest.service.ts` */
const DEFAULT_ORG_NAME = 'oXeio Monitoring';

/**
 * All three `TelegramOutcome` values apply here, **plus one more**:
 * `chat_not_private`: it is configured and could have been sent, but the
 * destination is not a private chat, so it was deliberately not sent
 * (`weeklyGateOf()`).
 *
 * `not_configured` could **not** be returned for this: the token and chat id
 * are both set. A wrong reason would send the owner hunting for the token from
 * the log, when the problem is something else entirely. One number, one
 * definition (rule 2).
 *
 * `TelegramOutcome` lives in `alerts/telegram.channel.ts`, which was outside
 * the scope of this work, so the value is **added** here, not there.
 */
export type WeeklyOutcome = TelegramOutcome | 'chat_not_private';

export interface WeeklyDigestResult {
  from: string;
  to: string;
  employees: number;
  withData: number;
  behind: number;
  /** How many people had at least one day that was never observed */
  withGaps: number;
  /** Staff left out of the report (inactive, yet `left_on` empty) */
  excluded: number;
  outcome: WeeklyOutcome;
  /** Message length and how many names were trimmed; the log shows how close the limit is */
  chars: number;
  hidden: number;
}

/**
 * **R3**: the weekly summary, to the owner's Telegram.
 *
 * **This file has no power to choose a destination, but it does have the power
 * to "not send".** The message lists "who is behind" by name; if it went to the
 * team's group it would be a weekly public humiliation, impossible to take back
 * once sent, and people quit for exactly this reason.
 *
 * The chat is `TELEGRAM_CHAT_ID`, i.e. **shared with alerts**. Since alerts
 * carry only hostname and type, many people put the team's group there, and
 * then the ranking would have gone to it on the very first Friday. "Not in the
 * staff group" used to be **written** in three places here, but no guard in the
 * code; now `weeklyGateOf()` stands right before sending (`runOnce()`).
 * If the owner knowingly wants the group, `WEEKLY_DIGEST_ALLOW_GROUP=true`.
 *
 * The numbers are produced **through `ReportsService`** (F01 + F02), exactly
 * like the daily digest. Reading `daily_summary` directly to build hours or
 * targets would create another implementation of the holiday calendar, and
 * Telegram and the report would state different hours.
 *
 * `PrismaService` is still injected for **exactly one** job: knowing which
 * days had a row written at all (`observedDays()`). That is existence, not a
 * number, and the report format has no place to expose it: F01 calls both "no
 * row" and "row exists, 0 hours" `no_activity`. Do not add any other query
 * here; this is exactly how a second source of hours begins.
 *
 * This class **can throw**: `ReportsService` throws a 500 if it finds no
 * active work policy. The exception is caught in `WeeklyDigestJob`, in one
 * place (for both scheduled and manual calls), like `DigestJob`.
 */
@Injectable()
export class WeeklyDigestService {
  private readonly logger = new Logger(WeeklyDigestService.name);
  private readonly orgName: string;

  private async organizationName(): Promise<string> {
    return this.settings ? (await this.settings.organization()).name : this.orgName;
  }
  /**
   * `TELEGRAM_CHAT_ID` is read here a **second time** (`TelegramChannel` reads
   * it too), on purpose: guarding the destination requires knowing it, but the
   * channel keeps it `private` and that file was outside the scope of this work.
   *
   * This is not a second definition of any **number**: as before, only the
   * channel does the sending, and here it is only decided "whether to send".
   * Still, the dependency is real: if the channel ever took the chat id from
   * another variable, this guard would silently guard the wrong chat.
   */
  private readonly gate: WeeklyGate;
  private readonly digestEmailTo: string | undefined;

  constructor(
    private readonly reports: ReportsService,
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramChannel,
    private readonly teams: TeamsChannel,
    private readonly mailer: AlertMailer,
    config: ConfigService,
    // the company name saved by the setup wizard / Settings wins over ORG_NAME
    @Optional() private readonly settings?: AppSettingsService,
  ) {
    this.orgName = config.get<string>('ORG_NAME')?.trim() || DEFAULT_ORG_NAME;
    this.digestEmailTo = config.get<string>('DIGEST_EMAIL_TO');
    this.gate = weeklyGateOf(
      config.get<string>('TELEGRAM_CHAT_ID'),
      config.get<string>(WEEKLY_ALLOW_GROUP_ENV),
    );

    // Said **at startup**, not on Friday evening; otherwise the owner would find
    // out only after the first message failed to arrive, seven days late.
    if (!this.gate.send) {
      this.logger.warn(
        `Weekly summary is blocked — ${this.gate.blockedBecause}`,
      );
    }
  }

  /**
   * Never throws; `AlertMailer.send()` does not either. The weekly job rests on
   * this, and SMTP being down does not mean losing the figures.
   */
  private async sendByEmail(text: string): Promise<'sent' | 'not_configured' | 'failed'> {
    if (!this.mailer.configured) return 'not_configured';

    const owners = await this.prisma.user.findMany({
      where: { role: 'owner', isActive: true },
      select: { email: true },
    });

    const to = digestRecipients({
      explicit: this.digestEmailTo,
      owners: owners.map((o) => o.email),
    });

    // No address: return quietly. `AlertMailer` will log it once anyway; there
    // is no point writing it twice.
    if (to.length === 0) return 'not_configured';

    return this.mailer.send(to, `${(await this.organizationName())} — weekly summary`, text);
  }

  async runOnce(now: Date = new Date()): Promise<WeeklyDigestResult> {
    const weekly = await this.collect(now);
    const message = weeklyMessage(weekly, (await this.organizationName()));

    /**
     * **The guard is here, after the numbers are counted.** Placed earlier, in
     * a blocked week the summary would not even be built and there would be
     * nothing to write in the log below; yet a blocked week is when it is
     * needed most: the message then lives **only** in the log, and if a weekly
     * figure is lost there is no way to get it back.
     */
    /**
     * **Teams is not an alternative to Telegram, but alongside it.** Whichever
     * is configured gets it; if both are, both get it.
     *
     * **Teams deliberately has no guard of its own.** Telegram's guard
     * (`weeklyGateOf`) exists because there an employee's names and hours could
     * go into a **group chat** by mistake. A Teams webhook is bound to one
     * specific channel: the one the owner chose and set up, and changing it
     * means touching `.env`.
     *
     * So Teams is sent even when Telegram is blocked: they are two different
     * risks, and one's penalty cannot be put on the other.
     */
    const teamsOutcome = await this.teams.send(
      `${(await this.organizationName())} — weekly summary`,
      message.text,
    );

    /**
     * **Email is the third channel, and the only one that is always available.**
     *
     * The owner's Teams is a **free/personal account** (Communities), and there
     * is no incoming webhook there; Workflows only come with work/school
     * accounts. Not everyone has Telegram either. But SMTP is configured anyway,
     * because alerts go that way.
     *
     * The recipient is **not** a manager: the summary has every employee's name
     * and hours, the same as an owner-only screen (`digest.recipients.ts`).
     */
    const emailOutcome = await this.sendByEmail(message.text);

    const outcome: WeeklyOutcome = this.gate.send
      ? await this.telegram.send(message.text)
      : 'chat_not_private';

    /**
     * Sent to Teams while Telegram is blocked: in this state the "whole message
     * to the log" branch below is no longer needed, since the summary was not
     * lost. But the fact should be written down, otherwise the log would make it
     * look as if nothing was sent.
     */
    if (emailOutcome === 'sent') {
      this.logger.log(`Weekly summary emailed · ${weekly.from} → ${weekly.to}`);
    } else if (emailOutcome === 'failed') {
      this.logger.warn('Weekly summary could not be emailed — see the message below');
    }

    if (teamsOutcome === 'sent') {
      this.logger.log(`Weekly summary also sent to Teams · ${weekly.from} → ${weekly.to}`);
    } else if (teamsOutcome === 'failed') {
      this.logger.warn('Weekly summary could not be sent to Teams — see the message below');
    }

    if (outcome === 'chat_not_private') {
      this.logger.warn(
        `Weekly summary was NOT sent — ${this.gate.blockedBecause}\n` +
          `Full text below:\n${message.text}`,
      );
      return resultOf(weekly, message, outcome);
    }

    /**
     * If Telegram is missing (or the send fails), **a log entry, not a crash**,
     * and the whole message goes to the log, not just "could not send". The job
     * runs once a week; without keeping the message, that week's summary would
     * be lost for good, and there is no way to recover a past week after fixing
     * the token.
     *
     * Logging it is safe, because the message has only names and hours: no
     * domains, app names or screenshot paths (see `weekly.rules.ts`).
     */
    if (outcome === 'sent') {
      this.logger.log(
        `Weekly summary sent · ${weekly.from} → ${weekly.to} · ` +
          `${weekly.totals.employees} staff (${weekly.totals.withData} with data) · ` +
          `${weekly.behind.length} behind · ${message.text.length} chars` +
          // Gaps and excluded staff go in the log too: to find out later why the
          // message looks "small", the log is the only place
          (weekly.totals.withGaps > 0
            ? ` · ${weekly.totals.withGaps} with unobserved days`
            : '') +
          (weekly.totals.excluded > 0
            ? ` · ${weekly.totals.excluded} excluded from the report`
            : '') +
          (message.hidden > 0 ? ` · ${message.hidden} names trimmed` : ''),
      );
    } else {
      this.logger.warn(
        `Weekly summary was not sent to Telegram (${outcome}) — full text below:\n${message.text}`,
      );
    }

    return resultOf(weekly, message, outcome);
  }

  /** Only the numbers: tests or a future preview can call it without sending */
  async collect(now: Date = new Date()): Promise<Weekly> {
    const window = weeklyWindow(now);

    const [daily, week, observed] = await Promise.all([
      /**
       * F01 is requested for the **whole window**, not just today. Without a
       * per-day target, neither "today" nor "days that were not observed" can be
       * dropped from the expectation, and F02 gives a single target for the whole week.
       */
      this.reports.attendance({ from: window.from, to: window.to }),
      this.reports.summary({
        from: window.from,
        to: window.to,
        groupBy: 'week',
      }),
      this.observedDays(window),
    ]);

    return buildWeekly({
      from: window.from,
      to: window.to,
      days: window.days,
      daily: daily.rows,
      week: week.rows,
      observed,
      /**
       * `meta` used to be thrown away, losing `excludedEmployees`: those with
       * `status=inactive` and an empty `left_on`, who do not appear in the report
       * at all, were invisible in Telegram too. The report deliberately names
       * them; the weekly message now does too.
       *
       * `week.meta` is taken, not `daily.meta`: they are identical (same range,
       * same `context()`), so either one is enough.
       */
      excludedEmployees: week.meta.excludedEmployees,
    });
  }

  /**
   * Which (employee, day) pairs the server **actually observed**.
   *
   * `ReportsService` cannot answer this one question, so the DB is read
   * directly here. F01 calls both "no row" and "row exists, 0 hours"
   * `no_activity` (`reports.service.ts`), yet that difference is the most
   * important fact in this message: `refreshDate()` writes a row for every
   * active employee every day, so a row existing = that day was measured.
   *
   * **No number comes from here**, only existence. Hours, targets and work days
   * all still come from F01/F02, so "one number, one definition" is intact: no
   * second implementation of holidays or targets was born here.
   *
   * Not filtered by employee: rows are few (employees × 7), and extra rows do
   * no harm when matching by `employeeId`. Filtering would mean waiting for the
   * report's employee list, i.e. three queries that no longer run in parallel.
   */
  private async observedDays(window: WeeklyWindow): Promise<ObservedDay[]> {
    const rows = await this.prisma.dailySummary.findMany({
      where: {
        workDate: {
          gte: parseWorkDate(window.from),
          lte: parseWorkDate(window.to),
        },
      },
      select: { employeeId: true, workDate: true },
    });

    // `workDate` is UTC midnight (`@db.Date`), hence `toIsoDate()`: F01's `date`
    // is made by the very same function, otherwise the two keys would never match
    return rows.map((r) => ({
      employeeId: r.employeeId,
      date: toIsoDate(r.workDate),
    }));
  }
}

/**
 * The result is built in **one place**, whether sent, blocked or failed. With
 * two object literals in two branches, adding a field to one and forgetting
 * the other is only a matter of time, and then the result's shape would vary
 * with `outcome`.
 */
function resultOf(
  weekly: Weekly,
  message: WeeklyMessage,
  outcome: WeeklyOutcome,
): WeeklyDigestResult {
  return {
    from: weekly.from,
    to: weekly.to,
    employees: weekly.totals.employees,
    withData: weekly.totals.withData,
    behind: weekly.behind.length,
    withGaps: weekly.totals.withGaps,
    excluded: weekly.totals.excluded,
    outcome,
    chars: message.text.length,
    hidden: message.hidden,
  };
}
