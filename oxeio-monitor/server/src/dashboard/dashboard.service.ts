import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SegmentState } from '@prisma/client';

import {
  localMidnightOf,
  nextLocalMidnight,
  startOfWorkDate,
  workDateOf,
} from '../agent/util/work-time';
import { REGIME_SELECT, targetSpreadOf } from '../calendar/work-regime';
import { PrismaService } from '../prisma/prisma.service';
import {
  decideLiveStatus,
  formatWorkDate,
  agentPresence,
  latestHeartbeat,
  type AgentPresence,
  monthStartOf,
  parseWorkDate,
  previousWorkDate,
  rankLaggards,
  spreadIntoHourBuckets,
  spreadTeamIntoHourBuckets,
  type DeviceReport,
  type LiveStatus,
  type TeamHour,
} from './dashboard.math';

import { isWorkday, monthBoundsOf } from '../reports/reports.range';
import { prorate } from '../summary/proration';
import { isObserved } from '../summary/summary.math';
import { taskTargetOf } from '../summary/task-start.rules';
import { trackedFromBy } from '../summary/tracking-start';

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

export interface LiveCard {
  employeeId: number;
  empCode: string;
  fullName: string;
  designation: string | null;
  /** Gets tasks handed out (Tasks module) — the task target applies to these only */
  receivesTasks: boolean;
  /**
   * **How many tasks were started today** (start detection: the task number
   * first seen in a window title). Always 0 while start detection is off.
   *
   * Careful: the number comes from `task_credits`, not `daily_summary` —
   * early in the day the summary row may not exist yet. Both come from the
   * same claim, so the numbers match.
   * Careful: it updates on the summary refresh (every 15 minutes), so it is
   * **not live** — it does not move second by second like the hours do.
   */
  tasksStarted: number;
  /** How many assigned tasks were marked **finished** today (Complete button) */
  tasksDone: number;
  /** Careful: 0 means the target is off; the screen then shows no target. Counts only while `receivesTasks`. */
  taskTargetPerDay: number;
  status: LiveStatus;
  /** Seconds counted for today's date in the work zone */
  todayWorkedSec: number;
  /**
   * One work day's target — the Live Board ring is now measured against **this**.
   *
   * Careful: 8 hours is **not** a constant, it is a computed number: monthly
   * target ÷ work days in that month. In August 2026, 208 ÷ 26 = 8 hours, but
   * in a month with 27 work days it is 7h 42m. Hardcoding 8 in the client
   * would silently show a wrong target in some months — and this exact
   * mistake was caught on the monthly page (208 vs 216).
   *
   * The definition comes from the **same function** as the report, otherwise
   * the two pages would show different targets.
   */
  dailyTargetSec: number;

  /**
   * Whether today is a work day (not a weekly off day or a public holiday).
   * Careful: showing "0 / 8 hours" on a holiday is unfair — nobody is meant to work that day.
   */
  todayIsWorkday: boolean;

  /**
   * Whether the employee is on approved leave today.
   *
   * Careful: leave already reached the numbers (their target is lower, and
   * nobody shows them as "behind"), but the card **said nothing**. So a leave
   * day looked exactly like an offline employee: grey, zero hours, no
   * heartbeat. The owner would look at the card and think the agent was off,
   * while the person was on leave.
   *
   * Careful: not merged with `todayIsWorkday`: that is the **office**
   * calendar (weekly days off, public holidays), and this is **that one person's**.
   * Merged, "how many are on leave today" could no longer be counted, and the
   * holiday message would be wrong too.
   *
   * Careful: reads the `leaves` table directly — nothing is written to a
   * column, so cancelling leave removes the badge on the next refresh without
   * waiting for the rollup.
   */
  onLeaveToday: boolean;

  /** The month's numbers — secondary now, but payroll is based on this */
  monthWorkedSec: number;
  monthTargetSec: number;
  /** their policy has no hours target (basis 'none'): hours shown, never ahead or behind */
  noTarget: boolean;
  /** Last heartbeat — null if no **active** device has responded */
  lastHeartbeatAt: Date | null;

  /**
   * Explains why `lastHeartbeatAt === null`.
   *
   * Careful: without it the screen would say "never responded", though the
   * reason may be "the device has been revoked" — the action to take is
   * completely different.
   */
  agentPresence: AgentPresence;
}

export interface LiveBoard {
  /** Today's work day in the work zone, `YYYY-MM-DD` */
  workDate: string;
  generatedAt: Date;
  cards: LiveCard[];
}

export interface TimelineSegment {
  /** Careful: BigInt as a string — see below for why */
  id: string;
  deviceId: number;
  state: SegmentState;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
}

export interface Timeline {
  employeeId: number;
  empCode: string;
  fullName: string;
  date: string;
  segments: TimelineSegment[];
  totals: { activeSec: number; idleSec: number; lockedSec: number };
}

export interface HourlyBucket {
  /** Local hour in the work zone, 0-23 */
  hour: number;
  activeSec: number;
}

/** One day of the seven-day chart (`GET /live/trend`) */
export interface TrendDay {
  /** Work day in the work zone, `YYYY-MM-DD` */
  date: string;
  /** The team's total counted seconds on that day */
  workedSec: number;
  /**
   * **Whether we were watching at all on that day.**
   *
   * Careful: the most important field of this chart. `false` does **not** mean
   * "nobody worked" — it means tracking had not started. Showing the two the
   * same would silently claim that days before the system went live had
   * "zero work", and make the whole team look like failures in the first week.
   *
   * This is another form of an older rule of this app: `offline` (employee has
   * gone) and `agent_down` (agent died) are never shown in one colour.
   * Calling "don't know" by the name "none" is forbidden here in the same way.
   */
  tracked: boolean;
  /**
   * **How many tasks were finished on that day.**
   *
   * Careful: **"finished", not "started"** (ADR-037). `task_credits` says how
   * many were brought to the screen, which cannot tell the one who does the
   * work from the one who looks at it. So only `tasks.completed_at` is used here.
   *
   * Careful: the day boundary is **the work zone's**, not UTC's — `completed_at` is a
   * timestamptz and that table has no `work_date` column, so it is bucketed
   * with `workDateOf()`. The same function that decides "which day" for the
   * whole system.
   */
  tasksDone: number;

  /** How many people really had a target that day — zero means everyone was off */
  expectedStaff: number;
  /** The team's total expected seconds that day — the chart's target line */
  targetSec: number;
}

/** The current month's card (`GET /live/trend`) */
export interface TrendMonth {
  /** `2026-08` */
  yearMonth: string;
  /** worked + the owner's corrections — this is what is compared with the target */
  creditedSec: number;
  targetSec: number;
  /**
   * Careful: expected **from the day tracking started**, not from the 1st of
   * the month.
   *
   * Careful: using the raw `monthly_summary.expected_sec` would make August's
   * card say *"team is 1042 hours behind"* — the number true, the story false.
   * All of that gap was 1-12 August, when monitoring did not exist. The whole
   * team would be unfairly shown as failing in the first month, and anyone
   * could demand accountability using that number.
   */
  expectedSec: number;
  /** credited − expected · positive = ahead */
  paceSec: number;
  /**
   * Since when we have been watching — shown **on the card**, otherwise the
   * adjustment above would be an invisible assumption.
   */
  trackedFrom: string | null;

  /**
   * **How many people the total really covers.**
   *
   * Careful: `expectedSec` above is the sum of `monthly_summary.expected_sec`.
   * Someone with not a single finished work day observed yet has 0 in that
   * field, so their **whole target is silently left out** of the sum — the
   * further behind the team is, the **less** the board shows, and the error
   * always leans one way: everything looks better than it is. It happens
   * exactly when someone new joins or someone's agent is installed late, and
   * that is when nobody notices.
   *
   * The number is not dropped — it is **disclosed**. The sum stays honest
   * ("for those who have figures"), and the card says beside it how many are
   * outside it. Adding their targets would make the board claim a shortfall
   * nobody caused — fixing one falsehood with the opposite falsehood.
   */
  observedStaff: number;
  /** Careful: when 0 nothing is written on screen — otherwise a meaningless line every day */
  notObservedStaff: number;
}

/** **All-time** most hours */
export interface TrendLeader {
  employeeId: number;
  fullName: string;
  /** **All months combined** worked + corrections — not the current month's */
  creditedSec: number;
}

/**
 * **Over how many days "the fewest" is measured.**
 *
 * Careful: **7, not 30 — for two reasons.** One: the owner's question was
 * about the last few days, i.e. the present state, not history. Two: in a
 * 30-day window one bad week would be averaged away and the list would react
 * very late — yet the whole job of this list is to be **noticed in time**.
 *
 * The number also goes to the screen (`laggardDays`), not hardcoded —
 * otherwise one day it would change and the card text would keep saying the
 * old thing.
 */
export const LAGGARD_DAYS = 7;

/**
 * **Who has the fewest hours** *(owner's request)* — in the board's right
 * column.
 *
 * Careful: **without `daysCounted` this row would lie, and that is the whole
 * reason for the field.** Anyone reading "4 hours" would assume the person
 * did not work — yet they may have been on leave, or just joined. With "2 of
 * 7 days" beside it, the number can no longer be read two ways (the same rule
 * as `sub` of `Stat`: ../../../web/src/pages/settings/ui.tsx).
 *
 * Careful: employees with zero hours stay in the list — a `creditedSec > 0`
 * filter would drop someone who came **not one day**, though the question is
 * exactly about them.
 */
export interface TrendLaggard {
  employeeId: number;
  fullName: string;
  /** Total inside the window — worked + corrections */
  creditedSec: number;
  /** Careful: days on which anything was counted — so absence is not hidden behind the number */
  daysCounted: number;
}

export interface TeamTrend {
  /** Always 7, including today — oldest first */
  days: TrendDay[];
  month: TrendMonth;
  /**
   * **All-time** most hours, from the top — at most five people.
   *
   * Careful: the measure is **total hours over all months**, the owner's
   * choice. So whoever joined earlier stays on top **permanently** — however
   * well a newcomer does, they cannot catch up. A monthly measure at least
   * restarted the order each month; all-time does not. It was chosen knowing that.
   *
   * So the card shows the **actual hours** beside each name — what the order
   * stands on is visible on screen.
   *
   * Careful: **active** employees only — someone who left sitting at the top
   * with a year of accumulated hours would be misleading.
   */
  leaders: TrendLeader[];
  /**
   * **Ranking over the last 30 days — the default on the board.**
   *
   * Careful: the all-time list above has a structural unfairness that never
   * heals: hours only accumulate, never fall — so **whoever joined earlier
   * stays on top permanently**. The list then says "who has been here
   * longer", not "who is doing well". A 30-day window puts everyone on the
   * same scale, and a newcomer can rise too.
   *
   * Careful: counted from `daily_summary`, not `monthly_summary` — the window
   * crosses the month boundary (on the 15th, half of it is last month).
   *
   * Both lists are sent, not one — the owner had picked the all-time one
   * earlier, and the new window was added without taking that choice away.
   */
  leaders30: TrendLeader[];
  /**
   * **Fewest hours, from the bottom** — at most five people.
   *
   * Careful: the window is **7 days**, not 30 — for two reasons. One: the
   * question was about the last few days, i.e. the present state, not
   * history. Two: in a 30-day window one bad week would be averaged away and
   * the list would react late — a list whose whole job is to be noticed in time.
   *
   * Careful: unlike `leaders30`, there is **no** `creditedSec > 0` filter:
   * here zero is the most important row.
   */
  laggards: TrendLaggard[];
  /**
   * How many days the list above covers — so the on-screen text can never
   * differ from the server's number.
   */
  laggardDays: number;
}

/** The live board's rhythm-of-the-day chart (`GET /live/pulse`) */
export interface TeamPulse {
  /** Work day in the work zone, `YYYY-MM-DD` */
  date: string;
  /** Always 24 — an empty hour still has `activeSec: 0, people: 0` */
  hours: TeamHour[];
  totalActiveSec: number;
  /** The most people at once in the day — the chart's y-axis limit */
  peakPeople: number;
}

export interface HourlyChart {
  employeeId: number;
  date: string;
  buckets: HourlyBucket[];
  totalActiveSec: number;
}

/**
 * Live board, timeline and the hourly chart.
 *
 * Careful: no calculation is written here — status, buckets and dates all
 * live in `dashboard.math.ts`. This class only fetches and arranges data.
 */
@Injectable()
export class DashboardService {
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

    const [devices, todaySums, startedToday, finishedToday, monthSums, recentSegments] =
      await Promise.all([
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

  /** All segments of that work day, in time order */
  async timeline(employeeId: number, rawDate?: string): Promise<Timeline> {
    const workDate = this.resolveWorkDate(rawDate);
    const employee = await this.requireEmployee(employeeId);

    const rows = await this.prisma.activitySegment.findMany({
      where: { employeeId, workDate },
      select: {
        id: true,
        deviceId: true,
        state: true,
        startedAt: true,
        endedAt: true,
        durationSec: true,
      },
      orderBy: { startedAt: 'asc' },
    });

    const totals = { activeSec: 0, idleSec: 0, lockedSec: 0 };
    for (const r of rows) {
      if (r.state === 'active') totals.activeSec += r.durationSec;
      else if (r.state === 'idle') totals.idleSec += r.durationSec;
      else totals.lockedSec += r.durationSec;
    }

    return {
      employeeId,
      empCode: employee.empCode,
      fullName: employee.fullName,
      date: formatWorkDate(workDate),
      // Careful: `id` is a BigInt — BigInt JSON serialisation is not set up in
      // app.setup.ts, so returning it directly would throw "Do not know how to
      // serialize a BigInt" while building the response, giving a 500.
      // A string is safe anyway — a JS number silently loses precision above
      // about 9,007 trillion.
      segments: rows.map((r) => ({ ...r, id: r.id.toString() })),
      totals,
    };
  }

  /** 24 buckets, each holding active seconds */
  async hourly(employeeId: number, rawDate?: string): Promise<HourlyChart> {
    const workDate = this.resolveWorkDate(rawDate);
    await this.requireEmployee(employeeId);

    // Careful: only `countsAsWork` — if idle or locked time entered the hourly
    // chart, the answer to "how much work in which hour" would be inflated.
    const rows = await this.prisma.activitySegment.findMany({
      where: { employeeId, workDate, countsAsWork: true },
      select: { startedAt: true, endedAt: true, durationSec: true },
      orderBy: { startedAt: 'asc' },
    });

    const buckets = spreadIntoHourBuckets(rows, workDate);

    return {
      employeeId,
      date: formatWorkDate(workDate),
      buckets: buckets.map((activeSec, hour) => ({ hour, activeSec })),
      totalActiveSec: buckets.reduce((a, b) => a + b, 0),
    };
  }

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
    const today = this.resolveWorkDate();
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

  /**
   * **The team's rhythm for the day**, for the live board's chart.
   *
   * Careful: without this the board could not draw any time line: `/live` sends
   * only the **current** state, and `/employees/:id/hourly` covers one person.
   * To get ten people's rhythm the browser would make ten calls — on every
   * refresh, from every open tab. So the sum is done on the server, in **one** query.
   *
   * Careful: deliberately **not merged** with `/live`. The board refreshes
   * every 30 seconds, but the day's rhythm does not change that fast — fetching
   * an hour bucket every 30 seconds means fetching the same answer 120 times.
   * Kept separate, the web can call it at its own (slow) pace.
   */
  async teamPulse(rawDate?: string): Promise<TeamPulse> {
    const workDate = this.resolveWorkDate(rawDate);

    // Careful: only `countsAsWork`, as in `hourly()` — if idle or locked time
    // entered, the answer to "how much work in which hour" would be inflated.
    const rows = await this.prisma.activitySegment.findMany({
      where: { workDate, countsAsWork: true },
      select: {
        employeeId: true,
        startedAt: true,
        endedAt: true,
        durationSec: true,
      },
      orderBy: { startedAt: 'asc' },
    });

    const hours = spreadTeamIntoHourBuckets(rows, workDate);

    return {
      date: formatWorkDate(workDate),
      hours,
      totalActiveSec: hours.reduce((a, h) => a + h.activeSec, 0),
      /**
       * The most people **at once** in the day — the chart's y-axis stands on
       * this. Computing it in the client would work too, but then the axis limit
       * and the data would come from two places.
       */
      peakPeople: hours.reduce((m, h) => Math.max(m, h.people), 0),
    };
  }

  /**
   * Careful: without `date`, today in the work zone — not the server's. If the server runs
   *    in UTC, between local midnight and the zone's offset hour (6 am in a UTC+6 zone)
   *    the date of `new Date()` would show the previous day.
   */
  private resolveWorkDate(raw?: string): Date {
    if (raw === undefined) return workDateOf(new Date());

    const parsed = parseWorkDate(raw);
    if (!parsed) {
      throw new BadRequestException('date must be a valid YYYY-MM-DD date');
    }
    return parsed;
  }

  private async requireEmployee(
    employeeId: number,
  ): Promise<{ empCode: string; fullName: string }> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { empCode: true, fullName: true },
    });
    if (!employee) throw new NotFoundException('No such staff member');
    return employee;
  }
}

function sumByEmployee(
  rows: Array<{ employeeId: number; _sum: { durationSec: number | null } }>,
): Map<number, number> {
  return new Map(rows.map((r) => [r.employeeId, r._sum.durationSec ?? 0]));
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
