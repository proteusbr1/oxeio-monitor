import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// ── audit log (E11) ─────────────────────────────────────────────────────────

export class AuditLogQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  userId?: number;

  @IsOptional() @IsString() @MaxLength(64)
  action?: string;

  @IsOptional() @IsString() @MaxLength(64)
  targetType?: string;

  @IsOptional() @IsString() @MaxLength(120)
  targetId?: string;

  /** ISO-8601 instant — `occurredAt >= from` */
  @IsOptional() @IsISO8601()
  from?: string;

  /** ⚠️ ধরা হয় **exclusive** নয়, inclusive — নিচে সার্ভিসে ব্যাখ্যা আছে */
  @IsOptional() @IsISO8601()
  to?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  /**
   * ⚠️ ২০০-র বেশি চাইলে ৪০০ — চুপচাপ ২০০-তে নামিয়ে দেওয়া হয় না।
   * নামিয়ে দিলে ক্লায়েন্ট ভাবত সে সব পেয়ে গেছে, অথচ পায়নি।
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize?: number;
}
