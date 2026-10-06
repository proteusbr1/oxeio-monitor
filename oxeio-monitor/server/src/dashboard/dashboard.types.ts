import type { SegmentState } from '@prisma/client';

import type { AgentPresence, LiveStatus, TeamHour } from './dashboard.math';

/**
 * The shapes the live board, the timeline and the charts answer with.
 *
 * Kept apart from the services so the controllers, the services and the tests
 * all read one definition.
 */

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
