import { Injectable } from '@nestjs/common';

import { prorate } from '../summary/proration';
import {
  countLeaveWorkdays,
  countWorkdays,
  elapsedWorkdays,
  isObserved,
  unionSec,
} from '../summary/summary.math';
import { REGIME_SELECT, targetSpreadOf } from '../calendar/work-regime';
import { PrismaService } from '../prisma/prisma.service';
import { trackedFromBy } from '../summary/tracking-start';
import { paceSecOf } from './progress.math';
import { workDateOf } from './util/work-time';

/**
 * Careful: `work_date` is always the UTC midnight of a `@db.Date`, so adding or
 * subtracting days has no DST or hour trouble; it is plain arithmetic, not a
 * timezone rule.
 */
const MS_PER_DAY = 86_400_000;

export interface EmployeeProgress {
  /** Seconds counted on today's date in the work zone. */
  todayActiveSec: number;
  /** Seconds counted in the current month (work zone). */
  monthActiveSec: number;

  /**
   * **The month's credited: worked + adjustments** (G162).
   *
   * Careful, the bug this fixes: the *"This month so far"* number in the bottom
   * row of the My data page was **summed in the browser**, and for three reasons it
   * did not match the *"This month"* tile above it:
   * <ol>
   *   <li>Different window: the list is a **rolling 30 days**, so on the 31st the
   *       1st never appeared (seven days a year);</li>
   *   <li>Different quantity: the bottom one was `credited` (with adjustments), the
   *       top one `worked` (without). Any single adjustment made them differ;</li>
   *   <li>Different definition: the bottom one summed raw `duration_sec`, the top
   *       one a UNION. With work on two PCs at once, the bottom one counted it
   *       **twice**.</li>
   * </ol>
   *
   * So the number is no longer built in the browser: the screen shows exactly what
   * the server uses to compute `paceSec`. One month, one number.
   *
   * Careful: `monthActiveSec` was **deliberately not changed**: it is the agent's
   * wire contract (`AgentHost.ActiveThisMonth`), and § 2.1-e (G35) says the hours
   * shown stay in `worked`, and only pace uses `credited`. Two different questions,
   * so two different fields.
   */
  monthCreditedSec: number;
  /** From that employee's work policy, not a hardcoded 208. */
  monthlyTargetHours: number;
  /** their policy has no hours target (basis 'none'): hours only, no pace */
  noTarget: boolean;
  /**
   * **B05b** - how far ahead (+) or behind (-) up to today, in seconds.
   * `credited_sec - expected_sec` (§ 2.1-b).
   *
   * **If this is not sent, the agent guesses by itself**: it does not know the
   * `holidays` table, so it counts workdays by excluding only Fridays and labels
   * the window "pace (approx.)". In Eid week that guess would show a few hours
   * behind the dashboard's number, i.e. the holidays themselves were counted as the
   * employee's deficit. Once the server supplies the number, the agent removes
   * "approx." from the label by itself.
   *
   * Careful: `optional`: an old agent does not know the field, and a new agent also
   * falls back to its own guess on `null`. So it never breaks.
   */
  paceSec: number;

  /**
   * Today's target in seconds: monthly target / that month's workdays.
   *
   * Careful: **0 on a day off** (weekly off day or `holidays`). 0 means "nothing
   * required today", and if someone works that day it is added to the month anyway,
   * because the rule is "any day counts" (§ 4).
   *
   * There is deliberately no daily-target column in the DB: the only contract is
   * 208 hours a month (O8). This is a number for **display**, not for deductions.
   */
  dailyTargetSec: number;

  /** Seconds counted in the last 7 days (including today). */
  week7ActiveSec: number;

  /**
   * The number of workdays in those 7 days, times the daily target.
   *
   * Careful: **rolling 7 days**, not "this week"; this system has no week boundary
   * at all (§ 4: any day counts). Building "this week" would import a new notion of
   * when the week starts.
   */
  week7TargetSec: number;

  /**
   * **G111** - whether any of their **finished** workdays has been seen yet. When
   * `false`, `paceSec` above is 0, but that is not "target met"; it is "nothing
   * worth reporting has happened yet".
   *
   * Careful: without this, a new employee's first day on the tray would look
   * exactly like someone who is ahead: "0 hours behind". The agent hides the pace
   * text and shows "Not observed yet" based on this flag, not by judging
   * `paceSec === 0` itself; otherwise someone who hit the target exactly would get
   * that text too.
   *
   * Careful: an old agent does not know the field and behaves as before, so adding
   * it breaks nothing.
   */
  observed: boolean;
}

/**
 * The number for the agent's tray display "x h / 208h".
 *
 * Careful: **the agent cannot compute this itself.** It knows only its own uptime,
 * and after a reboot or an update its count restarts from zero. Staff would then
 * see "0 h / 208h" on the tray and think their month's work had been erased. A
 * feature whose whole purpose is to build trust would then break it.
 *
 * So the server supplies it, since it has all devices' data together (someone
 * using two PCs is added up too, § 2.1-c).
 *
 * It is summed from raw `activity_segments`, not `monthly_summary`: that rollup
 * is not produced yet, and summing a few thousand rows a month across 15 devices
 * directly is simpler and always current.
 */
@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService) {}

  async forEmployee(
    employeeId: number,
    now: Date = new Date(),
  ): Promise<EmployeeProgress> {
    const today = workDateOf(now);

    // First day of the month, by the work-zone calendar, not UTC.
    const monthStart = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
    );
    // Day "0" of next month = the last day of this month (leap years handled for free).
    const monthEnd = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0),
    );

    // Rolling 7 days including today, so go back 6 days.
    const week7Start = new Date(today.getTime() - 6 * MS_PER_DAY);

    /**
     * Careful: the holiday list must cover **the 7-day window too, not just the
     * start of the month.** On the 1st to 6th of a month the 7-day window reaches into
     * the previous month; fetching only this month's holidays would count last month's
     * Eid days as "workdays" and the 7-day target would look too high.
     */
    const holidayFrom = week7Start < monthStart ? week7Start : monthStart;

    const [
      todaySpans,
      monthPastRow,
      week7PastRow,
      employee,
      adjustmentRow,
      holidayRows,
      leaveRows,
      firstSeen,
    ] = await Promise.all([
        /**
         * **G112 - one definition, two sources.** The boundary is **written down** here,
         * because the easiest thing for the next person to do is to add the two together.
         *
         * ```
         * finished days  ->  daily_summary.worked_sec   (rollup, 15 minutes)
         * today          ->  UNION of activity_segments (live)
         * ```
         *
         * Careful, **why the raw sum is no longer used**: all three numbers used to be
         * `Σ duration_sec`, i.e. **the sum of the agent's monotonic clock**. But
         * `daily_summary.worked_sec` is a **wall-clock UNION** (`summarizeDay`). The two do
         * not match exactly (waking from sleep, clock corrections, small gaps). The gap is
         * biggest for an employee with **two devices**: working on two machines at once
         * counted that time **twice** in the sum and once in the UNION. So their tray
         * showed more hours than the dashboard; the `device_overlap` alert of G32 measures
         * exactly that gap.
         *
         * Careful: today **cannot** be taken from the rollup: it runs every 15 minutes, so
         * the tray number would jump in steps instead of moving with the clock, whereas
         * the tray's whole job is to show "how much now".
         *
         * Careful: so today is also a **UNION**, not a raw sum: two sources, but **one
         * definition**. With two definitions the number would jump by itself when it
         * crosses the boundary (at midnight).
         *
         * Careful: **the price paid for this is known and accepted**: from local midnight
         * to 00:15, yesterday's row is not final yet (day-close runs at 00:15,
         * `day-close.job.ts`), so in those fifteen minutes the tray may leave out the last
         * few minutes of yesterday. Summing raw segments used to be exact there. Still,
         * this is the right trade: **the error is now identical to the dashboard's**, and
         * the same number on both screens is worth more than fifteen minutes of accuracy;
         * the whole purpose of this feature is trust.
         */
        this.prisma.activitySegment.findMany({
          where: { employeeId, countsAsWork: true, workDate: today },
          select: { startedAt: true, endedAt: true },
        }),
        /**
         * Careful: `lt: today`, **not** `lte`; this one character prevents double
         * counting. With `lte`, today would come from the rollup and from the live
         * segments, so the morning's work would count twice.
         */
        this.prisma.dailySummary.aggregate({
          _sum: { workedSec: true },
          where: {
            employeeId,
            workDate: { gte: monthStart, lt: today },
          },
        }),
        this.prisma.dailySummary.aggregate({
          _sum: { workedSec: true },
          where: {
            employeeId,
            workDate: { gte: week7Start, lt: today },
          },
        }),
        this.prisma.employee.findUnique({
          where: { id: employeeId },
          select: {
            // G37 - the two ends of the employment span, so the tray target is prorated too.
            joinedOn: true,
            leftOn: true,
            // Careful: `weeklyOffDay` is a column of the **work policy**, not of the
            //    employee; the weekly off day is part of policy, not a personal attribute.
            policy: { select: REGIME_SELECT },
          },
        }),
        /**
         * Careful: read straight from `time_adjustments`, not from
         * `daily_summary.adjustment_sec`: that column is the result of the rollup that
         * runs every 15 minutes, so after the owner gave hours back, the staff member's
         * tray would keep showing "behind" until the next refresh. The whole point of an
         * adjustment would then arrive late.
         *
         * Careful: `revokedAt: null`; a revoked adjustment gives no hours back (the
         * schema has no delete, only revoke).
         */
        this.prisma.timeAdjustment.aggregate({
          _sum: { deltaSec: true },
          where: {
            employeeId,
            revokedAt: null,
            workDate: { gte: monthStart, lte: today },
          },
        }),
        this.prisma.holiday.findMany({
          where: { holidayDate: { gte: holidayFrom, lte: monthEnd } },
          select: { holidayDate: true },
        }),
        /**
         * R2 - their own leave. Careful: it is fetched from `holidayFrom` (not the 1st of
         * the month), because the seven-day target below needs it too and that window
         * can cross the month boundary.
         */
        this.prisma.leave.findMany({
          where: { employeeId, leaveDate: { gte: holidayFrom, lte: monthEnd } },
          select: { leaveDate: true },
        }),
        /**
         * **Since when the server has been computing for this employee**: their oldest
         * `daily_summary` row. The expectation window does not start before it.
         *
         * Careful: it is deliberately not filtered by month. The question is not "do they
         * have data this month" but "since when are we counting them". Filtering by month
         * would make tracking "start" afresh on the 1st of every month.
         *
         * Careful: **not** an organisation-wide min; otherwise a later-joining employee's
         * window would start from the organisation's first day, and the time before they
         * entered the system would go into their deficit.
         *
         * Careful: **this is not "when the agent was installed".** `refreshDate()` writes
         * a row for every active employee, with data or not. So for an employee activated
         * on 1 October who got an agent on 8 October, the agentless days are still a full
         * deficit. The comment here used to claim the opposite, and anyone reading that
         * false comment would think the case was covered.
         */
        trackedFromBy(this.prisma, [employeeId]),
      ]);

    /**
     * Today's live number: a **UNION**, not a raw sum (see the note above). With work
     * on two devices at once the time is counted only once, exactly as
     * `daily_summary.worked_sec` counts it.
     */
    const todayActiveSec = unionSec(todaySpans);

    // G112 - finished days from the rollup + today live.
    const monthActiveSec = (monthPastRow._sum.workedSec ?? 0) + todayActiveSec;

    // G162 - computed in one place, used in two (pace and the bottom row of My data).
    const monthCreditedSec = monthActiveSec + (adjustmentRow._sum.deltaSec ?? 0);
    const week7ActiveSec = (week7PastRow._sum.workedSec ?? 0) + todayActiveSec;
    // per month, per week, per day or none — as seconds over workdays
    // (no policy: the original 208 h over 26 days)
    const spread = targetSpreadOf(employee?.policy);

    const holidays = new Set(holidayRows.map((h) => h.holidayDate.getTime()));
    const off = employee?.policy?.weeklyOffDays ?? [];
    const leaveDates = new Set(leaveRows.map((l) => l.leaveDate.getTime()));

    /**
     * **G37 · ADR-025 - the tray's target is prorated too.**
     *
     * Careful: leaving this out would be **the worst kind of bug**: a staff member who
     * joined on the 15th would see "x / 208h" on the tray, while the dashboard and the
     * payroll sheet show "x / 112h". Two numbers in two places means one is lying, and
     * the whole purpose of this feature is trust
     * ([§ 2.1-e](../../../docs/07-Technical-Spec.md)).
     */
    const p = prorate({
      monthStart,
      monthEnd,
      joinedOn: employee?.joinedOn ?? null,
      leftOn: employee?.leftOn ?? null,
      weeklyOffDays: off,
      holidays,
      monthlyTargetSec: spread.periodTargetSec,
      policyWorkdays: spread.periodWorkdays,
      leaveDates,
    });

    const expectedWorkdays = p.employeeWorkdays;

    /**
     * **The window is not computed here; `elapsedWorkdays()` does it.**
     *
     * Careful: this used to have its own calculation: calendar workdays from
     * `max(1st of the month, joinedOn)` **through today**. That was the source of this
     * repo's biggest sin: what an employee saw on their own tray or `/me` and what the
     * owner saw on the Monthly page differed by about 89 hours. Two causes:
     *   1. **Today was counted.** At 6 am the tray showed "8 hours behind" and fixed
     *      itself by evening; the same person got two verdicts a day, purely because
     *      of the clock.
     *   2. **Days before tracking started were counted too**, so unseen days from
     *      before the agent was installed became their failure.
     */
    const workdaysElapsed = elapsedWorkdays({
      periodStart: monthStart,
      periodEnd: monthEnd,
      today,
      joinedOn: employee?.joinedOn ?? null,
      leftOn: employee?.leftOn ?? null,
      // Careful: `?? today`; an unseen employee's expectation is 0, not the whole month (G120).
      trackingStartedOn: firstSeen.get(employeeId) ?? today,
      weeklyOffDays: off,
      holidays,
    }, leaveDates);

    /**
     * The share of one workday. Careful: taken straight from the policy, not divided
     * by their own workdays; the daily target is the same 8 hours for everyone and
     * does not change with when someone joined.
     */
    const perWorkdayTargetSec = Math.round(p.dailyTargetSec);

    // Whether today is a workday; countWorkdays includes both ends, so use a one-day range.
    const todayIsWorkday = countWorkdays(today, today, off, holidays) > 0;

    return {
      todayActiveSec,
      monthActiveSec,
      monthCreditedSec,
      // G37 - what the agent shows is **their** target, not a flat 208.
      monthlyTargetHours: p.targetSec / 3600,
      noTarget: spread.periodTargetSec === 0,
      dailyTargetSec: todayIsWorkday ? perWorkdayTargetSec : 0,
      week7ActiveSec,
      /**
       * Careful: R2 - leave is excluded from the seven-day target too. Otherwise
       * someone back from leave would see "far behind this week" on the tray, while the
       * monthly number does excuse them. The two are visible together.
       */
      week7TargetSec:
        perWorkdayTargetSec *
        Math.max(
          0,
          countWorkdays(week7Start, today, off, holidays) -
            countLeaveWorkdays(leaveDates, week7Start, today, off, holidays),
        ),
      paceSec: paceSecOf({
        /**
         * Careful: `credited`, not `worked` (§ 2.1-e, G35). A staff member who lost hours
         * through a server fault would otherwise see "behind" on the tray all month even
         * after the owner's adjustment, while the dashboard showed them ahead. Two numbers
         * saying two things ends trust, and the purpose of this feature is trust.
         */
        creditedSec: monthCreditedSec,
        monthlyTargetHours: p.targetSec / 3600,
        expectedWorkdays,
        leaveWorkdays: p.leaveWorkdays,
        workdaysElapsed,
      }),
      // G111 - right next to `paceSec`, because this is the rule for **reading** that number.
      observed: isObserved({ workdaysElapsed }),
    };
  }
}
