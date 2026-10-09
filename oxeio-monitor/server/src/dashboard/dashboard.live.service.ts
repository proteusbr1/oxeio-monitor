import { Injectable } from '@nestjs/common';
import type { SegmentState } from '@prisma/client';

import {
  localMidnightOf,
  nextLocalMidnight,
  workDateOf,
} from '../agent/util/work-time';
import {
  MEASURE_SELECT,
  measureOf,
  REGIME_SELECT,
  targetSpreadOf,
} from '../calendar/work-regime';
import { PrismaService } from '../prisma/prisma.service';
import {
  decideLiveStatus,
  formatWorkDate,
  agentPresence,
  latestHeartbeat,
  monthStartOf,
  previousWorkDate,
  type DeviceReport,
} from './dashboard.math';
import type { LiveBoard, LiveCard } from './dashboard.types';

import { isWorkday, monthBoundsOf } from '../reports/reports.range';
import { prorate } from '../summary/proration';
import { presenceSpans, unionSec, type Span } from '../summary/summary.math';
import { taskTargetOf } from '../summary/task-start.rules';

/**
 * How far back to look for a segment when working out the fallback state.
 *
 * The agent sends segments in **batches**, so even with a fresh heartbeat the
 * last segment can be minutes old. 15 minutes is used because a heartbeat
 * older than 90 seconds already makes the card offline — a larger window
 * would not change the answer, only pull more rows.
 */
const LIVE_STATE_LOOKBACK_SEC = 900;

/** Used when the employee has no active device — avoids a new array per card */
const NO_DEVICES: readonly DeviceReport[] = [];

// the target when someone has no policy lives in one place: work-regime.ts › DEFAULT_SPREAD

/**
 * The live board's cards (`GET /live`).
 *
 * Careful: no calculation is written here — status, buckets and dates all
 * live in `dashboard.math.ts`. This class only fetches and arranges data.
 */
@Injectable()
export class DashboardLiveService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 15 cards, refreshed every 30 seconds.
   *
   * Careful: **no N+1.** Looping per employee to fetch devices/segments would
   * mean 15 people × (device + today + month + state) = 60+ queries, every
   * 30 seconds, from every open browser tab. So the join is done **in code**,
   * not with a query per employee — **five** queries in total, however many
   * employees there are.
   *
   * The card colour comes from `devices.last_state` — what the agent itself
   * said in the heartbeat. It used to be **guessed** from the last
   * `activity_segments` row, and since the agent sends segments in batches the
   * board lagged by minutes: green after the employee had left, grey after they
   * returned. On a board that refreshes every 30 seconds, a 3-minute-old
   * answer makes the refresh pointless. Segments are now only a fallback (see below).
   *
   * Careful: the worked seconds here are a **sum**, not a UNION — even though
   * § 2.1c says UNION. This is deliberate, and the reason weighs more than accuracy:
   *
   *    The same two numbers are shown in the agent's tray too
   *    (`src/agent/progress.service.ts`), and that uses the sum. Using UNION
   *    here would show staff one number in the tray and the manager another
   *    on the board — "which is true?" would have no answer, and a feature
   *    whose whole purpose is trust would break trust.
   *
   *    Careful: consequence — if someone runs two PCs at once, that time is
   *    counted twice. An overlap of more than 15 minutes raises a
   *    `device_overlap` alert, so it is not invisible.
   *
   *    Careful: **this argument was hollow until recently** — the alert's
   *    producer had never been written, so "not invisible" was false and double
   *    counting really was invisible. Now `alerts/device-overlap.check.ts` runs
   *    hourly, so the safeguard is real — but remember that the decision to
   *    keep the sum here rests on that alert.
   *
   *    The real fix is a daily rollup job (daily_summary.worked_sec) — when it
   *    arrives, **both places must change together**, not separately.
   *
   * Careful: that sum is **active time**. Someone whose policy counts presence
   * is drawn against the same target as the tray's pace, so their card counts
   * by the measure too: finished days from `daily_summary` (credited minus its
   * adjustment, the day's measured time) and today live, presence joined across
   * pauses — the split `progress.service.ts` uses. An all-active office keeps
   * the sums above, unchanged.
   */
  async live(now: Date = new Date()): Promise<LiveBoard> {
    const today = workDateOf(now);
    const monthStart = monthStartOf(today);
    const stateCutoff = new Date(
      now.getTime() - LIVE_STATE_LOOKBACK_SEC * 1000,
    );

    const employees = await this.prisma.employee.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        empCode: true,
        fullName: true,
        designation: true,
        receivesTasks: true,
        // Careful: `joinedOn`/`leftOn` are needed because the target is
        // **prorated** — for someone who joined mid-month, it is not the full month's.
        joinedOn: true,
        leftOn: true,
        /** The employee's own task target — the policy's applies when empty */
        dailyTaskTarget: true,
        policy: {
          // `expectedWorkdays` — the **denominator** of the daily target. Without
          // it we would have to divide by calendar work days here, and that was
          // the real cause of the gap between the tray and this card.
          select: {
            ...REGIME_SELECT,
            ...MEASURE_SELECT,
            // Tasks per day — shown next to the hours
            dailyTaskTarget: true,
          },
        },
      },
      orderBy: { empCode: 'asc' },
    });

    if (employees.length === 0) {
      return { workDate: formatWorkDate(today), generatedAt: now, cards: [] };
    }

    // The daily target needs the month's work days, and counting work days
    // needs public holidays. Without excluding holidays the quotient would be
    // too small — a lower daily target, and the month's total would not reach 208.
    const { first: monthFirst, last: monthLast } = monthBoundsOf(today);
    const holidayRows = await this.prisma.holiday.findMany({
      where: { holidayDate: { gte: monthFirst, lte: monthLast } },
      select: { holidayDate: true },
    });
    const holidays = new Set(holidayRows.map((h) => h.holidayDate.getTime()));

    const ids = employees.map((e) => e.id);

    /**
     * The card's target also excludes leave. Careful: otherwise the card of an
     * employee on leave would show the full monthly target while the Monthly
     * page shows less — exactly the kind of mismatch the `prorate()` note below
     * warns about.
     */
    const leaveRows = await this.prisma.leave.findMany({
      where: { employeeId: { in: ids }, leaveDate: { gte: monthFirst, lte: monthLast } },
      select: { employeeId: true, leaveDate: true },
    });
    const leaveBy = new Map<number, Set<number>>();
    for (const l of leaveRows) {
      let set = leaveBy.get(l.employeeId);
      if (!set) leaveBy.set(l.employeeId, (set = new Set()));
      set.add(l.leaveDate.getTime());
    }

    /**
     * Presence people need their spans and their stored days; nobody else does,
     * so an all-active office runs no extra query.
     */
    const presenceIds = employees
      .filter((e) => measureOf(e.policy).measure === 'presence')
      .map((e) => e.id);

    const [
      devices,
      todaySums,
      startedToday,
      finishedToday,
      monthSums,
      recentSegments,
      presenceToday,
      presencePastDays,
    ] = await Promise.all([
      // Careful: revoked devices are excluded — their lastSeenAt stays old
      // forever, so even an employee whose PC was replaced would show red.
      //
      // Rows, not `groupBy(_max: lastSeenAt)` — because the state is needed too,
      // and `_max(lastSeenAt)` and `_max(lastStateAt)` could come from **two
      // different devices**: SQL aggregates break the pairing of columns. A
      // switched-off desktop's stale `active` would then be paired with the
      // laptop's fresh time, and the card would stay green forever. For 15 people
      // that is 20-30 rows — still a single query, not N+1.
      this.prisma.device.findMany({
        /**
         * Careful: this used to filter `status: 'active'`. A revoked device then
         * vanished from the list, and the card could not be told apart from
         * "agent never installed" — one card showing a 16:50 screenshot with
         * *"Never checked in"* beside it.
         *
         * The filtering now happens in `dashboard.math.ts`, where the decision is
         * made and can be pinned by tests.
         */
        where: { employeeId: { in: ids } },
        select: {
          employeeId: true,
          status: true,
          lastSeenAt: true,
          lastState: true,
          lastStateAt: true,
        },
      }),
      this.prisma.activitySegment.groupBy({
        by: ['employeeId'],
        where: { employeeId: { in: ids }, countsAsWork: true, workDate: today },
        _sum: { durationSec: true },
      }),
      // Tasks started today — indexed (employee_id, first_work_date)
      this.prisma.taskCredit.groupBy({
        by: ['employeeId'],
        where: { employeeId: { in: ids }, firstWorkDate: today },
        _count: { _all: true },
      }),
      /**
       * **How many tasks were marked "finished" today.**
       *
       * Careful: the query above (`taskCredit`) says **how many were
       * started**; this one says **how many were finished**. They are not the
       * same: shown as one, a task would count as finished the moment it was
       * opened.
       *
       * Careful: `completedAt` is a timestamptz, so it is filtered by the work
       * day's **boundaries** — there is no `workDate` column to compare for equality.
       */
      this.prisma.task.groupBy({
        by: ['assignedToId'],
        where: {
          assignedToId: { in: ids },
          completedAt: {
            gte: localMidnightOf(now),
            lt: nextLocalMidnight(now),
          },
        },
        _count: { _all: true },
      }),
      this.prisma.activitySegment.groupBy({
        by: ['employeeId'],
        where: {
          employeeId: { in: ids },
          countsAsWork: true,
          workDate: { gte: monthStart, lte: today },
        },
        _sum: { durationSec: true },
      }),
      // Careful: this is now only a **fallback** (when `devices.last_state` is
      // null), yet it always runs — whether an employee needs it is not known
      // in advance, and "fetch when needed" would mean one query per employee,
      // exactly the N+1 this method was written to avoid.
      //
      // Careful: it also filters by `workDate`, only for the index —
      // the (employeeId, workDate, state) index helps only then. Yesterday must
      // be included: just after midnight there is no segment for today yet,
      // though the employee is still working (§ 2.1a — night work is normal).
      this.prisma.activitySegment.findMany({
        where: {
          employeeId: { in: ids },
          workDate: { in: [previousWorkDate(today), today] },
          endedAt: { gte: stateCutoff },
        },
        select: { employeeId: true, state: true, endedAt: true },
        orderBy: { endedAt: 'desc' },
      }),
      presenceIds.length === 0
        ? Promise.resolve([])
        : this.prisma.activitySegment.findMany({
            where: {
              employeeId: { in: presenceIds },
              countsAsWork: true,
              workDate: today,
            },
            select: { employeeId: true, startedAt: true, endedAt: true },
          }),
      // `lt: today`: today comes live from the spans above, never twice
      presenceIds.length === 0
        ? Promise.resolve([])
        : this.prisma.dailySummary.groupBy({
            by: ['employeeId'],
            where: {
              employeeId: { in: presenceIds },
              workDate: { gte: monthStart, lt: today },
            },
            _sum: { creditedSec: true, adjustmentSec: true },
          }),
    ]);

    const byEmployee = new Map<number, DeviceReport[]>();
    for (const d of devices) {
      if (d.employeeId === null) continue;
      const list = byEmployee.get(d.employeeId);
      if (list) list.push(d);
      else byEmployee.set(d.employeeId, [d]);
    }

    const todaySec = sumByEmployee(todaySums);
    const startedBy = new Map(startedToday.map((d) => [d.employeeId, d._count._all]));
    // Careful: `assignedToId` can be null (a row returned to the pool) — skip it
    const finishedBy = new Map(
      finishedToday
        .filter((d) => d.assignedToId !== null)
        .map((d) => [d.assignedToId as number, d._count._all]),
    );
    const monthSec = sumByEmployee(monthSums);

    // presence: today's stretches joined across pauses, plus the finished days
    const spansBy = new Map<number, Span[]>();
    for (const sp of presenceToday) {
      const list = spansBy.get(sp.employeeId);
      if (list) list.push(sp);
      else spansBy.set(sp.employeeId, [sp]);
    }
    const pastMeasuredBy = new Map(
      presencePastDays.map((r) => [
        r.employeeId,
        (r._sum.creditedSec ?? 0) - (r._sum.adjustmentSec ?? 0),
      ]),
    );
    for (const e of employees) {
      const { measure, presenceGapSec } = measureOf(e.policy);
      if (measure !== 'presence') continue;
      const todayPresence = unionSec(
        presenceSpans(spansBy.get(e.id) ?? [], presenceGapSec),
      );
      todaySec.set(e.id, todayPresence);
      monthSec.set(e.id, (pastMeasuredBy.get(e.id) ?? 0) + todayPresence);
    }

    // Careful: `orderBy endedAt desc` + "keep the first" — so each employee keeps
    // their most recent segment. Written in the opposite order, the oldest would
    // win and the card would never update.
    const segmentState = new Map<number, SegmentState>();
    for (const s of recentSegments) {
      if (!segmentState.has(s.employeeId))
        segmentState.set(s.employeeId, s.state);
    }

    const cards = employees.map((e): LiveCard => {
      const own = byEmployee.get(e.id) ?? NO_DEVICES;
      // per month, per week, per day or none — as seconds over workdays
      const spread = targetSpreadOf(e.policy);

      // Careful: when the policy differs, so do the weekly off days, so work
      // days are counted per employee — one number for everyone cannot be assumed.
      const rule = { weeklyOffDays: e.policy?.weeklyOffDays ?? [], holidays };

      /**
       * **The target is not recomputed here — `prorate()` is called**, the very
       * function that writes `monthly_summary.target_sec`.
       *
       * Careful: this used to have its own calculation, with **calendar work
       * days** as the denominator, while `prorate()` divides by the **policy's
       * `expected_workdays`**. So in August with 27 work days the tray said
       * 8h/day · 216h/month and this card said 7h 42m/day · 208h/month — same
       * employee, same month, two numbers. The employee took their own screen
       * as true and the owner took theirs, and nobody could tell.
       *
       * The fix is deliberately not "write the same formula in two places" but
       * **call the same function** — otherwise next time one would change and
       * the other would stay.
       */
      const target = prorate({
        monthStart: monthFirst,
        monthEnd: monthLast,
        joinedOn: e.joinedOn,
        leftOn: e.leftOn,
        weeklyOffDays: rule.weeklyOffDays,
        holidays,
        monthlyTargetSec: spread.periodTargetSec,
        policyWorkdays: spread.periodWorkdays,
        leaveDates: leaveBy.get(e.id),
      });

      return {
        employeeId: e.id,
        empCode: e.empCode,
        fullName: e.fullName,
        designation: e.designation,
        receivesTasks: e.receivesTasks,
        tasksStarted: startedBy.get(e.id) ?? 0,
        tasksDone: finishedBy.get(e.id) ?? 0,
        taskTargetPerDay: taskTargetOf(
          e.dailyTaskTarget,
          e.policy?.dailyTaskTarget,
        ),
        status: decideLiveStatus({
          devices: own,
          fallbackState: segmentState.get(e.id) ?? null,
          now,
        }),
        todayWorkedSec: todaySec.get(e.id) ?? 0,
        dailyTargetSec: Math.round(target.dailyTargetSec),
        todayIsWorkday: isWorkday(today, rule),
        // The very same `leaveBy` set that reduces the target above
        onLeaveToday: leaveBy.get(e.id)?.has(today.getTime()) ?? false,
        monthWorkedSec: monthSec.get(e.id) ?? 0,
        monthTargetSec: Math.round(target.targetSec),
        noTarget: spread.periodTargetSec === 0,
        lastHeartbeatAt: latestHeartbeat(own),
        agentPresence: agentPresence(own),
      };
    });

    return { workDate: formatWorkDate(today), generatedAt: now, cards };
  }
}

function sumByEmployee(
  rows: Array<{ employeeId: number; _sum: { durationSec: number | null } }>,
): Map<number, number> {
  return new Map(rows.map((r) => [r.employeeId, r._sum.durationSec ?? 0]));
}
