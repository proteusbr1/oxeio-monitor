import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { IsEmail, IsIn } from 'class-validator';
import { UserRole } from '@prisma/client';

import { AuthService } from '../auth/auth.service';
import { ResetPasswordDto } from '../auth/dto';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';

/**
 * Careful: `owner` is deliberately **left out of the list**, so `@IsIn` is
 * the **first** net, not the second. The service blocks it separately too,
 * but stopping it here means the request never reaches any business code.
 */
class ChangeRoleDto {
  /**
   * `coordinator` adds and checks tasks; `owner` is still excluded (ADR-011d).
   *
   * Careful: the list is written by hand rather than borrowed from `UserRole`,
   * on purpose. If a new value is added to the enum tomorrow, it must not
   * slip in here by itself. Widening the role-assignment list is a decision,
   * not an accident.
   */
  @IsIn(['employee', 'coordinator', 'manager', 'finance'])
  role!: 'employee' | 'coordinator' | 'manager' | 'finance';
}

class ChangeEmailDto {
  /** Careful: validated with `class-validator`; the service check is the second net. */
  @IsEmail()
  email!: string;
}

@Controller('users')
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  /**
   * The owner resets someone's password.
   * Careful: the `tempPassword` in the response can be seen **only once**; it is stored nowhere.
   */
  @Roles(UserRole.owner)
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  reset(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResetPasswordDto,
    @Ip() ip: string,
  ): Promise<{ email: string; tempPassword: string }> {
    // Leaving the field empty keeps the old behaviour: random password + forced change.
    return this.auth.resetPassword(actor.userId, id, ip, dto.password);
  }

  /**
   * Change the login email, which is the staff member's "username".
   *
   * Careful: the password has its own route (`reset-password`), on purpose.
   * Fixing a spelling mistake must not change someone's password needlessly.
   */
  @Roles(UserRole.owner)
  @Patch(':id/email')
  changeEmail(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeEmailDto,
    @Ip() ip: string,
  ): Promise<{ id: number; email: string }> {
    return this.auth.changeLoginEmail(actor.userId, id, dto.email, ip);
  }

  /**
   * Staff <-> manager.
   *
   * Careful: the role used to be set only when the account was created.
   * Changing it meant deleting the account and creating a new one, with a new
   * password and a broken audit-log history for that person.
   */
  @Roles(UserRole.owner)
  @Patch(':id/role')
  changeRole(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeRoleDto,
    @Ip() ip: string,
  ): Promise<{ id: number; email: string; role: UserRole }> {
    return this.auth.changeRole(actor.userId, id, dto.role, ip);
  }
}
