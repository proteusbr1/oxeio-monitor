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

  /** ⭐ একমাত্র টার্গেট — ডিফল্ট ২০৮ ঘণ্টা (ADR-011b) */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(744)
  monthlyTargetHours?: number;

  @IsOptional() @IsInt() @Min(1) @Max(31)
  expectedWorkdays?: number;

  /**
   * ISO দিন — সোম = ১ … রবি = ৭, শুক্র = ৫।
   * ⚠️ এটা ব্লক নয়; ছুটির দিনে কাজ করলেও ঘণ্টা পুরোপুরি গোনা হয়।
   */
  // ISO days (Fri = 5), unique; at most 6, so a week keeps at least one workday
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ArrayUnique()
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  weeklyOffDays?: number[];

  /** ⭐ না দিলে ০৭:০০–২৩:০০ বসে — `null` করে ২৪ ঘণ্টা করা যায় না (ADR-011c) */
  @IsOptional() @Matches(HHMM, { message: "screenshotFrom must be in 'HH:MM' format" })
  screenshotFrom?: string;

  @IsOptional() @Matches(HHMM, { message: "screenshotTo must be in 'HH:MM' format" })
  screenshotTo?: string;

  /**
   * ⭐⭐ **অফিস কখন খোলা** — শুধু `agent_down` অ্যালার্ট কখন **তোলা হবে না**
   * তা ঠিক করে (G01)। ⚠️ ঘণ্টা গোনায় কোনো প্রভাব নেই।
   *
   * ⚠️ না দিলে খালি থাকে, আর খালি মানে **সারাদিনই খোলা** — অর্থাৎ আগের
   *    আচরণ। "নীরবে পাহারা বন্ধ" হওয়ার চেয়ে "বেশি অ্যালার্ট" নিরাপদ।
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
   * ⭐ ডিজাইনারের দৈনিক টার্গেট (মালিকের চাওয়া ২৫)।
   * ⚠️ ০ **বৈধ** — টার্গেট বন্ধ, কিন্তু সংখ্যা গোনা চলতেই থাকে।
   * ⚠️ ছাদ ৫০০: টাইপো ধরার জন্য, নীতির জন্য নয়।
   */
  @IsOptional() @IsInt() @Min(0) @Max(500)
  dailyDesignTarget?: number;
}
export class UpdateWorkPolicyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(744)
  monthlyTargetHours?: number;

  @IsOptional() @IsInt() @Min(1) @Max(31)
  expectedWorkdays?: number;

  // ISO days (Fri = 5), unique; at most 6, so a week keeps at least one workday
  @IsOptional() @IsArray() @ArrayMaxSize(6) @ArrayUnique()
  @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  weeklyOffDays?: number[];

  @IsOptional() @Matches(HHMM)
  screenshotFrom?: string;

  @IsOptional() @Matches(HHMM)
  screenshotTo?: string;

  /** ⭐ অফিসের সময় — `agent_down` অ্যালার্টের জানালা (G01) */
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
   * ⭐ ডিজাইনারের দৈনিক টার্গেট (মালিকের চাওয়া ২৫)।
   * ⚠️ ০ **বৈধ** — টার্গেট বন্ধ, কিন্তু সংখ্যা গোনা চলতেই থাকে।
   * ⚠️ ছাদ ৫০০: টাইপো ধরার জন্য, নীতির জন্য নয়।
   */
  @IsOptional() @IsInt() @Min(0) @Max(500)
  dailyDesignTarget?: number;
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
export class CreateHolidayDto {
  @Matches(DATE_ONLY, { message: 'holidayDate must be in YYYY-MM-DD format' })
  holidayDate!: string;

  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  /** public | optional | company — খোলা রাখা হয়েছে, স্কিমাতেও TEXT */
  @IsOptional() @IsString() @MaxLength(32)
  type?: string;
}
export class UpdateHolidayDto {
  @IsOptional() @Matches(DATE_ONLY)
  holidayDate?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(32)
  type?: string;
}
export class HolidayListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100)
  year?: number;
}
/**
 * R1 — মাস বন্ধ করার সাথে ঐচ্ছিক একটা নোট।
 *
 * ⚠️ নোটটা **কেন** বন্ধ করা হলো তার জায়গা ("আগস্টের বেতন ৩ সেপ্টেম্বর
 *    দেওয়া হয়েছে")। ছয় মাস পরে কেউ audit ঘাঁটলে তারিখটার চেয়ে কারণটাই
 *    বেশি কাজে দেয়।
 */
/**
 * R2 — ছুটি লেখা।
 *
 * ⚠️ `from`/`to` **তারিখ, সময় নয়** — `@IsISO8601` একা `2026-09-10T14:00Z`-ও
 *    মেনে নিত, আর তখন `new Date(...T00:00Z)`-এর সাথে তুলনা করে দিনটা এক
 *    দিন সরে যেত। তাই `Matches` দিয়ে আকারটাও বাঁধা।
 */
export class CreateLeaveDto {
  @IsInt()
  @Min(1)
  employeeId!: number;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to!: string;

  /** ⚠️ তিনটেই সবেতন — `unpaid` কেন নেই, `schema.prisma`-র নোট দেখুন */
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
