import type { PrismaService } from '../prisma/prisma.service';

/**
 * **"Since when have we been watching this employee"**: one place, for four callers.
 *
 * ## The bug this fixes
 *
 * The number used to come from the oldest `daily_summary` row. But
 * `refreshDate()` writes a row for **every active employee**, with or without
 * data, and that is deliberate, otherwise the heatmap could not tell
 * *"no data arrived"* from *"no work was done"*.
 *
 * So the number really measured **"since when the server has been running
 * with this employee"**, not *"since when their agent was installed"*. If an
 * employee was created on 1 October, a `no_activity` row appeared that same
 * day, so even if the agent went in on 8 October, **the seven days in between
 * counted as a full shortfall**. The principle *"absent monitoring is not a
 * failure"* did not hold for exactly the new employee.
 *
 * ## Why `work_sessions`
 *
 * Rows in this table are created **only inside the ingest transaction**,
 * i.e. only when the agent actually sent something. Retention does not touch
 * it (only screenshots are deleted), so a year later the same input gives the
 * same answer.
 *
 * Careful: **not `daily_summary`**, for the reason above. **Not
 * `activity_segments` either**: the same signal, but two or three orders of
 * magnitude more rows, and `groupBy` makes Postgres scan the whole index.
 *
 * Careful: **not `devices.enrolled_at` either**; measured in the field and
 * rejected: it is the **last enrollment**, not the first, so reinstalling the
 * agent moves the date forward. Proof: OX-07's device has id **1** (created
 * first) yet enrolled on 15 August, while ids 2-6 enrolled on 13 August.
 *
 * ## Careful: what a missing employee means; the caller must decide
 *
 * Someone with no session at all is **not put in the Map**. In `maxDate()` in
 * `summary.math.ts`, `null` means *"this bound does not exist"*; it never
 * wins, so the window would open across the whole month and **expectation
 * would be higher than today's**.
 *
 * So when passing to `elapsedWindow()` the caller writes **`?? today`**: empty
 * window, expectation 0, *"we have not started watching them yet"*.
 * The exception is `TrendStaff.trackedFrom` in `dashboard`, where `null` means
 * the **opposite** (never watched => expectation 0); there it stays `?? null`.
 */
export async function trackedFromBy(
  prisma: PrismaService,
  employeeIds: readonly number[],
): Promise<Map<number, Date>> {
  if (employeeIds.length === 0) return new Map();

  /**
   * Careful: **not filtered by month**, deliberately. The question is not
   * *"is there data this month"* but *"since when have we been watching
   * them"*. Filtering would restart tracking on the 1st of every month and
   * expectation would be wrongly cut forever.
   */
  const rows = await prisma.workSession.groupBy({
    by: ['employeeId'],
    where: { employeeId: { in: [...employeeIds] } },
    _min: { workDate: true },
  });

  const out = new Map<number, Date>();
  for (const r of rows) {
    if (r._min.workDate !== null) out.set(r.employeeId, r._min.workDate);
  }
  return out;
}
