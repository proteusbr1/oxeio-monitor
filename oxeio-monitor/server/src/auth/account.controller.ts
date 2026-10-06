import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import { UpdateAccountDto } from './account.dto';
import { AccountService, type AccountEvent, type AccountView } from './account.service';
import { CurrentUser } from './decorators';
import { TokenService } from './token.service';
import type { SessionUser } from './types';

/**
 * `/account` — the signed-in person's own page: profile, look, recent
 * activity, other devices. Open to every role; each route acts on the
 * session's own user. Password and 2FA keep their `/auth/...` routes.
 */
@Controller('account')
export class AccountController {
  constructor(
    private readonly accounts: AccountService,
    private readonly tokens: TokenService,
  ) {}

  @Get()
  view(@CurrentUser() user: SessionUser): Promise<AccountView> {
    return this.accounts.view(user.userId);
  }

  @Patch()
  update(
    @CurrentUser() user: SessionUser,
    @Body() dto: UpdateAccountDto,
    @Ip() ip: string,
  ): Promise<AccountView> {
    return this.accounts.update(user.userId, dto, ip);
  }

  @Get('activity')
  activity(@CurrentUser() user: SessionUser): Promise<AccountEvent[]> {
    return this.accounts.activity(user.userId);
  }

  /** Ends every other session; this one gets a fresh token and stays */
  @Post('sign-out-others')
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOutOthers(
    @CurrentUser() user: SessionUser,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.accounts.revokeSessions(user.userId, ip, 'sign_out_other_sessions');
    await this.tokens.issue(res, user);
  }
}
