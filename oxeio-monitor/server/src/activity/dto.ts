import { MatchType, Productivity } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Input for D06-D09.
 *
 * Careful: the global `ValidationPipe` uses `whitelist` + `forbidNonWhitelisted`
 * ([app.setup.ts](../app.setup.ts)), so any field or query parameter that is
 * **not declared here** gets a 400 straight away. Typos are never ignored
 * silently.
 */

/** `YYYY-MM-DD`; whether it is a real date is checked by `parseWorkDate()`. */
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

// ── D06 · category rules ──────────────────────────────────────────────────────

export class CreateCategoryDto {
  @IsEnum(MatchType)
  matchType!: MatchType;

  /**
   * `code.exe` · `youtube.com` · regex.
   * Careful: the format is checked by `patternProblem()`, not class-validator,
   * because the rule depends on `matchType`.
   */
  @IsString()
  @MaxLength(260)
  pattern!: string;

  @IsString()
  @MaxLength(100)
  displayName!: string;

  @IsEnum(Productivity)
  category!: Productivity;

  /**
   * Careful: **the smaller number wins.** In the seed, browsers have 200 and
   * everything else 100, so a domain rule beats a browser rule. Entering 200
   * with the opposite assumption would put the new rule effectively last
   * ([category-matcher.ts](./category-matcher.ts)).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  priority?: number;
}

/**
 * All fields are optional, but **they cannot all be left empty**.
 * An empty `{}` gets a 400 from the service; otherwise it would return 200, the
 * owner would think the change was made, and nothing would have changed.
 */
export class UpdateCategoryDto {
  @IsOptional() @IsEnum(MatchType) matchType?: MatchType;
  @IsOptional() @IsString() @MaxLength(260) pattern?: string;
  @IsOptional() @IsString() @MaxLength(100) displayName?: string;
  @IsOptional() @IsEnum(Productivity) category?: Productivity;
  @IsOptional() @IsInt() @Min(1) @Max(1000) priority?: number;
}

export class RecategorizeDto {
  /**
   * When `true`, only rows with `category_id IS NULL` are processed, which is
   * much faster. That is enough after **adding** a new rule.
   *
   * Careful: after **changing or deleting** a rule it must be `false`, or rows
   * that already received the old decision would keep it.
   */
  @IsOptional()
  @IsBoolean()
  onlyUnmatched?: boolean;
}

// ── D07-D09 · report ranges ───────────────────────────────────────────────────

export class RangeQueryDto {
  /** The 1st of the current month if omitted. */
  @IsOptional()
  @Matches(DATE_FORMAT, { message: '`from` must be in YYYY-MM-DD format' })
  from?: string;

  /** Today's date in Dhaka if omitted. */
  @IsOptional()
  @Matches(DATE_FORMAT, { message: '`to` must be in YYYY-MM-DD format' })
  to?: string;
}

export class EmployeeRangeQueryDto extends RangeQueryDto {
  /**
   * **All active staff** if omitted.
   * Careful: `@Type(() => Number)` is needed, since query strings always arrive as strings.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;
}

export class TopQueryDto extends EmployeeRangeQueryDto {
  /** Default 10 (D08). The upper bound keeps one GET from dumping the whole table. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class TeamQueryDto extends RangeQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
