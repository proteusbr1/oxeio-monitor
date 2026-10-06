import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard } from './guards/csrf.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MustChangePasswordGuard } from './guards/must-change-password.guard';
import { RolesGuard } from './guards/roles.guard';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { TwoFactorService } from './two-factor.service';

/**
 * All four guards are **global**: security is opt-out, not opt-in. Any new
 * controller you write is protected by default; to leave it open you must
 * deliberately write `@Public()`.
 *
 * The order matters:
 *   JWT -> CSRF -> forced password change -> role
 *
 * Why JWT first: with CSRF first, a request that was not logged in would also
 * get "CSRF mismatch" (403) when the real reason is "log in" (401). No
 * security loss either way: a CSRF attack uses the victim's cookie, so the
 * victim is logged in anyway.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    TwoFactorService,
    LoginThrottleService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: MustChangePasswordGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, TokenService, PasswordService],
})
export class AuthModule {}
