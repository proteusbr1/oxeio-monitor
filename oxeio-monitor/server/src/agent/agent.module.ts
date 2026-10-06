import { Module } from '@nestjs/common';

import { ActivityModule } from '../activity/activity.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';

import { AgentConfigService } from './agent-config.service';
import { AgentController } from './agent.controller';
import { ClockDriftService } from './clock-drift.service';
import { DeviceAuthGuard } from './device-auth.guard';
import { DeviceRateLimitService } from './device-rate-limit.service';
import { EnrollmentService } from './enrollment.service';
import { IngestService } from './ingest.service';
import { ProgressService } from './progress.service';
import { RolloutAdvanceJob } from './rollout-advance.job';
import { ScreenshotIngestService } from './screenshot-ingest.service';
import { UpdateService } from './update.service';
import { CapabilityHealthService } from './capability-health.service';

@Module({
  // Careful: `AuthModule` is here only for `AuthService`, to enroll with a
  //    staff login (`/agent/enroll-login`). Password check, 2FA and brute-force
  //    throttling all live there; they were not copied.
  // `AuditModule`: when a rollout advances by itself, it must be written to the log.
  imports: [ActivityModule, AuditModule, AuthModule],
  controllers: [AgentController],
  providers: [
    ProgressService,
    AgentConfigService,
    CapabilityHealthService,
    RolloutAdvanceJob,
    ClockDriftService,
    DeviceAuthGuard,
    DeviceRateLimitService,
    EnrollmentService,
    IngestService,
    ScreenshotIngestService,
    UpdateService,
  ],
  // Careful: `ProgressService` is exported **for the employee's own page**
  //    (`MeModule`), so the tray and the web show the same number.
  /**
   * `UpdateService` is exported because `AdminModule`'s download route uses it.
   * Careful: the code is deliberately not duplicated. `openMsi()` blocks path
   * traversal (nothing outside storage may be served), and if that guard lived
   * in two places one day it would be fixed in one and not the other.
   */
  exports: [AgentConfigService, ClockDriftService, ProgressService, UpdateService],
})
export class AgentModule {}
