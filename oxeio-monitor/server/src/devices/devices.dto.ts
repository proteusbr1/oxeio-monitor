import { DeviceStatus, RolloutStage } from '@prisma/client';
import { Type } from 'class-transformer';
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
  ValidateIf,
} from 'class-validator';

// ── devices ─────────────────────────────────────────────────────────────────

export class DeviceListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  employeeId?: number;

  @IsOptional() @IsEnum(DeviceStatus)
  status?: DeviceStatus;
}
/**
 * ⭐ কারণ বাধ্যতামূলক — `time_adjustments.reason`-এর মতোই।
 * দূর থেকে কারো মেশিন থামিয়ে দেওয়া এমন কাজ যার ব্যাখ্যা ছয় মাস পরেও
 * লাগতে পারে, আর তখন কারো মনে থাকবে না।
 */
export class RevokeDeviceDto {
  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}
export class RestoreDeviceDto {
  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}
export class CreateEnrollmentCodeDto {
  @IsInt() @Min(1)
  employeeId!: number;
}
// ── H04 · এজেন্টের ভার্সন বিলি ──────────────────────────────────────────────

/**
 * ⚠️ `sha256` **ঐচ্ছিক**, আর সেটাই মূল সিদ্ধান্ত: সার্ভার নিজে ফাইল পড়ে
 * হিসাব করে। দিলে **মিলিয়ে দেখা হয়** — না মিললে ৪০০।
 *
 * হাতে বসানো হ্যাশে একটা অক্ষর ভুল হলে ১৫টা PC ফাইলটা নামাত, sha256
 * না মেলায় বাতিল করত, আবার নামাত — চিরকাল। লগে কেবল "hash mismatch"
 * লেখা থাকত, ভুলটা যে টাইপোতে সেটা কেউ ধরত না।
 */
export class PublishVersionDto {
  /**
   * ⚠️ SemVer — `rollout.ts`-এর `isNewer()` এই ফরম্যাটই তুলনা করে।
   * `0.2` বা `v0.2.0` দিলে তুলনাটা এলোমেলো হতো।
   */
  @Matches(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, {
    message: 'version must look like 0.2.0',
  })
  version!: string;

  /** storage রুটের ভেতরের পাথ — `updates/oXeioAgent-0.2.0.msi` */
  @IsString() @MaxLength(400)
  msiPath!: string;

  @IsOptional() @IsString() @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'sha256 must be 64 hex characters',
  })
  sha256?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  releaseNotes?: string;

  @IsOptional() @IsEnum(RolloutStage)
  rolloutStage?: RolloutStage;

  @IsOptional() @IsBoolean()
  isMandatory?: boolean;
}
export class SetStageDto {
  @IsEnum(RolloutStage)
  rolloutStage!: RolloutStage;

  @IsOptional() @IsBoolean()
  isMandatory?: boolean;

  /**
   * ⭐⭐ **যে একটা PC বালতি নির্বিশেষে আগে পাবে** *(১ সেপ্টেম্বর ২০২৬)*।
   *
   * ⚠️ `null` পাঠানো মানে **পাইলট তুলে দেওয়া**, আর ঘরটা না পাঠানো মানে
   * "যা ছিল তাই থাক" — দুটো আলাদা কথা, তাই `@IsOptional()` আর
   * `@ValidateIf` দুটোই লাগে। নইলে ধাপ বদলাতে গেলেই পাইলট নীরবে মুছে যেত।
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  pilotDeviceId?: number | null;
}
