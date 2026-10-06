import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Logger, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from '../auth/decorators';
import { TokenService } from '../auth/token.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { SetupDto } from './setup.dto';
import { SetupService } from './setup.service';

/**
 * First-run setup. Public: there is nobody to sign in yet. Writing needs the
 * one-time token from the server log (see SetupService), and works only once
 * — after that there is an owner and the endpoint answers 409.
 */
@Controller('setup')
export class SetupController {
  private readonly logger = new Logger(SetupController.name);

  constructor(
    private readonly setup: SetupService,
    private readonly tokens: TokenService,
    private readonly settings: AppSettingsService,
  ) {}

  /** Whether to show the wizard, and the company name for the login page */
  @Public()
  @Get('status')
  async status(): Promise<{ needed: boolean; organizationName: string }> {
    const [status, organization] = await Promise.all([this.setup.status(), this.settings.organization()]);
    return { needed: status.needed, organizationName: organization.name };
  }

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async run(
    @Body() dto: SetupDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ restartNeeded: boolean; holidaysAdded: number; holidayNotes: string[] }> {
    const result = await this.setup.run(dto, ip);
    // signed in straight away — the owner just chose that password
    await this.tokens.issue(res, result.owner);

    if (result.restartNeeded && process.env.NODE_ENV !== 'test') {
      // the work time zone is read at start: come back up with the chosen one
      this.logger.warn('Restarting to apply the chosen time zone');
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1500);
    }
    return {
      restartNeeded: result.restartNeeded,
      holidaysAdded: result.holidaysAdded,
      holidayNotes: result.holidayNotes,
    };
  }
}
