import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { ActivityModule } from './activity/activity.module';
import { AdjustmentsModule } from './adjustments/adjustments.module';
import { AgentModule } from './agent/agent.module';
import { AlertsModule } from './alerts/alerts.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CalendarModule } from './calendar/calendar.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DigestModule } from './digest/digest.module';
import { HealthModule } from './health/health.module';
import { DepositsModule } from './deposits/deposits.module';
import { DevicesModule } from './devices/devices.module';
import { ErrorReportingModule } from './error-reporting/error-reporting.module';
import { FeaturesModule } from './features/features.module';
import { MeModule } from './me/me.module';
import { OpsModule } from './ops/ops.module';
import { PrismaModule } from './prisma/prisma.module';
import { PayrollModule } from './payroll/payroll.module';
import { ReportsModule } from './reports/reports.module';
import { ScreenshotsModule } from './screenshots/screenshots.module';
import { SummaryModule } from './summary/summary.module';
import { TargetsModule } from './targets/targets.module';
import { StorageModule } from './storage/storage.module';
import { SettingsModule } from './settings/settings.module';
import { SetupModule } from './setup/setup.module';
import { StaffModule } from './staff/staff.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        // In tests, per-request logs would bury the real results
        level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
        transport:
          process.env.NODE_ENV === 'production' ||
          process.env.NODE_ENV === 'test'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        redact: {
          // Agent tokens, session cookies and anyone's password must never reach the logs
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-csrf-token"]',
            'res.headers["set-cookie"]',
            'req.body.password',
            'req.body.currentPassword',
            'req.body.newPassword',
          ],
          remove: true,
        },
      },
    }),
    PrismaModule,
    // screenshot bytes — local disk or S3 (STORAGE_DRIVER); global, one instance
    StorageModule,
    // settings the owner edits on screen (region, backup mode, update key)
    SettingsModule,
    ErrorReportingModule,
    AuditModule,
    AuthModule,
    // after AuthModule: its guards must run before the module switches
    FeaturesModule,
    StaffModule,
    SetupModule,
    AgentModule,
    ActivityModule,
    CalendarModule,
    DevicesModule,
    AdjustmentsModule,
    DashboardModule,
    PayrollModule,
    DepositsModule,
    ReportsModule,
    ScreenshotsModule,
    // Careful: SummaryModule keeps ScheduleModule.forRoot() inside itself (left out in tests).
    // Do not add a separate forRoot() here: two explorers would register the same @Cron
    // twice and bootstrap would fail with "cron job already exists".
    SummaryModule,
    // Design targets: submission, daily distribution, completion
    TargetsModule,
    AlertsModule,
    // Careful: OpsModule and DigestModule both have `@Cron`, but the explorer comes from
    // the global forRoot() of SummaryModule above, so these go **after** it.
    // (The dependency is invisible to DI, so BackupJob checks it itself at bootstrap.)
    MeModule,
    OpsModule,
    DigestModule,
    HealthModule,
  ],
})
export class AppModule {}
