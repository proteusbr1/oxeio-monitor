import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * `?date=2026-08-10` — the same for the timeline and hourly endpoints.
 *
 * Careful: `@Type(() => Date)` is deliberately absent. With it, `2026-08-10`
 * would become a UTC instant first, and the answer to "which work day" would
 * depend on the time zone. The work day belongs to the work-zone calendar
 * (§ 2.1a), so the string goes to the service unchanged and `parseWorkDate`
 * handles it.
 *
 * Careful: the global ValidationPipe uses forbidNonWhitelisted, so any query
 * param other than `?date=` returns 400 instead of being silently ignored.
 */
export class WorkDateQueryDto {
  /** Defaults to today in the work zone when omitted */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be in YYYY-MM-DD format',
  })
  date?: string;
}
