import { UserRole } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { MIN_PASSWORD_LENGTH } from './auth.constants';

export class LoginDto {
  @IsEmail({}, { message: 'Email is not valid' })
  @MaxLength(200)
  email!: string;

  @IsString()
  @MinLength(1, { message: 'Enter your password' })
  @MaxLength(200)
  password!: string;

  /**
   * I06: the second step of optional 2FA. Absent on the first call; if the
   * server returns `{ needsTotp: true }` it comes back with email + password.
   * Careful: 10 characters, because copying a 6-digit code from the app can bring in a space.
   */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  totp?: string;

  /** If the phone is lost: a single-use code of the form `ABCDE-FGHJK` */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  recoveryCode?: string;
}

/** Careful: 6 digits, but spaces/dashes are accepted; normalizing happens on the server */
export class TotpCodeDto {
  @IsString()
  @MinLength(6, { message: 'Enter the 6-digit code' })
  @MaxLength(10)
  code!: string;
}

/**
 * Careful: turning off 2FA and regenerating recovery codes both need the
 * password. If the session cookie alone were enough, 2FA could be switched
 * off from a laptop left open, yet the whole purpose of 2FA is protection
 * against cookie theft.
 */
export class PasswordConfirmDto {
  @IsString()
  @MinLength(1, { message: 'Enter your password' })
  @MaxLength(200)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(200)
  currentPassword!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  @MaxLength(200)
  newPassword!: string;
}

export class CreatePortalAccountDto {
  @IsEmail({}, { message: 'Email is not valid' })
  @MaxLength(200)
  email!: string;

  /** The owner may create a manager too; default employee */
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  /**
   * **A password chosen by the owner.**
   *
   * Careful: optional. If omitted, the system generates a random password
   * (shown to the owner once), but **in no case is a change demanded**
   * ([ADR-033](../../../docs/05-Options-Decisions.md)).
   */
  @IsOptional()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  @MaxLength(200)
  password?: string;
}

export class EmployeeIdParam {
  @IsInt()
  id!: number;
}

/**
 * The owner resets someone's password, optionally setting one directly.
 *
 * Careful: leaving the field empty keeps the earlier behavior intact: a
 * random password, and a mandatory change on first login.
 */
export class ResetPasswordDto {
  @IsOptional()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  @MaxLength(200)
  password?: string;
}

