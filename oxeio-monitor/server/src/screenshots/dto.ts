import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Note: the global ValidationPipe runs with `whitelist + forbidNonWhitelisted`
 * (app.setup.ts), so any query parameter not declared here gets an immediate
 * 400. A typo like `?employee_id=3` (snake_case) is caught at once instead of
 * being silently ignored.
 */
export class GalleryQueryDto {
  /**
   * Careful: for role=employee this value is ignored. The employee is taken
   * from the session instead (see screenshots.service.ts); trusting the query
   * would let anyone view another person's screenshots.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'employeeId must be an integer' })
  @Min(1)
  employeeId?: number;

  /** Defaults to today's work day in Dhaka when omitted. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Date must be in YYYY-MM-DD format',
  })
  date?: string;

  /**
   * Careful: the upper bound is deliberate. `page=99999999` would force
   * Postgres to count a huge OFFSET, which is a cheap DoS.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;
}

export class ScreenshotFileQueryDto {
  @IsString()
  @IsNotEmpty({ message: 'token is required' })
  token!: string;
}
