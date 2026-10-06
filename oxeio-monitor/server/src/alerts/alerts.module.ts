import { Module } from '@nestjs/common';

import { AgentDownCheck } from './agent-down.check';
import { AgentTamperCheck } from './agent-tamper.check';
import { AlertsController } from './alerts.controller';
import { TelegramChannel } from './telegram.channel';
import { TelegramSettingsController } from './telegram.controller';
import { AlertDispatcher } from './alerts.dispatcher';
import { AlertMailer } from './alerts.mailer';
import { AlertsScheduler } from './alerts.scheduler';
import { AlertsService } from './alerts.service';
import { DeviceOverlapCheck } from './device-overlap.check';
import { SyntheticInputCheck } from './synthetic-input.check';
import { DiskCheck } from './disk.check';
import { NoActivityCheck } from './no-activity.check';

/**
 * Alerts.
 *
 * `AlertsService` is exported so other modules (e.g. the backup job, or
 * overlap detection for `device_overlap`) insert alerts through it instead of
 * writing `prisma.alert.create()` themselves. The throttle then applies automatically.
 *
 * Careful: PrismaModule is `@Global`, so it does not need to be imported here.
 */
@Module({
  controllers: [AlertsController, TelegramSettingsController],
  providers: [
    AlertsService,
    AlertMailer,
    // The controller's `test` route calls this one, not ops' instance,
    // because that one lives in another module and runs the sweep
    TelegramChannel,
    AlertDispatcher,
    AgentDownCheck,
    AgentTamperCheck,
    DeviceOverlapCheck,
    SyntheticInputCheck,
    DiskCheck,
    NoActivityCheck,
    AlertsScheduler,
  ],
  exports: [AlertsService],
})
export class AlertsModule {}
