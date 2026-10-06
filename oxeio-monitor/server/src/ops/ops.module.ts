import { Module } from '@nestjs/common';

import { BackupCheck } from '../alerts/backup.check';
import { AlertsModule } from '../alerts/alerts.module';
import { TelegramChannel } from '../alerts/telegram.channel';
import { SummaryModule } from '../summary/summary.module';
import { BackupJob } from './backup.job';
import { BackupService } from './backup.service';
import { BackupStateStore } from './backup.state';
import { OpsController } from './ops.controller';
import { OpsHealthService } from './ops.health.service';
import { OpsScheduler } from './ops.scheduler';
import { OffsiteSettingsController } from './offsite.controller';

/**
 * **K02 · K03 · K04 · G04 · G08**: backup, health, backup alert, Telegram.
 *
 * Careful: `BackupCheck` (G04) and `TelegramChannel` (G08) are files in
 * `src/alerts/` but providers **here**, because `alerts.module.ts` was outside
 * the scope of this work. They are not in the right place, knowingly: both
 * should move to `AlertsModule`. On the day they move, make sure `AlertsModule`
 * does not import `OpsModule`, or a cycle (`Ops → Alerts → Ops`) appears,
 * because `BackupCheck` uses `BackupService`.
 *
 * There is no `ScheduleModule.forRoot()` here: `SummaryModule` does it, and
 * forRoot is global. Doing it twice breaks bootstrap.
 *
 * `PrismaModule` is `@Global`, so it needs no separate import.
 */
@Module({
  // `SummaryModule` is only for `RetentionJob` (the K01 manually triggered
  // endpoint). It has `ScheduleModule.forRoot()`, but Nest modules are
  // singletons: importing it does not run that a second time.
  imports: [AlertsModule, SummaryModule],
  controllers: [OpsController, OffsiteSettingsController],
  providers: [
    BackupStateStore,
    BackupService,
    BackupCheck,
    TelegramChannel,
    BackupJob,
    OpsHealthService,
    OpsScheduler,
  ],
  // So tests or a future admin endpoint can call `runOnce()`
  exports: [BackupService, BackupJob, BackupStateStore, OpsHealthService, OpsScheduler],
})
export class OpsModule {}
