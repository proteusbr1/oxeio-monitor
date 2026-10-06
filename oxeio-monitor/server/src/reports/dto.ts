import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  Matches,
  Max,
} from 'class-validator';

import { MAX_RANGE_DAYS, type GroupBy } from './reports.range';

/** json = for the dashboard · xlsx = F05 download · pdf = F06 for printing */
export type ReportFormat = 'json' | 'xlsx' | 'pdf';

const DATE_MESSAGE = 'Date must be in YYYY-MM-DD format';

/**
 * The global ValidationPipe has `whitelist + forbidNonWhitelisted` on, so a
 * query param missing from the DTO gives a 400. If someone types `?form=xlsx`
 * they get a clear error instead of quietly receiving JSON.
 *
 * The regex only checks the shape here; 30 February is caught in
 * `parseWorkDate()` (reports.range.ts): calendar validation lives in the pure
 * function, not in two places.
 */
export class ReportRangeQuery {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  to!: string;

  @IsOptional()
  @IsIn(['json', 'xlsx', 'pdf'], {
    message: 'format must be json, xlsx or pdf',
  })
  format?: ReportFormat;

  /** When a single staff member's report is wanted */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  employeeId?: number;
}

/** F02: weekly/monthly summary */
export class SummaryQuery extends ReportRangeQuery {
  @IsOptional()
  @IsIn(['week', 'month'], { message: 'groupBy must be week or month' })
  groupBy?: GroupBy;
}

/** F04: by app/site */
export class ProductivityQuery extends ReportRangeQuery {
  /**
   * `pdf` is **not** allowed here: F06 is only for attendance and the summary.
   *
   * The limit lives **in the DTO**, not in an `if` in the controller. In the
   * controller, `?format=pdf` would quietly return JSON (or an empty file), and
   * the user would think the download failed. Here the answer is a clear 400,
   * including which formats work.
   *
   * (class-validator treats a subclass decorator as a replacement for an
   * inherited decorator of the same kind; replace or add, `pdf` is blocked here
   * either way.)
   */
  @IsOptional()
  @IsIn(['json', 'xlsx'], {
    message:
      'The productivity report has no PDF — format must be json or xlsx (use attendance or summary for printing)',
  })
  // Do not remove `= undefined`. `useDefineForClassFields` is on (target
  // ES2023), so overriding a base-class field without an initialiser is
  // TS2612. `declare` would not work: decorators cannot go on a declare field,
  // and the decorator is the whole point here.
  override format?: ReportFormat = undefined;

  /**
   * How many top apps/sites to return.
   * Without a limit, a one-year range would return thousands of domains at
   * once; the response would be huge, yet nobody reads rows below 200.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(200)
  limit?: number;
}

/** For use in error messages: the DTO and the documentation say the same number */
export const MAX_REPORT_DAYS = MAX_RANGE_DAYS;
