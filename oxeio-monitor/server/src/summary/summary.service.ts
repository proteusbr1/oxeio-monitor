import { Injectable, Logger } from '@nestjs/common';
import { SegmentState, type Prisma } from '@prisma/client';

import { workDateOf } from '../agent/util/work-time';
import { PrismaService } from '../prisma/prisma.service';
import { TargetsService } from '../targets/targets.service';
import { designFirstSeenInDay, keepKnownLongIds, KNOWN_JOB_FROM } from './design.rules';
import { trackedFromBy } from './tracking-start';
import { prorate } from './proration';
import {
  elapsedWorkdays,
  observedWorkdays,
  hoursToSec,
  isWorkday,
  monthBounds,
  rollupMonth,
  summarizeDay,
  type Span,
} from './summary.math';

/** Spec default when there is no work policy (07 section 1). */
const DEFAULT_TARGET_HOURS = 208;

/**
 * Careful: 26 when there is no policy, because 208 / 26 = 8 hours, the spec's
 * daily target. If the two defaults drifted apart, the daily target would
 * silently become another number.
 */
const DEFAULT_POLICY_WORKDAYS = 26;

interface EmployeePolicy {
  id: number;
  /** The policy's monthly target (208 h). Careful: since G37 this is not `target_sec` itself. */
  targetSec: number;
  /** The policy's `expected_workdays` (26); the daily target is divided by this. */
  policyWorkdays: number;
  /** ISO weekdays (Friday = 5); null = every day is a workday. */
  weeklyOffDays: readonly number[];
  /** G37: `null` = has been there from before / still there. */
  joinedOn: Date | null;
  leftOn: Date | null;
}

/**
 * The most old days that will be counted in one tick.
 *
 * Careful: 14, so a two-week backlog is cleared in a single tick, while one
 * tick still does not exceed the 15-minute budget (counting a day takes a
 * fraction of a second).
 */
export const DIRTY_PER_TICK = 14;

/** Result of draining; read both in the log and in tests. */
export interface DrainResult {
  /** How many days were really recounted. */
  refreshed: number;
  /** Skipped because they fall in a closed month (R1); the mark is still cleared. */
  closed: number;
  /** Still left in the queue; above zero when the cap was hit. */
  pending: number;
}

export interface RefreshResult {
  workDate: Date;
  employees: number;
}

/**
 * `daily_summary` and `monthly_summary`: the only place that writes the rollup.
 *
 * K06 (every 15 minutes) and K05 (day close) both call this same code. Written
 * separately, some column would be computed differently at day close, and
 * the daytime number would silently change at midnight, a bug that takes
 * months to catch.
 *
 * Careful: this service **never touches** `activity_segments`. Raw data is
 * immutable (spec 2.1-e, rule 4); the summary can be rebuilt from zero at
 * any time, which is why it upserts rather than inserts.
 */
@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** Used to close assigned targets using the number found in a file name. */
    private readonly targets: TargetsService,
  ) {}

  /** The current work day: the entry point for K06. */
  refreshToday(now: Date = new Date()): Promise<RefreshResult> {
    return this.refreshDate(workDateOf(now), now);
  }

  /**
   * **Recounting late-arriving days.**
   *
   * Careful: **the bug this fixes:** the rollup only ran over **two** days:
   * today (K06) and yesterday (K05, **once** at 00:15). Segments for any
   * other day arriving later never reached `daily_summary`, nor the monthly
   * row and salary shortfall built from it. Measured loss in the field: **39
   * (employee, day) pairs, 17.78 hours**.
   *
   * Careful: **there is a cap per run:** counting one day means merging the
   * whole team's segments, and the job runs every 15 minutes. Without a cap,
   * a big backlog would make one tick outlast the next and `RunLock` would
   * skip them one by one. When the cap is hit, the rest come in the next
   * tick, because the mark is cleared **after counting**.
   *
   * Careful: **closed months are not touched** (R1). But the mark is still
   * **cleared**, otherwise that row would sit at the head of the queue
   * forever and cost one pointless attempt every tick.
   */
  async drainDirty(
    now: Date = new Date(),
    limit = DIRTY_PER_TICK,
  ): Promise<DrainResult> {
    const marks = await this.prisma.summaryDirty.findMany({
      // Careful: oldest first, otherwise with a backlog the oldest day
      // would wait forever.
      orderBy: { markedAt: 'asc' },
      take: limit,
      select: { workDate: true },
    });

    let refreshed = 0;
    let closed = 0;

    for (const mark of marks) {
      const { yearMonth } = monthBounds(mark.workDate);
      const shut = await this.prisma.monthClosure.findUnique({
        where: { yearMonth },
        select: { yearMonth: true },
      });

      if (shut === null) {
        await this.refreshDate(mark.workDate, now);
        refreshed += 1;
      } else {
        closed += 1;
      }

      // Careful: the mark is cleared **after counting**, so if it stops midway
      // the day comes again in the next tick.
      await this.prisma.summaryDirty.delete({
        where: { workDate: mark.workDate },
      });
    }

    const pending = await this.prisma.summaryDirty.count();
    return { refreshed, closed, pending };
  }

  /**
   * Re-sets one work day's summary, then that day's month as well.
   *
   * Careful: it runs for **every active employee**, not only those with
   * data. The cost is negligible (15 people), and in exchange a `no_activity`
   * row exists even on a day when nobody worked, so on the heatmap an empty
   * cell is never in doubt between "data did not arrive" and "no work was done".
   */
  async refreshDate(
    workDate: Date,
    now: Date = new Date(),
    /**
     * **Employees who are not active but must be counted this time.**
     *
     * Careful: **the bug this fixes:** a time adjustment for an inactive
     * employee was saved in the database and shown on screen, but the rollup
     * runs only over **active** employees, so the number never reached
     * `daily_summary`, nor payroll. No error, just a correction that changed
     * nothing.
     *
     * Careful: fixing a departed employee's **last month** is a valid task
     * (before the final dues are settled), so the path was not closed; only
     * that one person is added to this run.
     */
    also: readonly number[] = [],
  ): Promise<RefreshResult> {
    const employees = await this.activeEmployees(also);
    if (employees.length === 0) {
      return { workDate, employees: 0 };
    }

    const ids = employees.map((e) => e.id);

    const [segments, shots, adjustments, usage, holiday, designTitles] =
      await Promise.all([
      this.prisma.activitySegment.findMany({
        where: { workDate, employeeId: { in: ids } },
        select: {
          employeeId: true,
          state: true,
          startedAt: true,
          endedAt: true,
          durationSec: true,
        },
      }),
      this.prisma.screenshot.groupBy({
        by: ['employeeId'],
        // Careful: exclude rows retention has marked for deletion; what the
        // gallery cannot show should not be counted either.
        where: { workDate, employeeId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.timeAdjustment.groupBy({
        by: ['employeeId'],
        // Careful: revoked adjustments are excluded (spec 2.1-e). They are not
        // deleted, so this filter is what we rely on.
        where: { workDate, employeeId: { in: ids }, revokedAt: null },
        _sum: { deltaSec: true },
      }),
      this.prisma.appUsage.findMany({
        // R22a: only spans seen while ACTIVE (idle rows do not count).
        where: {
          workDate,
          employeeId: { in: ids },
          categoryId: { not: null },
          segmentState: SegmentState.active,
        },
        select: {
          employeeId: true,
          startedAt: true,
          endedAt: true,
          category: { select: { category: true } },
        },
      }),
      this.prisma.holiday.findUnique({ where: { holidayDate: workDate } }),
      /**
       * **Design numbers**: the title of design apps.
       *
       * Careful: the `usage` query above could not be reused: it fetches only
       * rows that have a `categoryId` and are **ACTIVE** (for productivity),
       * but design numbers exist outside those two conditions as well. If
       * Illustrator did not fall in a category, design counting would stop
       * and nobody would understand why.
       *
       * Careful: `windowTitle` is fetched here, but **stored nowhere**:
       * `designFirstSeenInDay()` returns only the leading number (the owner's condition).
       */
      this.prisma.appUsage.findMany({
        where: {
          workDate,
          employeeId: { in: ids },
          processName: { in: ['Illustrator.exe', 'Photoshop.exe'] },
        },
        /**
         * Careful: `startedAt` is fetched too (G163): the target's "work
         * started" mark is exactly this moment. It was not fetched before, so
         * the caller had to use the work-day label and everyone's "start" became 6 am.
         */
        select: {
          employeeId: true,
          processName: true,
          windowTitle: true,
          startedAt: true,
        },
      }),
    ]);

    const segmentsBy = groupBy(segments, (s) => s.employeeId);
    const shotsBy = new Map(shots.map((s) => [s.employeeId, s._count._all]));
    const adjustBy = new Map(
      adjustments.map((a) => [a.employeeId, a._sum.deltaSec ?? 0]),
    );

    const productiveBy = new Map<number, Span[]>();
    const unproductiveBy = new Map<number, Span[]>();
    for (const u of usage) {
      const bucket =
        u.category?.category === 'productive'
          ? productiveBy
          : u.category?.category === 'unproductive'
            ? unproductiveBy
            : null;
      // neutral and uncategorised both stay outside the productivity fraction
      if (bucket === null) continue;
      push(bucket, u.employeeId, u);
    }

    const holidays = new Set(holiday ? [workDate.getTime()] : []);

    const designsBy = await this.claimDesigns(designTitles, workDate);

    const ops: Prisma.PrismaPromise<unknown>[] = [];

    for (const e of employees) {
      const numbers = summarizeDay({
        segments: segmentsBy.get(e.id) ?? [],
        screenshotCount: shotsBy.get(e.id) ?? 0,
        adjustmentSec: adjustBy.get(e.id) ?? 0,
        productiveSpans: productiveBy.get(e.id) ?? [],
        unproductiveSpans: unproductiveBy.get(e.id) ?? [],
        isOffDay: !isWorkday(workDate, e.weeklyOffDays, holidays),
      });

      // Careful: not put inside `summarizeDay`; that is a pure calculation of
      // **time**, and a design count is not time. Mixing them would suddenly
      // require a database in that function's tests.
      const designsDone = designsBy.get(e.id) ?? 0;

      ops.push(
        this.prisma.dailySummary.upsert({
          where: { employeeId_workDate: { employeeId: e.id, workDate } },
          create: {
            employeeId: e.id,
            workDate,
            ...numbers,
            designsDone,
            computedAt: now,
          },
          update: { ...numbers, designsDone, computedAt: now },
        }),
      );
    }

    // One transaction: one round trip instead of 15 separate ones, and the
    // dashboard never sees "half the staff updated, the rest stale".
    await this.prisma.$transaction(ops);

    await this.refreshMonth(workDate, employees, now);

    return { workDate, employees: employees.length };
  }

  /**
   * **How many new designs today**, per employee.
   *
   * Careful: **"opened" and "new" are not the same, and the gap is big.**
   * Reopening yesterday's file today is not today's work. Measured in the
   * field, one person's 39 drops to **24**; the simple "everything seen
   * today" rule could show over 50% above the target, and someone's
   * evaluation would stand on that number.
   *
   * So each (employee, design) pair goes into `design_credits` **only once**;
   * the primary key does not allow a second insert (`skipDuplicates`). "Today's
   * number" = the rows claimed on today's date.
   *
   * Careful: **one limit of ordering needs writing down:** credit is claimed
   * in the name of *whichever day is computed first*. In normal running days
   * move forward, so that is fine, but if someone recomputes an **old** day,
   * that day's designs may already sit under a later day, and the old day
   * will show fewer. When backfilling, go **oldest to newest**.
   *
   * Careful: it never throws; the design count is an extra measure, and the
   * hours summary must not be blocked because of it.
   */
  private async claimDesigns(
    titles: readonly {
      employeeId: number;
      processName: string;
      windowTitle: string | null;
      startedAt: Date;
    }[],
    workDate: Date,
  ): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    if (titles.length === 0) return counts;

    const byEmployee = groupBy(titles, (t) => t.employeeId);

    try {
      for (const [employeeId, rows] of byEmployee) {
        // G163: along with the number, the moment it was "first seen".
        const firstSeen = designFirstSeenInDay(rows);
        if (firstSeen.size === 0) continue;

        const raw = new Set(firstSeen.keys());

        /**
         * **At seven digits or more the number must really be assigned**.
         *
         * Careful: the title rule accepts up to seven digits (job numbers
         * start at 1,000,000), but seven-digit **stock IDs** exist too:
         * `1536601_4406`, `5524618`, `9937760`. Four came in on a single day
         * in the field, and they were being counted as designs.
         *
         * Instead of guessing from digit count, **check whether it is in the
         * list**; that is the only exact way to tell.
         *
         * Careful: the query is only for the long numbers; usually 0-4 a day.
         */
        const longOnes = [...raw]
          .map((id) => Number.parseInt(id, 10))
          .filter((n) => Number.isSafeInteger(n) && n >= KNOWN_JOB_FROM);

        const known = new Set<string>();
        if (longOnes.length > 0) {
          const found = await this.prisma.designTarget.findMany({
            where: { jobNumber: { in: longOnes } },
            select: { jobNumber: true },
          });
          for (const f of found) {
            if (f.jobNumber !== null) known.add(String(f.jobNumber));
          }
        }

        const ids = keepKnownLongIds(raw, known);
        if (ids.size === 0) continue;

        await this.prisma.designCredit.createMany({
          data: [...ids].map((designId) => ({
            employeeId,
            designId,
            firstWorkDate: workDate,
          })),
          skipDuplicates: true,
        });

        /**
         * **"Work started" mark on assigned targets.**
         *
         * Careful: this used to **close** the target here, and that was
         * wrong: the number appears in a title when the file is **opened**,
         * not when it is finished. Finishing is now said by the designer.
         *
         * Careful: the same `ids` set, so the titles are not read twice.
         */
        /**
         * Careful: **the real moment, not the work-day label** (G163). `workDate`
         * used to go here, i.e. 6 am Asia/Dhaka time, and in MyTargets "Started 5
         * hours ago" appeared the moment a job was opened.
         */
        await this.targets.markStartedByJobNumbers(
          employeeId,
          new Map([...ids].map((id) => [id, firstSeen.get(id)!])),
        );
      }

      // Careful: counted **after** claiming, not before; otherwise designs seen
      // for the first time today would miss this run's count and the number would lag a day.
      const claimed = await this.prisma.designCredit.groupBy({
        by: ['employeeId'],
        where: { firstWorkDate: workDate, employeeId: { in: [...byEmployee.keys()] } },
        _count: { _all: true },
      });

      for (const row of claimed) counts.set(row.employeeId, row._count._all);
    } catch (err) {
      this.logger.warn(
        `Could not count designs for ${workDate.toISOString().slice(0, 10)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return counts;
  }

  /**
   * The rollup for the month that date falls in.
   *
   * Careful: the month comes **from `workDate`, not from `now`**. At 00:15 on
   * the 1st, day close closes the last day of the previous month; going by
   * `now` would update the row of the newly started month, and that last
   * day's hours would never be added to payroll.
   */
  private async refreshMonth(
    workDate: Date,
    employees: readonly EmployeePolicy[],
    now: Date,
  ): Promise<void> {
    const { start, end, yearMonth } = monthBounds(workDate);
    const ids = employees.map((e) => e.id);

    /**
     * **R1: a closed month is no longer recounted.** This is the one
     * effective line of the whole feature; everything else (endpoint, 409,
     * screen) is wrapping around it.
     *
     * Careful: why it is needed: the calculation below **reads the
     * `holidays` table as it is at that moment each time** and recomputes d
     * and D with `prorate()`. So if a holiday date moved, last month's
     * `target_sec`, `expected_sec`, `expected_workdays` and `month_workdays`
     * would all change retroactively, and payroll reads d and D from that
     * row, so **the figures would move even after salary was paid**, silently.
     *
     * Careful: it returns **not silently**; it logs, otherwise someone
     * asking "why are the numbers not updating" would never reach here.
     */
    const closed = await this.prisma.monthClosure.findUnique({
      where: { yearMonth },
      select: { closedAt: true },
    });
    if (closed) {
      this.logger.log(
        `${yearMonth} is closed (${closed.closedAt.toISOString()}) — monthly figures left untouched`,
      );
      return;
    }

    const [days, holidayRows, leaveRows, existing, firstSeen] = await Promise.all([
      this.prisma.dailySummary.findMany({
        where: { employeeId: { in: ids }, workDate: { gte: start, lte: end } },
        select: {
          employeeId: true,
          // 6 September: to know which days were really **observed**, the
          // row's date is the only source (`observedWorkdays`).
          workDate: true,
          workedSec: true,
          adjustmentSec: true,
        },
      }),
      this.prisma.holiday.findMany({
        where: { holidayDate: { gte: start, lte: end } },
        select: { holidayDate: true },
      }),
      /**
       * R2: **these employees' leave in this month**, per employee.
       *
       * Careful: **not** mixed into the same set as `holidays`. `holidays`
       * belongs to the organisation and D is counted with it; if one person's
       * leave went in, the denominator of the whole team's salary would change.
       */
      this.prisma.leave.findMany({
        where: { employeeId: { in: ids }, leaveDate: { gte: start, lte: end } },
        select: { employeeId: true, leaveDate: true },
      }),
      this.prisma.monthlySummary.findMany({
        where: { employeeId: { in: ids }, yearMonth },
        select: { employeeId: true, targetMetAt: true },
      }),
      /**
       * **Since when the server has been computing for this employee**: their
       * oldest `daily_summary` row.
       *
       * Careful: do not let the name mislead: this is **not "when the agent
       * was installed"**. The loop just below (`refreshDate()`) writes a row
       * for every active employee, with or without data, so someone's first
       * row appears on the day they become active, even if the agent has not arrived yet.
       *
       * Careful: **per employee, not organisation-wide**: this used to be a
       * single `findFirst` with no `where`, i.e. the organisation's first
       * day. That caused two mistakes:
       *   1. A later-joining employee's window started from the
       *      organisation's first day, so months from **before** they were in
       *      the system counted in their shortfall (very possible when
       *      `joined_on` is empty or loose).
       *   2. The query also read inactive employees' rows, so the data of
       *      someone who left long ago could push back the whole team's window.
       *
       * Careful: **what this does not fix:** for an employee who joined on 1
       * October and got the agent on 8 October, the 5 agentless days are still
       * a full shortfall, because their `no_activity` row is written on the
       * 1st. This used to claim that exactly this case was "fixed"; the claim
       * was false. Fixing it would mean starting the count from the first
       * **`worked`** row, which would make real early absences invisible too.
       *
       * Careful: **not filtered by month**, deliberately. The question is not
       * "does this person have data this month" but "since when have we been
       * watching them". Filtering by month would restart tracking on the 1st
       * of every month, and September's expectation would be wrongly cut just like August's.
       */
      trackedFromBy(this.prisma, ids),
    ]);

    const holidays = new Set(holidayRows.map((h) => h.holidayDate.getTime()));

    const leaveBy = new Map<number, Set<number>>();
    for (const l of leaveRows) {
      let set = leaveBy.get(l.employeeId);
      if (!set) leaveBy.set(l.employeeId, (set = new Set()));
      set.add(l.leaveDate.getTime());
    }
    const daysBy = groupBy(days, (d) => d.employeeId);
    const metAtBy = new Map(existing.map((m) => [m.employeeId, m.targetMetAt]));

    /**
     * Careful: `refreshDate()` writes today's daily row **first** and then
     * comes here, so on the very first run this will be today's date, and the
     * expectation is then 0, which is honest: not even one finished day has been observed yet.
     */
    // The helper returns the Map itself; nothing left to stitch together here.

    const today = workDateOf(now);

    const ops: Prisma.PrismaPromise<unknown>[] = [];

    for (const e of employees) {
      const rows = daysBy.get(e.id) ?? [];
      const leaveDates = leaveBy.get(e.id);

      /**
       * **G37 / ADR-025**: the target is no longer the flat 208 but **their
       * workdays x daily target**. Someone who joined on the 15th has a
       * target of 14 x 8.
       *
       * Careful: **the meaning** of the `expectedWorkdays` column changes
       * right here: from "the month's workdays" to "their workdays". D goes in
       * a separate column, because payroll needs d / D and both must be from the same period.
       */
      const p = prorate({
        monthStart: start,
        monthEnd: end,
        joinedOn: e.joinedOn,
        leftOn: e.leftOn,
        weeklyOffDays: e.weeklyOffDays,
        holidays,
        monthlyTargetSec: e.targetSec,
        policyWorkdays: e.policyWorkdays,
        leaveDates,
      });

      /**
       * Careful: `workdaysElapsed` is also counted only within their period
       * of employment. Otherwise an employee who joined on the 15th would show
       * "behind" from the start of the month, beginning on day one with an
       * 80-hour shortfall.
       *
       * All three bounds of the window (**their** tracking start, joining and
       * leaving days, and excluding today) are in `elapsedWorkdays()`; see the
       * note there for why. The tray (`progress.service.ts`), Live Board and
       * reports (F01/F02) call **this same function**, so the number cannot
       * differ across the four screens. Because the calculation is a pure
       * function, `tracking-start.spec.ts` tests every edge without a database.
       */
      const numbers = rollupMonth({
        workedSec: sum(rows.map((r) => r.workedSec)),
        adjustmentSec: sum(rows.map((r) => r.adjustmentSec)),
        targetSec: p.targetSec,
        expectedWorkdays: p.employeeWorkdays,
        monthWorkdays: p.monthWorkdays,
        /**
         * R2: leave must go in **three places together**, otherwise the
         * numbers contradict each other: in the target (`prorate`, lowers),
         * in the expectation's denominator (here, lowers), and in the
         * expectation's numerator (the second argument of `elapsedWorkdays`,
         * lowers). It **does not go into d and D**: leave is paid.
         */
        leaveWorkdays: p.leaveWorkdays,
        workdaysElapsed: elapsedWorkdays({
          periodStart: start,
          periodEnd: end,
          today,
          joinedOn: e.joinedOn,
          leftOn: e.leftOn,
          /**
           * Careful: **`?? today`, not `?? null`**; this is the real line of
           * G120. `null` means "no bound" in `maxDate()`, so for someone whose
           * agent never sent anything the window would open across the **whole
           * month**, an even bigger shortfall than before. With `today` the
           * window is empty and the expectation is 0.
           */
          trackingStartedOn: firstSeen.get(e.id) ?? today,
          weeklyOffDays: e.weeklyOffDays,
          holidays,
        }, leaveDates),
        /**
         * **How many workdays we actually observed** (the owner's decision: no
         * deduction for unobserved days).
         *
         * Careful: `workdaysElapsed` above counts **calendar** workdays, so a
         * day when the system did not run at all would still be a full 8-hour
         * expectation. Cost in the field: tracking began on 13-15 August, yet
         * the salary target was the whole month's; the deduction for 12 people
         * came to ৳79,788, of which ৳61,280 was for unobserved days.
         *
         * "Observed" means that day's `daily_summary` row was written.
         * Careful: a row that **exists with 0 hours** means absence, which
         * stays a shortfall, otherwise it would be a mistake in the other direction.
         */
        observedWorkdays: observedWorkdays(
          {
            periodStart: start,
            periodEnd: end,
            today,
            joinedOn: e.joinedOn,
            leftOn: e.leftOn,
            trackingStartedOn: firstSeen.get(e.id) ?? today,
            weeklyOffDays: e.weeklyOffDays,
            holidays,
          },
          new Set(rows.map((r) => r.workDate.getTime())),
          leaveDates,
        ),
        daysWithWork: rows.filter((r) => r.workedSec > 0).length,
      });

      /**
       * The moment the target was first reached is kept; it is not rewritten
       * every time, otherwise every 15 minutes it would become "target just met".
       *
       * Careful: if it drops below the target again (when an adjustment is
       * revoked), the time is cleared. Keeping it would make the row claim an
       * achievement that is no longer true.
       */
      const targetMetAt = numbers.targetMet
        ? (metAtBy.get(e.id) ?? now)
        : null;

      ops.push(
        this.prisma.monthlySummary.upsert({
          where: { employeeId_yearMonth: { employeeId: e.id, yearMonth } },
          create: {
            employeeId: e.id,
            yearMonth,
            ...numbers,
            targetMetAt,
            computedAt: now,
          },
          update: { ...numbers, targetMetAt, computedAt: now },
        }),
      );
    }

    await this.prisma.$transaction(ops);
  }

  /**
   * Careful: only `active` employees, like `payroll.service.ts`. A departed
   * employee's old rollup rows stay (reports need them) but are not
   * recomputed, since no more data is arriving for them.
   */
  private async activeEmployees(
    also: readonly number[] = [],
  ): Promise<EmployeePolicy[]> {
    const rows = await this.prisma.employee.findMany({
      /**
       * Careful: when `also` is empty the condition is exactly as before; the
       * second branch of the `OR` is then `id in []`, which matches nobody.
       */
      where:
        also.length === 0
          ? { status: 'active' }
          : { OR: [{ status: 'active' }, { id: { in: [...also] } }] },
      select: {
        id: true,
        joinedOn: true,
        leftOn: true,
        policy: {
          select: {
            monthlyTargetHours: true,
            weeklyOffDays: true,
            expectedWorkdays: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    });

    return rows.map((r) => ({
      id: r.id,
      targetSec: hoursToSec(
        Number(r.policy?.monthlyTargetHours ?? DEFAULT_TARGET_HOURS),
      ),
      policyWorkdays: r.policy?.expectedWorkdays ?? DEFAULT_POLICY_WORKDAYS,
      weeklyOffDays: r.policy?.weeklyOffDays ?? [],
      joinedOn: r.joinedOn,
      leftOn: r.leftOn,
    }));
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) push(map, key(row), row);
  return map;
}

function push<T>(map: Map<number, T[]>, key: number, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}
