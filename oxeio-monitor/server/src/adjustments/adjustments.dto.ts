import { AdjustmentCause } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** `YYYY-MM-DD`, like the other DTOs. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The most seconds that can be added or subtracted in one day.
 *
 * Careful: the 24-hour cap is more than a precaution. `delta_sec` is an `Int`,
 * and if the owner mistakenly entered milliseconds instead of seconds (7200000)
 * it would go in silently. That adds 2,000 hours to the month, and pace,
 * payroll and the dashboard would all become meaningless at once.
 */
export const ADJUSTMENT_MAX_SEC = 24 * 3600;

/**
 * **B14 · ADR-011e** - the owner gives back hours lost through a system fault.
 *
 * Careful: this is **not an approval system**. Staff claim nothing and press
 * nothing; the owner looks and decides. That distinction is the core rule of
 * the system (§ 4 · ADR-011d): once a "claim" exists, it drags in a whole
 * approval workflow.
 */
export class CreateAdjustmentDto {
  /** The day the hours count toward (Dhaka workday). */
  @Matches(DATE_ONLY, { message: 'workDate must be YYYY-MM-DD' })
  workDate!: string;

  /**
   * + = hours given back, - = deducted. Not zero.
   *
   * Careful: in seconds, not hours. The DB column is in seconds too; using
   * hours would round fractions differently in two places.
   */
  @IsInt()
  deltaSec!: number;

  @IsEnum(AdjustmentCause)
  cause!: AdjustmentCause;

  /**
   * Required, and that is the whole point: nobody's numbers may change without
   * a reason. Staff can read this text themselves (J08), so it is an
   * explanation, not a note.
   */
  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;

  /** The alert that serves as proof, e.g. that day's `agent_down`. */
  @IsOptional() @IsInt() @Min(1)
  evidenceAlertId?: number;

  /** Given more than the measured downtime; shown separately in reports. */
  @IsOptional() @IsBoolean()
  beyondEvidence?: boolean;
}

export class RevokeAdjustmentDto {
  /** Why it was revoked; kept in the record, since an adjustment can be wrong too. */
  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}
