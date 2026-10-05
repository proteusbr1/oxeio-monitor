import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import type { Source } from '../settings/app-settings.rules';
import { AppSettingsService } from '../settings/app-settings.service';
import { ErrorReporter, type TestOutcome } from './error-reporter.service';
import {
  checkDsn,
  checkEnvironment,
  dsnHost,
  ERROR_REPORTING_SETTING_KEY,
} from './error-reporting.rules';

class SaveErrorReportingDto {
  /** '' = clear what was saved here → back to SENTRY_DSN in the .env, or off */
  @IsString() @MaxLength(500)
  dsn!: string;

  @IsOptional() @IsString() @MaxLength(64)
  environment?: string;

  @IsOptional() @IsBoolean()
  browser?: boolean;

  @IsOptional() @IsBoolean()
  logErrors?: boolean;
}

class BrowserReportDto {
  @IsString() @MaxLength(100)
  name!: string;

  @IsString() @MaxLength(2000)
  message!: string;

  @IsOptional() @IsString() @MaxLength(10000)
  stack?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  componentStack?: string;

  @IsString() @MaxLength(500)
  path!: string;
}

export interface ErrorReportingView {
  enabled: boolean;
  /** the full DSN — owner-only; the dashboard never receives it otherwise */
  dsn: string | null;
  host: string | null;
  environment: string;
  browser: boolean;
  logErrors: boolean;
  source: Source;
}

/** Browser reports per signed-in user per minute — a crash loop stays one line */
const BROWSER_REPORTS_PER_MINUTE = 10;

@Controller()
export class ErrorReportingController {
  private readonly recent = new Map<number, number[]>();

  constructor(
    private readonly reporter: ErrorReporter,
    private readonly settings: AppSettingsService,
    private readonly audit: AuditService,
  ) {}

  @Roles(UserRole.owner)
  @Get('settings/error-reporting')
  async read(): Promise<ErrorReportingView> {
    const config = await this.settings.errorReporting();
    return {
      enabled: this.reporter.enabled,
      dsn: config.dsn,
      host: dsnHost(config.dsn),
      environment: config.environment,
      browser: config.browser,
      logErrors: config.logErrors,
      source: config.source,
    };
  }

  @Roles(UserRole.owner)
  @Patch('settings/error-reporting')
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveErrorReportingDto,
    @Ip() ip: string,
  ): Promise<ErrorReportingView> {
    let dsn = '';
    let environment: string;
    try {
      dsn = dto.dsn.trim() === '' ? '' : checkDsn(dto.dsn);
      environment = checkEnvironment(dto.environment ?? '');
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
    const browser = dto.browser === true;
    const logErrors = dto.logErrors === true;

    await this.settings.replace(
      ERROR_REPORTING_SETTING_KEY,
      { dsn, environment, browser, logErrors },
      actor.userId,
    );
    await this.reporter.reload();

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'setting',
      targetId: ERROR_REPORTING_SETTING_KEY,
      ipAddress: ip,
      // the host, not the key in the DSN
      meta: { op: 'error_reporting', host: dsnHost(dsn), environment, browser, logErrors },
    });

    return this.read();
  }

  @Roles(UserRole.owner)
  @Post('settings/error-reporting/test')
  @HttpCode(HttpStatus.OK)
  test(): Promise<TestOutcome> {
    return this.reporter.sendTest();
  }

  /**
   * A dashboard page crashed. Any signed-in user — the crash can be on
   * anyone's screen. Answers 204 whether or not reporting is on, so the page
   * never needs to know.
   */
  @Post('error-reports')
  @HttpCode(HttpStatus.NO_CONTENT)
  browserReport(
    @CurrentUser() user: SessionUser,
    @Body() dto: BrowserReportDto,
  ): void {
    if (!this.reporter.browserEnabled || !this.allow(user.userId)) return;

    this.reporter.captureBrowser(
      {
        name: dto.name,
        message: dto.message,
        stack: dto.stack ?? null,
        componentStack: dto.componentStack ?? null,
        path: dto.path,
      },
      user.role,
    );
  }

  private allow(userId: number): boolean {
    const now = Date.now();
    const times = (this.recent.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= BROWSER_REPORTS_PER_MINUTE) {
      this.recent.set(userId, times);
      return false;
    }
    times.push(now);
    this.recent.set(userId, times);
    return true;
  }
}
