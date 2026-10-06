import { Module } from '@nestjs/common';

import { AlertMailer } from '../alerts/alerts.mailer';
import { TelegramChannel } from '../alerts/telegram.channel';
import { TeamsChannel } from '../alerts/teams.channel';
import { ReportsModule } from '../reports/reports.module';
import { DigestJob } from './digest.job';
import { DigestService } from './digest.service';
import { WeeklyDigestJob } from './weekly.job';
import { WeeklyDigestService } from './weekly.service';

/**
 * **F07** — the daily digest email, **R3** — the weekly summary on Telegram.
 *
 * Careful: `AlertMailer` is **placed here as a provider**, not by importing
 * `AlertsModule` — because `AlertsModule` exports only `AlertsService`, not the
 * mailer. The SMTP code is not copied (that is the real rule): same class,
 * just a separate instance. The mailer builds its transport **lazily** and is
 * used once a day, so a second instance costs practically nothing.
 *
 * It would be better to write `exports: [AlertsService, AlertMailer]` in one
 * line in `AlertsModule` and import that here — then there would be one SMTP
 * connection too. That file belongs to someone else, so it was not changed; if
 * done, remove `AlertMailer` from `providers` here and put `AlertsModule` in `imports`.
 *
 * Careful: `ScheduleModule.forRoot()` is **not** here — `SummaryModule` made it
 * global. A second forRoot would make two explorers register the same `@Cron`
 * twice (bootstrap would crash, and before that the email went out twice a day).
 *
 * Careful: `TelegramChannel` is likewise placed as a provider (for R3) — it is
 * a provider of `OpsModule`, but that module does not export it, and
 * `ops.module.ts` is outside the scope of this work. The class is not copied:
 * same class, just a separate instance, costing practically nothing (two
 * strings and an empty Map).
 * Careful: only `send()` is called on this instance, **never `runOnce()`** —
 * that is the alert sweep, and a second sweep would send every alert to
 * Telegram twice. If `OpsModule` ever exports `TelegramChannel`, remove it
 * from `providers` here and put `OpsModule` in `imports` — but then take care
 * that no cycle is created.
 */
@Module({
  // Careful: `DashboardModule` was here only for the hourly snapshot; when that
  // was removed the dependency went too
  imports: [ReportsModule],
  providers: [
    DigestService,
    DigestJob,
    AlertMailer,
    WeeklyDigestService,
    WeeklyDigestJob,
    TelegramChannel,
    /**
     * Careful: **the hourly snapshot (`SnapshotService`/`SnapshotJob`) was
     * removed** *(the owner's decision — ADR-029 cancelled)*.
     *
     * It came as an **alternative** to real-time idle alerts: one message an
     * hour instead of 60-180 a day. But in the field it became 11 snapshots +
     * 39 `agent_down` = ~50 messages a day, and under them was buried the one
     * thing the owner actually wanted — the daily report. The owner's words:
     * he does not want this type of alert, he wants a daily report.
     *
     * Careful: **think before bringing it back:** the answer to "who is
     * working right now" is **always** on the Live Board; it did not need to
     * be pushed.
     */
    // Teams — alongside Telegram, not instead of it
    TeamsChannel,
  ],
  // So that tests or a future admin endpoint can call `runOnce()` on purpose —
  // you cannot verify SMTP or Telegram by waiting until 6:30 pm (or Friday)
  exports: [DigestService, DigestJob, WeeklyDigestService, WeeklyDigestJob],
})
export class DigestModule {}
