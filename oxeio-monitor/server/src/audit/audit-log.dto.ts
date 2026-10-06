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

  /** Careful: treated as inclusive, not exclusive; explained in the service below */
  @IsOptional() @IsISO8601()
  to?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  /**
   * Careful: asking for more than 200 returns 400; it is not quietly cut down
   * to 200. If it were, the client would think it had received everything when it had not.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize?: number;
}
