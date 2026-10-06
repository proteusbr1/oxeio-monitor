import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TASK_NUMBER_SQL_EXPR } from '../summary/task-start.rules';

/**
 * **On-screen time**: how long, in total, a window whose title starts with a
 * given task number was in front, in the start-detection apps.
 *
 * Careful: **why this exists.** A task's "done" mark is the assignee's
 * **own claim**; nobody verifies it. The agent already keeps window titles,
 * so the time a numbered window was in front is already in the table, and
 * showing it next to the claim answers "was this ever opened?" without anyone
 * writing a query by hand.
 *
 * Careful: **this does not measure "was the work done".** There are many
 * innocent reasons for no trace: the file was never saved, the number was not
 * put at the start of the name, or the work was done in another app. So the
 * number is **context, not an accusation**, which is also why it has no alert.
 *
 * Every method takes the lower-cased app list (`TasksSettingsService.detectionApps()`);
 * with an empty list nothing is asked at all.
 */
@Injectable()
export class OnScreenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * **Since which day titles have been stored**: `'YYYY-MM-DD'`, or `null`
   * if there is nothing.
   *
   * Careful: **no row before this date can be used to say "never on
   * screen"**, because nothing was watched then.
   *
   * The date comes **from the data**, not a constant: if old rows are ever
   * trimmed, the boundary moves forward by itself.
   *
   * Careful: deliberately not cached (a cache leaked between tests once);
   * the scan costs tens of ms, once per list page.
   */
  async since(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ d: string | null }[]>`
      SELECT min(work_date)::text AS d FROM app_usage`;

    return rows[0]?.d ?? null;
  }

  /**
   * **Marked done, yet a window with that number was never in front**: the
   * task numbers completed after `from`.
   *
   * Careful: **the question is asked from `tasks`, not from `app_usage`**:
   * one index probe per finished task, instead of running the title regex
   * over every stored title again.
   *
   * Careful: the returned list goes to Prisma as `IN (...)`. Past ~30
   * thousand numbers Postgres's parameter limit comes near, and then the
   * filter and the paging must move into SQL.
   */
  async unseenTaskNumbers(from: Date, apps: ReadonlySet<string>): Promise<number[]> {
    if (apps.size === 0) return [];

    /**
     * Careful: in the inner query `window_title`/`process_name` are written
     * **without qualification**, exactly as in the `migration.sql` index. The
     * inner scope is searched first, so they are `app_usage`'s own columns.
     */
    const rows = await this.prisma.$queryRaw<{ task_number: number }[]>`
      SELECT t.task_number
      FROM tasks t
      WHERE t.completed_at >= ${from}
        AND t.task_number IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM app_usage a
          WHERE ${Prisma.raw(TASK_NUMBER_SQL_EXPR)} = t.task_number::text
            AND lower(process_name) = ANY(${[...apps]}::text[])
        )`;

    return rows.map((r) => r.task_number);
  }

  /**
   * **Total seconds for each of these numbers**; a number not found is
   * **absent from the map** (no zero is inserted; the caller decides the difference).
   *
   * Careful: it is called only for the page on screen (50 rows), so it is 50
   * index lookups, not the whole table.
   */
  async secondsFor(
    taskNumbers: readonly number[],
    apps: ReadonlySet<string>,
  ): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (taskNumbers.length === 0 || apps.size === 0) return out;

    const ids = taskNumbers.map((n) => String(n));

    const rows = await this.prisma.$queryRaw<{ num: string; sec: number }[]>`
      SELECT ${Prisma.raw(TASK_NUMBER_SQL_EXPR)} AS num,
             sum(duration_sec)::int AS sec
      FROM app_usage
      WHERE ${Prisma.raw(TASK_NUMBER_SQL_EXPR)} IN (${Prisma.join(ids)})
        AND lower(process_name) = ANY(${[...apps]}::text[])
      GROUP BY 1`;

    for (const r of rows) {
      const n = Number.parseInt(r.num, 10);
      if (Number.isSafeInteger(n)) out.set(n, r.sec);
    }

    return out;
  }
}
