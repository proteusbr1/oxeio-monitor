import { Matches } from 'class-validator';

const DATE_MESSAGE = 'Date must be in YYYY-MM-DD format';

/**
 * Careful: the regex only checks the **shape**; 31 February is caught by
 * `parseWorkDate()` (reports.range.ts). Calendar validation lives in the pure
 * function, not in two places.
 *
 * Careful: there is deliberately **no** `@Type(() => Date)`. It would turn
 * `2026-08-10` into a UTC instant first, and then "which work day" would depend
 * on the server's timezone. A work day belongs to the work-zone calendar (§ 2.1-a),
 * so the string goes all the way to the service.
 */
export class MyDaysQuery {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  to!: string;
}
