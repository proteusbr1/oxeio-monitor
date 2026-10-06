import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  DESIGN_APPS_SQL,
  DESIGN_ID_SQL_EXPR,
} from '../summary/design.rules';

/**
 * **File trace**: how long, in total, a file with a given job number was on
 * screen in a design app.
 *
 * Careful: **why this was needed.** A target's "done" mark is the employee's
 * **own claim**; nobody verifies it, and the system puts it on the board
 * without question. On 8 September one person's 32 "done" marks were
 * questioned, and answering meant hand-writing a database query, because the
 * screen showed the claim with nothing next to it.
 *
 * No new data had to be collected: the agent **already** keeps window titles,
 * and file names start with the job number. So the answer to the question was
 * already in the table; nobody asked.
 *
 * Careful: **this does not measure "was the work done".** What it measures is
 * *whether a file with that number was open in Illustrator/Photoshop*. There
 * are many innocent reasons for no trace: the file was not saved
 * (`Untitled-20*`), the number was not put at the front of the name, or the
 * work was done in another app. So the number is **context, not an
 * accusation**, which is also why it has no alert.
 */
@Injectable()
export class FileTraceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * **Since which day titles have been stored**: `'YYYY-MM-DD'`, or `null`
   * if there is nothing.
   *
   * Careful: **no row before this date can be used to say "the file was never
   * opened"**, because we were not watching then. In the field `app_usage`
   * started on 13 August 2026, yet completed targets go back to 2025; those
   * 27 thousand rows would all be shown as "no trace" and the list would be meaningless.
   *
   * The date comes **from the data**, not a constant: if old rows are ever
   * trimmed, the boundary moves forward by itself and nobody has to remember.
   *
   * ### Cost, measured (9 September 2026)
   *
   * There is no index on `min(work_date)`, so this is a parallel seq scan over
   * the whole of `app_usage`: **32-54 ms** on 154,000 rows in production, once
   * each time the list is opened. The table grows by about 7 thousand rows a day.
   *
   * Careful: **a 10-minute cache was written, then removed**: in tests the
   * service is **a single instance**, and `resetDatabase()` does not clear that
   * cache, so one test's boundary leaked into the next. A cache that needs
   * poking in tests to stay correct can also be wrong in production; hidden
   * state is not worth buying for 32 ms.
   *
   * If it ever becomes a real problem there are two proper ways, both
   * without hidden state: an index on `app_usage(work_date)`, or storing the
   * number in a small table like `summary_dirty`.
   */
  async since(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ d: string | null }[]>`
      SELECT min(work_date)::text AS d FROM app_usage`;

    return rows[0]?.d ?? null;
  }

  /**
   * **Marked done, yet a file with that number was never opened**: the list
   * of job numbers after `from`.
   *
   * Careful: **the question is asked from `design_targets`, not from
   * `app_usage`, and that direction is the whole difference in cost**
   * (measured in production, 9 September 2026).
   *
   * | direction | what happens | time |
   * |---|---|---|
   * | `app_usage` -> all, then `NOT IN` | regex run **again** over 14,225 rows | **930 ms** |
   * | `design_targets` -> one probe each | 1,821 index lookups, 5 us each | **25 ms** |
   *
   * The expression is **already built into the index**; the first way did not
   * use it at all: it used the index only to pick rows, then read from the
   * heap and re-ran the regex (`Bitmap Heap Scan`, 3,884 blocks).
   *
   * Careful: the returned list goes to Prisma as `IN (...)`. Today it is
   * **470**; it will grow slowly (and **shrink** if naming files properly
   * becomes a better habit). Past 30 thousand, Postgres's parameter limit
   * comes near, and then both the filter and the paging must move into SQL.
   *
   * Careful: six digits or fewer **are caught here too**: `keepKnownLongIds`
   * filters long numbers only when credits are written, and what is matched
   * here is `design_targets.job_number`, which by definition is a "known number".
   */
  async unseenJobNumbers(from: Date): Promise<number[]> {
    /**
     * Careful: in the inner query `window_title`/`process_name` are written
     * **without qualification**, exactly as in the `migration.sql` index. The
     * inner scope is searched first, so they are `app_usage`'s own columns.
     */
    const rows = await this.prisma.$queryRaw<{ job_number: number }[]>`
      SELECT t.job_number
      FROM design_targets t
      WHERE t.completed_at >= ${from}
        AND t.job_number IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM app_usage a
          WHERE ${Prisma.raw(DESIGN_APPS_SQL)}
            AND ${Prisma.raw(DESIGN_ID_SQL_EXPR)} = t.job_number::text
        )`;

    return rows.map((r) => r.job_number);
  }

  /**
   * **Total seconds for each of these numbers**; a number not found is
   * **absent from the map** (no zero is inserted; the caller decides the difference).
   *
   * Careful: it is called only for the page on screen (50 rows), so it is 50
   * index lookups, not the whole table.
   */
  async secondsFor(
    jobNumbers: readonly number[],
  ): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (jobNumbers.length === 0) return out;

    const ids = jobNumbers.map((n) => String(n));

    const rows = await this.prisma.$queryRaw<{ did: string; sec: number }[]>`
      SELECT ${Prisma.raw(DESIGN_ID_SQL_EXPR)} AS did,
             sum(duration_sec)::int AS sec
      FROM app_usage
      WHERE ${Prisma.raw(DESIGN_APPS_SQL)}
        AND ${Prisma.raw(DESIGN_ID_SQL_EXPR)} IN (${Prisma.join(ids)})
      GROUP BY 1`;

    for (const r of rows) {
      const n = Number.parseInt(r.did, 10);
      if (Number.isSafeInteger(n)) out.set(n, r.sec);
    }

    return out;
  }
}
