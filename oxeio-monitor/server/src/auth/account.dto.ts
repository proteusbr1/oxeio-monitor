import { IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { THEMES, type Theme } from './preferences';

/** PATCH /account — only what a person may change about themselves */
export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'The name is too short' })
  @MaxLength(120)
  fullName?: string;

  /** `null` = back to this browser's own choice */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(THEMES)
  theme?: Theme | null;
}
