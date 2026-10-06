import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DATE_ONLY, HHMM } from '../common/patterns';

// ── work policies ───────────────────────────────────────────────────────────

export class CreateWorkPolicyDto {
  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  /** The only target; default 176 hours (the column default) */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(744)
  monthlyTargetHours?: number;

  @IsOptional() @IsInt() @Min(1) @Max(31)
  expectedWorkdays?: number;

  // ── the work regime (calendar/work-regime.ts) ──
  @IsOptional() @IsIn(['month', 'week', 'day', 'none'])
  targetBasis?: 'month' | 'week' | 'day' | 'none';

  /** basis = week: hours per week */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(168)
  weeklyTargetHours?: number | null;

  /** basis = day: hours per workday */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.5) @Max(24)
  dailyTargetHours?: number | null;

  /** a fixed schedule's break, in minutes (informational) */
  @IsOptional() @IsInt() @Min(0) @Max(480)
  breakMinutes?: number | null;

  /** overtime paid at this multiple of the hourly rate; null = not paid */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(5)
  overtimeMultiplier?: number | null;

  /** monthly salaries: deduct missing hours */
  @IsOptional() @IsBoolean()
  deductShortfall?: boolean;


  /**
   * ISO weekday: Mon = 1 ... Sun = 7, Fri = 5.
   * Careful: this is not a block; if someone works on an off day the hours are counted in full.
   */
  // ISO days (Fri = 5), unique; at most 6, so a week keeps at least one workday
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ArrayUnique()
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  weeklyOffDays?: number[];

  /** If omitted, 07:00-23:00 is set; it cannot be made 24 hours by setting `null` (ADR-011c) */
  @IsOptional() @Matches(HHMM, { message: "screenshotFrom must be in 'HH:MM' format" })
  screenshotFrom?: string;

  @IsOptional() @Matches(HHMM, { message: "screenshotTo must be in 'HH:MM' format" })
  screenshotTo?: string;

  /**
   * **When the office is open.** Only decides when an `agent_down` alert is
   * **not raised** (G01). Careful: no effect on counting hours.
   *
   * Careful: if omitted it stays empty, and empty means **open all day**,
   *    the earlier behavior. "More alerts" is safer than "guarding silently switched off".
   */
  @IsOptional() @Matches(HHMM, { message: "officeFrom must be in 'HH:MM' format" })
  officeFrom?: string;

  @IsOptional() @Matches(HHMM, { message: "officeTo must be in 'HH:MM' format" })
  officeTo?: string;

  @IsOptional() @IsInt() @Min(10) @Max(3600)
  idleThresholdSec?: number;

  @IsOptional() @IsInt() @Min(1) @Max(60)
  slotMinutes?: number;

  /** false = no screenshots for this policy (the jiggler check keeps running) */
  @IsOptional() @IsBoolean()
  screenshotsEnabled?: boolean;

  /**
   * Tasks per day for people who receive tasks (default 25).
   * Careful: 0 is **valid**: the target is off, but counting continues.
   * Careful: the ceiling of 500 is for catching typos, not for policy.
   */
  @IsOptional() @IsInt() @Min(0) @Max(500)
  dailyTaskTarget?: number;
}
export class UpdateWorkPolicyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(744)
  monthlyTargetHours?: number;

  @IsOptional() @IsInt() @Min(1) @Max(31)
  expectedWorkdays?: number;

  // ── the work regime (calendar/work-regime.ts) ──
  @IsOptional() @IsIn(['month', 'week', 'day', 'none'])
  targetBasis?: 'month' | 'week' | 'day' | 'none';

  /** basis = week: hours per week */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(168)
  weeklyTargetHours?: number | null;

  /** basis = day: hours per workday */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.5) @Max(24)
  dailyTargetHours?: number | null;

  /** a fixed schedule's break, in minutes (informational) */
  @IsOptional() @IsInt() @Min(0) @Max(480)
  breakMinutes?: number | null;

  /** overtime paid at this multiple of the hourly rate; null = not paid */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(5)
  overtimeMultiplier?: number | null;

  /** monthly salaries: deduct missing hours */
  @IsOptional() @IsBoolean()
  deductShortfall?: boolean;


  // ISO days (Fri = 5), unique; at most 6, so a week keeps at least one workday
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ArrayUnique()
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  weeklyOffDays?: number[];

  @IsOptional() @Matches(HHMM)
  screenshotFrom?: string;

  @IsOptional() @Matches(HHMM)
  screenshotTo?: string;

  /** Office hours: the window for the `agent_down` alert (G01) */
  @IsOptional() @Matches(HHMM)
  officeFrom?: string;

  @IsOptional() @Matches(HHMM)
  officeTo?: string;

  @IsOptional() @IsInt() @Min(10) @Max(3600)
  idleThresholdSec?: number;

  @IsOptional() @IsInt() @Min(1) @Max(60)
  slotMinutes?: number;

  /** false = no screenshots for this policy (the jiggler check keeps running) */
  @IsOptional() @IsBoolean()
  screenshotsEnabled?: boolean;

  /**
   * Tasks per day for people who receive tasks (default 25).
   * Careful: 0 is **valid**: the target is off, but counting continues.
   * Careful: the ceiling of 500 is for catching typos, not for policy.
   */
  @IsOptional() @IsInt() @Min(0) @Max(500)
  dailyTaskTarget?: number;
}
// ── holidays ────────────────────────────────────────────────────────────────

/** A holiday calendar file, read in the browser and sent as text */
export class ImportHolidaysDto {
  @IsString() @MaxLength(255)
  fileName!: string;

  // a year of national + local holidays is a few KB; this is generous
  @IsString() @MaxLength(1_000_000)
  content!: string;

  // true = also current and past months (changes their targets and salary)
  @IsOptional() @IsBoolean()
  allowPast?: boolean;

  // default true: show what would happen, write nothing
  @IsOptional() @IsBoolean()
  dryRun?: boolean;
}
/** A country's public holidays for one year (Nager.Date) */
export class ImportPublicHolidaysDto {
  @Matches(/^[A-Za-z]{2}$/, { message: 'country must be a two-letter code, e.g. BR' })
  country!: string;

  @IsInt() @Min(2000) @Max(2100)
  year!: number;

  @IsOptional() @IsBoolean()
  allowPast?: boolean;

  @IsOptional() @IsBoolean()
  dryRun?: boolean;
}

export class CreateHolidayDto {
  @Matches(DATE_ONLY, { message: 'holidayDate must be in YYYY-MM-DD format' })
  holidayDate!: string;

  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  /** public | optional | company: left open, and the schema column is TEXT too */
  @IsOptional() @IsString() @MaxLength(32)
  type?: string;

  /** the date is an estimate that may still move (default false) */
  @IsOptional() @IsBoolean()
  approximate?: boolean;
}
export class UpdateHolidayDto {
  @IsOptional() @Matches(DATE_ONLY)
  holidayDate?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(32)
  type?: string;

  /** false once the date is confirmed */
  @IsOptional() @IsBoolean()
  approximate?: boolean;
}
export class HolidayListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100)
  year?: number;
}
/**
 * R1: an optional note along with closing a month.
 *
 * Careful: the note is the place for **why** it was closed ("August's pay
 *    was given on 3 September"). Six months later, when someone digs through
 *    the audit, the reason helps more than the date.
 */
/**
 * R2: writing leave.
 *
 * Careful: `from`/`to` are **dates, not times**. `@IsISO8601` alone would
 *    also accept `2026-09-10T14:00Z`, and compared with `new Date(...T00:00Z)`
 *    the day would shift by one. So the shape is pinned down with `Matches` too.
 */
export class CreateLeaveDto {
  @IsInt()
  @Min(1)
  employeeId!: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to!: string;

  /** Careful: all three are paid; for why `unpaid` is missing, see the note in `schema.prisma` */
  @IsIn(['casual', 'sick', 'annual'])
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}
export class CloseMonthDto {
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

/** PATCH /holidays/auto — the automatic public-holiday update */
export class HolidayAutoDto {
  @IsBoolean()
  enabled!: boolean;
}
