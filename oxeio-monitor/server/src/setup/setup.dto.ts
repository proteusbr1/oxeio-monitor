import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { MIN_PASSWORD_LENGTH } from '../auth/auth.constants';

/** Everything the first-run wizard sends, in one go */
export class SetupDto {
  /** the one-time token the server printed in its log at first start */
  @IsString() @MaxLength(200)
  token!: string;

  @IsString() @MaxLength(80)
  organizationName!: string;

  /** ISO 3166 two-letter code — work-week defaults and public holidays */
  @IsOptional() @IsString() @MaxLength(2)
  country?: string;

  @IsString() @MaxLength(64)
  timeZone!: string;

  @IsString() @MaxLength(3)
  currency!: string;

  /** '' = the formats oXeio always had */
  @IsOptional() @IsString() @MaxLength(20)
  displayLocale?: string;

  @IsString() @MinLength(2) @MaxLength(100)
  ownerName!: string;

  @IsEmail() @MaxLength(200)
  ownerEmail!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `The password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  @MaxLength(200)
  ownerPassword!: string;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(744)
  monthlyTargetHours?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(31)
  expectedWorkdays?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  weeklyOffDays?: number[];

  /** add the country's public holidays for this year and next */
  @IsOptional() @IsBoolean()
  importHolidays?: boolean;
}
