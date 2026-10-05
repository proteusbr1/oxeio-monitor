import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AuditModule } from '../audit/audit.module';
import { ErrorReporter } from './error-reporter.service';
import { ErrorReportingController } from './error-reporting.controller';
import { ReportErrorsFilter } from './report-errors.filter';

/**
 * Sentry error reporting (Settings → Error reporting). Global, so any
 * service can `capture()` an error it caught and only logged.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [ErrorReportingController],
  providers: [ErrorReporter, { provide: APP_FILTER, useClass: ReportErrorsFilter }],
  exports: [ErrorReporter],
})
export class ErrorReportingModule {}
