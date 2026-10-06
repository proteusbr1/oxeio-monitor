import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { LOCAL_OFFSET_MIN, WORK_TIMEZONE } from '../agent/util/dhaka-time';
import { type CurrencyInfo } from '../payroll/currency';
import { AppSettingsService } from '../settings/app-settings.service';
import { IDLE_WARN_BEFORE_SEC, SESSION_TTL_MIN } from './auth.constants';
import { AuthService, type MeResult } from './auth.service';
import { AllowWhileMustChangePw, CurrentUser, Public } from './decorators';
import {
  ChangePasswordDto,
  LoginDto,
  PasswordConfirmDto,
  TotpCodeDto,
} from './dto';
import { TokenService } from './token.service';
import type { SessionUser } from './types';
import {
  TwoFactorService,
  type TwoFactorSetup,
  type TwoFactorStatus,
} from './two-factor.service';

/** The login response: exactly one of the two arrives, never both */
interface LoginResponse {
  /** When true the session cookie was **not set**; the user must supply a code */
  needsTotp?: true;
  mustChangePassword?: boolean;
  usedRecoveryCode?: boolean;
  recoveryCodesLeft?: number | null;
}

/** I09: the web uses these numbers to sync its own countdown */
interface SessionPolicy {
  idleTimeoutSec: number;
  warnBeforeSec: number;
}

interface WorkTimeZone {
  /** IANA name, e.g. `Asia/Dhaka` */
  timeZone: string;
  /** Minutes east of UTC — fixed, the server refuses zones with DST */
  utcOffsetMinutes: number;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly twoFactor: TwoFactorService,
    // currency and date format, as saved on Settings → Region (or the .env)
    private readonly settings: AppSettingsService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const outcome = await this.auth.login(
      dto.email,
      dto.password,
      ip,
      dto.totp,
      dto.recoveryCode,
    );

    // Careful: 200 but no cookie, deliberately. A 401 would trigger the web's global
    // "session ended" handler, yet this is not a failure at all, it is step 1.
    if (outcome.status === 'needs_totp') return { needsTotp: true };

    await this.tokens.issue(res, outcome.user);
    return {
      mustChangePassword: outcome.mustChangePassword,
      usedRecoveryCode: outcome.usedRecoveryCode,
      recoveryCodesLeft: outcome.recoveryCodesLeft,
    };
  }

  @AllowWhileMustChangePw()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response): void {
    this.tokens.clear(res);
  }

  @AllowWhileMustChangePw()
  @Get('me')
  me(@CurrentUser() user: SessionUser): Promise<MeResult> {
    return this.auth.me(user.userId);
  }

  /**
   * I09: the web's countdown must not drift from the server's.
   * Careful: if the numbers were hardcoded in the frontend, one day when the
   * server TTL changed the web would warn at 30 minutes while the session died
   * at 15, or the reverse.
   */
  @Public()
  @Get('session-policy')
  sessionPolicy(): SessionPolicy {
    return {
      idleTimeoutSec: SESSION_TTL_MIN * 60,
      warnBeforeSec: IDLE_WARN_BEFORE_SEC,
    };
  }

  /**
   * The work-day time zone, so the dashboard cuts days and prints clocks the
   * same way the server does. Same reasoning as `session-policy`: a value
   * hardcoded in the frontend would drift the day someone changes the server.
   */
  @Public()
  @Get('time-zone')
  timeZone(): WorkTimeZone {
    return { timeZone: WORK_TIMEZONE, utcOffsetMinutes: LOCAL_OFFSET_MIN };
  }

  /**
   * The currency amounts are in, so the dashboard puts the right symbol in
   * front of them. Same reasoning as `session-policy`: a symbol hardcoded in
   * the frontend would be wrong for any deployment that changes `CURRENCY`.
   */
  @Public()
  @Get('currency')
  async currency(): Promise<CurrencyInfo> {
    const { code, symbol } = (await this.settings.region()).currency;
    return { code, symbol };
  }

  /**
   * How the dashboard writes dates and numbers (`DISPLAY_LOCALE`); `null` =
   * the formats it always had. Same reasoning as `session-policy`.
   */
  @Public()
  @Get('display-locale')
  async displayLocale(): Promise<{ locale: string | null }> {
    return { locale: (await this.settings.region()).displayLocale.value };
  }

  @AllowWhileMustChangePw()
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: SessionUser,
    @Body() dto: ChangePasswordDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.changePassword(
      user.userId,
      dto.currentPassword,
      dto.newPassword,
      ip,
    );
    // The token carries mustChangePw; without issuing a new one the user
    // would stay stuck even after changing the password
    await this.tokens.issue(res, { ...user, mustChangePw: false });
  }

  // ══════════════════ I06: optional TOTP 2FA ══════════════════
  //
  // Careful: none of these has `@AllowWhileMustChangePw()`. If someone could
  // set up 2FA on the first login using the temporary password, that weak
  // password would stay in place; change the password first, then 2FA.

  @Get('2fa')
  twoFactorStatus(@CurrentUser() user: SessionUser): Promise<TwoFactorStatus> {
    return this.twoFactor.status(user.userId);
  }

  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  setupTwoFactor(
    @CurrentUser() user: SessionUser,
    @Ip() ip: string,
  ): Promise<TwoFactorSetup> {
    return this.twoFactor.setup(user.userId, ip);
  }

  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  enableTwoFactor(
    @CurrentUser() user: SessionUser,
    @Body() dto: TotpCodeDto,
    @Ip() ip: string,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.twoFactor.enable(user.userId, dto.code, ip);
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  disableTwoFactor(
    @CurrentUser() user: SessionUser,
    @Body() dto: PasswordConfirmDto,
    @Ip() ip: string,
  ): Promise<void> {
    return this.twoFactor.disable(user.userId, dto.password, ip);
  }

  @Post('2fa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  regenerateRecoveryCodes(
    @CurrentUser() user: SessionUser,
    @Body() dto: PasswordConfirmDto,
    @Ip() ip: string,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.twoFactor.regenerateRecoveryCodes(user.userId, dto.password, ip);
  }
}
