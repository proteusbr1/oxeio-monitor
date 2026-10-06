import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Careful: the global ValidationPipe is `whitelist + forbidNonWhitelisted` — a
 * field not listed here gives 400, it is not silently dropped.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class UpdateDepositPolicyDto {
  /**
   * **In minor units** (hundredths), not whole units — 500.00 = 50000.
   *
   * Careful: not a decimal string like salary, because an instalment has no
   * reason to include a fraction of a minor unit; with an integer, rounding never comes
   * up. The screen shows the amount in whole currency units and multiplies by 100 before sending.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_00)
  amountMinor?: number;

  /** '2026-08' — the month deductions start */
  @IsOptional()
  @Matches(YEAR_MONTH, { message: 'startYearMonth must be in YYYY-MM format' })
  startYearMonth?: string;

  /**
   * Careful: 0 is allowed — it means "no notice needed". It may sound odd but
   * it is valid, and blocking it would mean changing code to relax the rule.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  noticeDays?: number;

  /** Careful: `false` stops new instalments being posted — existing deposits stay intact */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class SettleDepositDto {
  /**
   * Careful: only two values, and also bound by a CHECK in the database. With a
   * typo the screen would show nothing, and the answer to "was it refunded or
   * not" would be silently lost.
   */
  @IsIn(['refunded', 'forfeited'])
  outcome!: 'refunded' | 'forfeited';

  /**
   * When notice was given, and the last working day.
   *
   * Careful: both are **optional** — for someone from long ago the dates may
   * not be remembered, and making them mandatory would force the owner to
   * invent one. If omitted, the system does not count notice days, and the row
   * keeps `null` — "unknown" and "zero days" are not the same thing.
   */
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'noticeGivenOn must be in YYYY-MM-DD format' })
  noticeGivenOn?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: 'lastWorkingDay must be in YYYY-MM-DD format' })
  lastWorkingDay?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * From which month this employee's deposit deductions start.
 *
 * Careful: `null` is **valid and meaningful** — it means "go back to the
 * policy's general start month". So not `@IsOptional()`, otherwise there
 * would be no way to clear the field.
 */
export class SetDepositStartDto {
  @ValidateIf((_, value) => value !== null)
  @Matches(YEAR_MONTH, { message: 'yearMonth must be in YYYY-MM format' })
  yearMonth!: string | null;
}

/**
 * **Correcting the amount of an instalment already posted.**
 *
 * Careful: this is not changing the rule, it is a **correction of a mistake**
 * — so `reason` is mandatory.
 */
export class CorrectInstalmentDto {
  @Matches(YEAR_MONTH, { message: 'yearMonth must be YYYY-MM' })
  yearMonth!: string;

  /**
   * Careful: `@Min(1)` — there is no way to enter zero, and that is by design.
   * A waiver means there is **no** instalment that month, not an instalment of
   * zero; merging the two ruins the answer to "how many months have been
   * paid" — which is exactly what happened in the field. To skip early months,
   * use `PATCH :id/start`.
   */
  @IsInt()
  @Min(1)
  @Max(100_000_00)
  amountMinor!: number;

  /** Careful: the only answer, six months later, to "why is that month's amount different" */
  @IsString()
  @MaxLength(300)
  reason!: string;
}
