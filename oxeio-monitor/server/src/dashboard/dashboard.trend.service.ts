import { Injectable } from '@nestjs/common';

import { startOfWorkDate, workDateOf } from '../agent/util/work-time';
import { PrismaService } from '../prisma/prisma.service';
import { formatWorkDate, rankLaggards } from './dashboard.math';
import {
  LAGGARD_DAYS,
  type TeamTrend,
  type TrendDay,
  type TrendLaggard,
  type TrendLeader,
} from './dashboard.types';
import { resolveWorkDate } from './dashboard.work-date';

import { isWorkday } from '../reports/reports.range';
import { isObserved } from '../summary/summary.math';
import { trackedFromBy } from '../summary/tracking-start';

/**
 * Seven days and the current month for the live board (`GET /live/trend`).
 *
 * Careful: no calculation is written here — status, buckets and dates all
 * live in `dashboard.math.ts`. This class only fetches and arranges data.
 */
@Injectable()
export class DashboardTrendService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * **Seven days and the current month** (`GET /live/trend`).
   *
   * The source is `daily_summary` and `monthly_summary`, not raw segments —
   * deliberately. Those two are the basis of payroll (`worked_sec` is the
   * **UNION** of ACTIVE time, so two PCs' time is not counted twice), and the
   * `summary-refresh` job keeps them fresh **every 15 minutes**.
   *
   * Careful: so today's column can be slightly lower than the "Hours today"
   * tile above — the tile is a live **sum** that counts overlap twice (the
   * caveat lower on the board says so). The two charts are kept on the same
   * basis, because two charts side by side on different bases would leave
   * "which is true?" without an answer.
   */
  async teamTrend(): Promise<TeamTrend> {
    const today = resolveWorkDate();
    const first = new Date(today.getTime() - 6 * 86_400_000);
    const monthKey = formatWorkDate(today).slice(0, 7);

    /**
     * Careful: **the list of active employees comes first**, and it matters
     * here — not only for showing names.
     *
     *    When someone is deactivated, their `monthly_summary` and
     *    `daily_summary` rows **remain** (history is not deleted, on purpose).
     *    Without a filter, the team's target would keep including people who
     *    have left — and the "how far behind" number would stay inflated forever.
     *
     *    That is exactly what happened once: after three sample rows from the
     *    seed were deactivated, the target still showed 2272 hours, i.e. the
     *    team carried the targets of three people who did not exist.
     *
     * Careful: the Live Board cards also show only active employees, so this
     * filter **matches** the rest of the screen — otherwise two different
     * "teams" on one page.
     */
    const active = await this.prisma.employee.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        fullName: true,
        /**
         * Careful: the join/leave dates and weekly off days are fetched here
         * **anew** — the ribbon's expectation is now taken from the calendar,
         * not by counting `daily_summary` rows (see `trendDayExpectation()`
         * below). Without them there is no answer to "was that day their work day".
         */
        joinedOn: true,
        leftOn: true,
        policy: { select: { weeklyOffDays: true } },
      },
    });
    const nameOf = new Map(active.map((e) => [e.id, e.fullName]));

    // Careful: rows per employee, not grouped — the daily target and weekly
    // off days both differ per employee, so the sum is done in code.
    const [rowsAll, monthRowsAll, firstSeen, holidayRows, finishedRows] =
      await Promise.all([
      this.prisma.dailySummary.findMany({
        where: { workDate: { gte: first, lte: today } },
        select: {
          employeeId: true,
          workDate: true,
          workedSec: true,
          /**
           * Careful: `dayType` is no longer **read** here. It used to be the
           * basis of the expectation (`dayType !== 'holiday'`), and that was
           * silently wrong — see the note on `trendDayExpectation()` below.
           */
        },
      }),
      this.prisma.monthlySummary.findMany({
        where: { yearMonth: monthKey },
        select: {
          employeeId: true,
          creditedSec: true,
          targetSec: true,
          expectedWorkdays: true,
          // Expectation is no longer counted here — see the note below for why
          expectedSec: true,
          // To say whose figures the total covers
          workdaysElapsed: true,
        },
      }),
      /**
       * **Who we have been watching, and since when — per employee.**
       *
       * Careful: this used to be a team-level `findFirst`, which the ribbon's
       * expectation did not use. It does now: taking a team-level min would
       * start the window in July for an employee who joined on 1 October.
       *
       * The team-level min comes out of this too (`trackedFromMs` below) — no
       * need for two queries, and the two numbers can never differ.
       *
       * Careful: it is **not** filtered by month — same as the equivalent query
       * in `summary.service.ts`. Filtering would make tracking "start" afresh
       * on the 1st of every month.
       */
      trackedFromBy(
        this.prisma,
        active.map((e) => e.id),
      ),
      /**
       * Careful: public holidays within the ribbon's seven days. Nobody has a
       * target on a holiday, and `daily_summary` rows cannot tell us that.
       */
      this.prisma.holiday.findMany({
        where: { holidayDate: { gte: first, lte: today } },
        select: { holidayDate: true },
      }),
      /**
       * **How many tasks were finished in the ribbon's seven days.**
       *
       * Careful: raw `completed_at` values are fetched and bucketed in code, not
       * via `groupBy` — the day boundary is **the work zone's**, and doing it in SQL
       * would mean writing the time-zone rule a second time. `workDateOf()` is
       * the only place in the system that decides "which day"; a second
       * definition means two pages telling two numbers one day.
       *
       * Careful: **`first` and `today` are labels, not instants** —
       * `workDateOf()` stores the work day as **UTC midnight**, while the real
       * local midnight is **the zone's offset earlier** (6 hours for a UTC+6 zone).
       * This difference is a recurring source of bugs in this repo, so both
       * boundaries are worked out by hand (offset = `WORK_OFFSET_MS`):
       *      start = local midnight of `first`       → `first − offset`
       *      end   = local midnight after `today`    → `today + 24h − offset`
       *    Careful: get it wrong and the window slides **late by the offset**: work
       *    from local midnight to the offset hour (6 am in a UTC+6 zone) on the
       *    ribbon's first day would be lost, and the same hours of tomorrow
       *    would come in instead — a slot
       *    the ribbon does not have, so it would be silently dropped. Someone
       *    working early in the morning would show less on the first day, with
       *    no error raised.
       */
      this.prisma.task.findMany({
        where: {
          completedAt: {
            gte: startOfWorkDate(first),
            lt: startOfWorkDate(new Date(today.getTime() + 86_400_000)),
          },
        },
        select: { completedAt: true },
      }),
    ]);

    const rows = rowsAll.filter((r) => nameOf.has(r.employeeId));
    const monthRows = monthRowsAll.filter((m) => nameOf.has(m.employeeId));
    const holidays = new Set(holidayRows.map((h) => h.holidayDate.getTime()));

    /**
     * **Since when we have been watching** — the oldest `daily_summary` row.
     * Careful: days before this must not be shown as zero; they are "unknown".
     *
     * Careful: this is a **team-level** question — the ribbon's `days[].tracked`
     * and the "watching since" label both speak for the whole board. The
     * per-employee limit is different and goes into `TrendStaff.trackedFrom`
     * below.
     *
     * Careful: it searches among active employees only — as do all other
     * numbers on the board, and an old row of someone who left would push the
     * ribbon back for no reason.
     */
    // The helper already returns a Map — nothing to join
    const trackedFromMs = [...firstSeen.values()].reduce<number | null>(
      (min, d) => {
        const ms = d.getTime();
        return min === null || ms < min ? ms : min;
      },
      null,
    );

    /**
     * One **work day's** target per employee = monthly ÷ their work days.
     * Careful: 8 hours is not a constant (see the note on `LiveCard.dailyTargetSec`)
     * — it differs by month and by employee, so it has to be calculated.
     */
    const dailyTargetOf = new Map<number, number>();
    for (const m of monthRows) {
      dailyTargetOf.set(
        m.employeeId,
        m.expectedWorkdays > 0 ? m.targetSec / m.expectedWorkdays : 0,
      );
    }

    /**
     * Careful: an employee with no `monthly_summary` row for the current month
     * is **left out** of the expectation — no `?? 0` is assumed. With 0 they
     * would count in `expectedStaff` while the team's target line silently
     * dropped, so the team would look better than it is. In practice this is
     * nearly impossible — `refreshDate()` writes the daily and monthly rows
     * together, so no monthly row means no daily row either, and `trackedFrom`
     * is empty anyway.
     */
    const staff: TrendStaff[] = active
      .filter((e) => dailyTargetOf.has(e.id))
      .map((e) => ({
        employeeId: e.id,
        weeklyOffDays: e.policy?.weeklyOffDays ?? [],
        joinedOn: e.joinedOn,
        leftOn: e.leftOn,
        /**
         * Careful: this stays `?? null` — unlike the other three call sites.
         *
         * In this field `null` already means **"never observed ⇒ expectation
         * 0"**, which is what we want. Substituting `today` would turn it into
         * "watching since today" and flip the meaning.
         */
        trackedFrom: firstSeen.get(e.id) ?? null,
        dailyTargetSec: dailyTargetOf.get(e.id) ?? 0,
      }));

    /**
     * Buckets by work day — done once, the loop below only reads.
     * Careful: `completedAt` can be `null` (`DateTime?`) even though the query
     * filters for it; TypeScript has to be told, and dropping `null` is
     * right — an unfinished target is not "finished today".
     */
    const finishedByDay = new Map<number, number>();
    for (const d of finishedRows) {
      if (d.completedAt === null) continue;
      const key = workDateOf(d.completedAt).getTime();
      finishedByDay.set(key, (finishedByDay.get(key) ?? 0) + 1);
    }

    const days: TrendDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(first.getTime() + i * 86_400_000);
      const ms = date.getTime();

      let workedSec = 0;
      for (const r of rows) {
        if (r.workDate.getTime() === ms) workedSec += r.workedSec;
      }

      const expectation = trendDayExpectation(date, staff, holidays);

      days.push({
        date: formatWorkDate(date),
        workedSec,
        tasksDone: finishedByDay.get(ms) ?? 0,
        // Careful: the criterion is **whether the date is after tracking began**,
        // not whether a row exists. Otherwise an empty future day would also
        // become "not observed".
        tracked: trackedFromMs !== null && ms >= trackedFromMs,
        expectedStaff: expectation.expectedStaff,
        targetSec: Math.round(expectation.targetSec),
      });
    }

    /**
     * **The expectation is taken from `monthly_summary.expected_sec` — it is
     *    no longer counted here.**
     *
     * Careful: this used to be its own calculation, wrong in two ways:
     *
     *    1. **It counted `daily_summary` rows** (`day_type !== 'holiday'`).
     *       But if someone works an hour on a holiday, `dayTypeOf()` writes the
     *       day as `worked` — so that holiday became the **expectation** of a
     *       full work day. A penalty for working on a holiday.
     *    2. Tracking start was taken **at team level**, while the question is
     *       per employee. A new employee's first few unobserved days became
     *       their shortfall.
     *
     *    Most of all: this was the **third** implementation of the expectation,
     *    so the Live Board, the Monthly page and the tray told three numbers.
     *
     * Now the number is produced once (`summary.service.ts` →
     *    `elapsedWorkdays()` → `proratedExpectedSec()`, every 15 minutes), and
     *    everyone reads that. `creditedSec`/`targetSec` above come from the same
     *    row, so even when the rollup lags, the board's three numbers at least
     *    **agree with each other** — before, one was fresh and two were stale.
     *
     * Careful: **the ribbon above carried the same two mistakes 40 lines
     *    away**, and this note condemned them while walking past. The ribbon now
     *    also uses `trendDayExpectation()`: the same definition of a work day
     *    (calendar, not rows), the same per-employee tracking start, the same
     *    join/leave limits.
     *
     * Careful: **two differences remain, both deliberate, both documented** —
     *    the last describe in `test/trend-expectation.spec.ts` guards them. The
     *    main one is **today**: this `expectedSec` is "how much should have been
     *    done so far" (today is excluded since it is not over), while the
     *    ribbon's `targetSec` answers another question — "what was **that
     *    day's** target"; today has a target too, the day is just still running.
     *    Careful: today's target could not be zeroed: `WeekAndMonth.tsx` still
     *    writes "day off" when `expectedStaff === 0`, so zeroing it would make
     *    the board claim everyone is off today — a direct lie while fixing a
     *    bug. The second is in the note on `TrendStaff.trackedFrom`.
     */
    const expectedSec = monthRows.reduce((a, m) => a + m.expectedSec, 0);
    const creditedSec = monthRows.reduce((a, m) => a + m.creditedSec, 0);

    /**
     * The rule is not written here, it is in `isObserved()`. The tray calls
     * exactly that too, so the board and the tray can never count differently.
     */
    const observedStaff = monthRows.filter(isObserved).length;

    /**
     * Careful: **all months combined**, with no `yearMonth` filter — the
     *    `monthRows` above are for the current month and could not build the
     *    all-time ranking.
     *
     * The sum is done in the database (`groupBy`), not in code — both
     *    employees and months keep growing, so pulling every row and adding in
     *    code would get heavier over time.
     */
    /**
     * **The last 30 days — and this is the default.**
     *
     * Careful: the all-time ranking has a structural unfairness that never
     *    heals: **whoever joined earlier stays on top permanently**, because
     *    hours only accumulate, never fall. However well a newcomer does, they
     *    need six months to catch someone six months older — so the list says
     *    "who has been here longer", not "who is doing well". A 30-day window
     *    puts everyone on the same scale.
     *
     * Careful: from `daily_summary`, not `monthly_summary` — monthly rows cover
     *    the whole month, so "the last 30 days" crossing a month boundary
     *    could not be counted from them (on the 15th, half the window is last
     *    month).
     *
     * 30 **calendar** days, not 30 work days — to keep the window the same
     *    length for everyone. With work days, someone with a different weekly
     *    off day would have a window starting on another date, and the
     *    comparison itself would be uneven.
     */
    // Careful: 29, not 30 — 30 days **including** today. Subtracting 30 would make 31 days.
    const since = new Date(today.getTime() - 29 * 24 * 3600_000);
    /**
     * Careful: subtract 6, not 7 — seven days **including** today (same logic as above).
     */
    const since7 = new Date(today.getTime() - (LAGGARD_DAYS - 1) * 24 * 3600_000);
    const [lifetime, recent, worked7] = await Promise.all([
      this.prisma.monthlySummary.groupBy({
        by: ['employeeId'],
        _sum: { creditedSec: true },
      }),
      this.prisma.dailySummary.groupBy({
        by: ['employeeId'],
        where: { workDate: { gte: since, lte: today } },
        _sum: { creditedSec: true },
      }),
      /**
       * Careful: the `creditedSec: { gt: 0 }` filter is **for the count**, not
       * the sum — a zero-second row would add nothing to the sum, but would
       * count as a "day" in `_count`. Then someone on leave would show
       * "worked 7 days of 7, only 0 hours" — exactly the opposite message.
       */
      this.prisma.dailySummary.groupBy({
        by: ['employeeId'],
        where: {
          workDate: { gte: since7, lte: today },
          creditedSec: { gt: 0 },
        },
        _sum: { creditedSec: true },
        _count: { _all: true },
      }),
    ]);

    /** Careful: the same filter and order in both — otherwise toggling would change the rule */
    const rank = (
      rows: { employeeId: number; _sum: { creditedSec: number | null } }[],
    ): TrendLeader[] =>
      rows
        .map((row) => ({
          employeeId: row.employeeId,
          fullName: nameOf.get(row.employeeId) ?? '',
          creditedSec: row._sum.creditedSec ?? 0,
        }))
        .filter((l) => nameOf.has(l.employeeId) && l.creditedSec > 0)
        .sort((a, b) => b.creditedSec - a.creditedSec)
        .slice(0, 5);

    const leaders = rank(lifetime);
    const leaders30 = rank(recent);

    /**
     * The ordering rule lives in `dashboard.math.ts`, a pure function — because
     * when wrong it raises no error, it just shows the wrong five names. Here
     * we only reshape the query result into the rule's shape.
     */
    const by7 = new Map(
      worked7.map((r) => [
        r.employeeId,
        { creditedSec: r._sum.creditedSec ?? 0, daysCounted: r._count._all },
      ]),
    );
    const laggards: TrendLaggard[] = rankLaggards(nameOf, by7);

    return {
      days,
      leaders,
      leaders30,
      laggards,
      laggardDays: LAGGARD_DAYS,
      month: {
        yearMonth: monthKey,
        creditedSec,
        targetSec: monthRows.reduce((a, m) => a + m.targetSec, 0),
        expectedSec,
        paceSec: creditedSec - expectedSec,
        observedStaff,
        notObservedStaff: monthRows.length - observedStaff,
        trackedFrom: trackedFromMs
          ? formatWorkDate(new Date(trackedFromMs))
          : null,
      },
    };
  }
}

// ── Expectation for the seven-day ribbon ────────────────────────────────────

/**
 * Everything one employee needs for counting one day's expectation on the ribbon.
 *
 * These two functions belong by nature to `dashboard.math.ts`, not this file —
 * but that file is outside the scope of this piece of work (someone else is
 * working there in parallel). So for now they sit here at **module level**,
 * outside the class; moving them is a cut-paste plus changing the import in
 * `test/trend-expectation.spec.ts`.
 */
export interface TrendStaff {
  employeeId: number;
  /** ISO weekday (Mon = 1 … Sun = 7). `null` = every calendar day is a work day. */
  weeklyOffDays: readonly number[];
  joinedOn: Date | null;
  leftOn: Date | null;
  /**
   * **Their own** oldest `daily_summary.work_date`.
   *
   * Careful: `null` = this employee has no row at all, i.e. they were never
   * observed — then no day's expectation is claimed.
   *
   * Careful: **this one place differs from `elapsedWindow()`, and it is
   * written down here.** There `trackingStartedOn: null` means "the limit is
   * unknown, so it has no effect on the window" — an employee never observed
   * still gets the full month's expectation. Here it is the opposite: not
   * observed means no expectation either.
   * The difference is **never visible on screen**, because the caller sends
   * only employees who have a `monthly_summary` row for the current month, and
   * `refreshDate()` writes daily and monthly rows together — a monthly row
   * implies a daily row, so this `null` is unreachable. The stricter of the
   * two was chosen: turning "don't know" into an expectation goes against the
   * main rule of this file (rule 2).
   */
  trackedFrom: Date | null;
  /** One work day's target (seconds) — from `monthly_summary` */
  dailyTargetSec: number;
}

/**
 * **One day's team expectation on the ribbon — the same rule the month card follows.**
 *
 * Careful: this used to **count `daily_summary` rows** (`day_type !== 'holiday'`),
 * and that was silently wrong: if someone works an hour on a holiday,
 * `dayTypeOf()` writes the day as `worked` (`summary.math.ts`), so that holiday
 * became the **expectation** of a full work day — a penalty for working on a
 * holiday. In the other direction, with no row there was no expectation, so
 * when the rollup lagged the team's target line would drop by itself.
 *
 * So the question now goes to the **calendar**, not the rows — exactly as
 * `elapsedWorkdays()` in `summary.math.ts` does. Four limits, matched with
 * `elapsedWindow()` there:
 *   1. that day is their work day (not a weekly off day, not a public holiday)
 *   2. they were employed then (`joined_on` … `left_on`)
 *   3. the day is after **their own** tracking start — an unobserved day is nobody's shortfall
 *   4. ...and the end of the window, which is **deliberately different** here
 *
 * Careful: `elapsedWindow()` excludes today, this function **does not** — and
 * that is not a mistake, it is a different question. The month card says "how
 * much should have been done so far" (today is not over, so excluded); the
 * ribbon says "what was **that day's** target" (today has a target too, the
 * day is just running). Do not zero today's expectation to make them "equal" —
 * `WeekAndMonth.tsx` writes "day off" when it sees `expectedStaff === 0`, and
 * the board would then claim everyone is off today.
 *
 * Careful: the second (and last) difference is in the note on `TrendStaff.trackedFrom` —
 * for an employee never observed, and unreachable on screen.
 */
export function trendDayExpectation(
  day: Date,
  staff: readonly TrendStaff[],
  holidays: ReadonlySet<number>,
): { expectedStaff: number; targetSec: number } {
  let expectedStaff = 0;
  let targetSec = 0;

  for (const s of staff) {
    if (!isExpectedOn(day, s, holidays)) continue;
    expectedStaff += 1;
    targetSec += s.dailyTargetSec;
  }

  // Careful: no rounding here — the caller does it once (`Math.round`). Rounding
  // each employee's share separately would stop the team's sum from landing on
  // the monthly target; the note on `dailyTargetSec()` in `reports.range.ts` says the same.
  return { expectedStaff, targetSec };
}

/** One employee, one day — three of the four limits above (the fourth depends on the caller) */
function isExpectedOn(
  day: Date,
  s: TrendStaff,
  holidays: ReadonlySet<number>,
): boolean {
  const ms = day.getTime();

  // Tracking start is checked first, because `null` means "don't know" — and then
  // there is no point knowing the answers to the other questions
  if (s.trackedFrom === null || ms < s.trackedFrom.getTime()) return false;
  if (s.joinedOn !== null && ms < s.joinedOn.getTime()) return false;
  if (s.leftOn !== null && ms > s.leftOn.getTime()) return false;

  return isWorkday(day, { weeklyOffDays: s.weeklyOffDays, holidays });
}
