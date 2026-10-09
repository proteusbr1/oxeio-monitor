import { api } from './client';
import { qs } from './query';

/**
 * E01, E02, E04, E05: live board, day timeline, hourly chart.
 *
 * Server source: `server/src/dashboard/` (live.controller.ts,
 * employee-activity.controller.ts, dashboard.service.ts).
 *
 * Careful: all three are owner + manager only. `role = employee` gets a 403.
 */

/**
 * The three states of a card.
 *
 * Careful: `agent_down` was removed. The board could never say for certain whether
 * the agent had "died" or the PC was simply switched off: the agent writes the
 * shutdown event to disk and only sends it the next time it starts. This rule
 * broke twice in the field, and both times an honest person was shown red.
 *
 * When the agent really does break, the news arrives as an alert
 * (`AgentDownCheck`), which comes with an explanation ("no shutdown event arrived
 * either").
 */
export type LiveStatus = 'active' | 'idle' | 'offline';

/** Timeline segments do keep `locked` as a separate state. */
export type SegmentState = 'active' | 'idle' | 'locked';

export interface LiveCard {
  employeeId: number;
  empCode: string;
  fullName: string;
  designation: string | null;
  /** Whether tasks are handed to them (Staff → Receives tasks). */
  receivesTasks: boolean;
  /**
   * How many tasks were first seen started today (a window title beginning
   * with the task number — only while start detection is on). Updated on the
   * summary refresh (~15 minutes), not live like the hours.
   */
  tasksStarted: number;
  /** How many tasks they marked finished today (the Complete button). */
  tasksDone: number;
  /**
   * Their daily task target (own number, else the policy's). Careful: 0 means
   * no target; it only counts while `receivesTasks`.
   */
  taskTargetPerDay: number;
  status: LiveStatus;
  /** Seconds counted for today in the work zone, by the policy's measure (active time or presence). */
  todayWorkedSec: number;

  /**
   * One workday's target. The live board ring is now measured against this
   * (`todayWorkedSec / dailyTargetSec`), not against the monthly target.
   *
   * Careful: 8 hours is not a constant, it is a derived number: monthly target
   * divided by the month's workdays (`dashboard.service.ts`, `dailyTargetSec` in
   * `reports.range.ts`). With 208 h over 26 days that is 8 hours, but in a month
   * with 27 workdays it is 7h 42m. Hard-coding 8 on the client would silently show
   * the wrong target in some months; this exact mistake was caught on the monthly
   * page (a month target 8 hours too high). Always take the number from this field.
   *
   * It differs per employee: the weekly day off and the monthly target are tied to
   * the policy, so one number cannot be assumed for everyone on the board.
   */
  dailyTargetSec: number;

  /**
   * The person's work policy has no hours target (freelancers and the like).
   *
   * Careful: then `dailyTargetSec` and `monthTargetSec` are 0, which does **not**
   * mean a day off. Show their hours plainly, without a target, a percentage or a
   * bar against one. A real day off still comes from `todayIsWorkday` and
   * `onLeaveToday` (see `dayDuty()` in `pages/live/roster.ts`).
   */
  noTarget: boolean;

  /**
   * Whether today is a workday for this employee. Both the weekly day off and
   * public holidays make it `false`.
   *
   * Careful: showing "0h / 8h" on a day off is unfair, since they are not expected
   * to do anything that day. When `false`, "day off" is shown instead of the target
   * (`TeamRoster`).
   *
   * Careful: `/live` does not say which one it is (weekly day off or public
   * holiday), only a bool. So the card shows a neutral "Day off"; picking one
   * would use the wrong word half the time.
   *
   * Careful: this is not a block. If someone works on a day off, `todayWorkedSec`
   * is counted in full (section 2.1-b), so the hours are still shown.
   */
  todayIsWorkday: boolean;

  /**
   * G130: whether the employee is on approved leave today.
   *
   * Careful: `todayIsWorkday` above reflects the office calendar (weekly days off, public
   * holidays), not personal leave. So an employee on leave showed "0h / 8h" on the
   * card, which looks exactly like someone slacking, while the numbers (target,
   * pace) had excused them long ago.
   *
   * The rule for reading this lives in one place: `dayDuty()` in
   * `pages/live/roster.ts`.
   */
  onLeaveToday: boolean;

  /**
   * Careful: the monthly figure is now secondary (shown small below), but it is
   * the basis of pay. By the policy's measure, like `todayWorkedSec`.
   */
  monthWorkedSec: number;
  monthTargetSec: number;
  /**
   * Last heartbeat, ISO instant. `null` if no device has ever responded.
   * Careful: the server type is `Date`, but in JSON it arrives as a string.
   */
  lastHeartbeatAt: string | null;

  /**
   * Explains why `lastHeartbeatAt === null`.
   *
   * Careful: without it the card said "Never checked in", when the real reason
   * could be "the device has been deactivated". That produced a self-contradicting
   * card: a 16:50 screenshot above, "never responded" below.
   */
  agentPresence: 'never_installed' | 'switched_off' | 'installed';
}

export interface LiveBoard {
  /** Today's workday in the work zone, `YYYY-MM-DD`. */
  workDate: string;
  /** ISO instant */
  generatedAt: string;
  cards: LiveCard[];
}

export interface TimelineSegment {
  /** Careful: a string. The server uses BigInt, which a JS number cannot hold. */
  id: string;
  deviceId: number;
  state: SegmentState;
  /** ISO instant */
  startedAt: string;
  endedAt: string;
  /** From a monotonic clock; may not equal the wall-clock interval. */
  durationSec: number;
}

export interface Timeline {
  employeeId: number;
  empCode: string;
  fullName: string;
  /** `YYYY-MM-DD` */
  date: string;
  segments: TimelineSegment[];
  totals: { activeSec: number; idleSec: number; lockedSec: number };
}

/** E01: one day of the seven-day chart (`GET /live/trend`). */
export interface TrendDay {
  /** Workday in the work zone, `YYYY-MM-DD`. */
  date: string;
  workedSec: number;
  /**
   * Whether we were actually watching on that day.
   *
   * Careful: `false` does not mean "nobody worked", it means tracking had not
   * started. So the chart draws those days as dotted outlines, not filled bars.
   */
  tracked: boolean;
  /**
   * How many tasks were finished on that day.
   *
   * Careful: "finished", not "started" (ADR-037): a start only says a window
   * was opened, which cannot tell the one who does the work from the one who
   * looks at it.
   */
  tasksDone: number;

  /** How many people really had a target; zero means everyone is on leave. */
  expectedStaff: number;
  targetSec: number;
}

/** E01: the current month's card (`GET /live/trend`). */
export interface TrendMonth {
  yearMonth: string;
  creditedSec: number;
  targetSec: number;
  /** Careful: expected from the day tracking started, not from the 1st of the month. */
  expectedSec: number;
  /** credited minus expected; positive = ahead. */
  paceSec: number;
  trackedFrom: string | null;

  /**
   * G111: how many people the total covers.
   *
   * Careful: anyone with no finished workday observed yet has `expected_sec` 0, so
   * their whole target is silently left out of the total above. The board therefore
   * shows the team as less behind than it is. The number is not hidden, it is
   * stated: the card says beside it how many people are outside it.
   */
  observedStaff: number;
  /**
   * Careful: when 0, nothing is written on screen; otherwise there would be a
   * meaningless line every day.
   */
  notObservedStaff: number;
}

/** E01: the people with the most hours of all time. */
export interface TrendLeader {
  employeeId: number;
  fullName: string;
  /** Across all months, not just the current one. */
  creditedSec: number;
}

/**
 * Fewest hours: each name comes with the number of days it covers.
 *
 * Careful: without `daysCounted` the number would lie. Anyone reading "4 hours"
 * would assume the person did not work, when they may have been on leave.
 */
export interface TrendLaggard {
  employeeId: number;
  fullName: string;
  creditedSec: number;
  /** Number of days with anything counted, inside the window. */
  daysCounted: number;
}

export interface TeamTrend {
  /** Always 7, including today; oldest first. */
  days: TrendDay[];
  month: TrendMonth;
  /**
   * Top five, most all-time hours first.
   *
   * Careful: whoever joined earlier stays on top permanently and newcomers cannot
   * catch up. Each name on the card shows the real hours, so the screen itself
   * shows what the order is based on.
   */
  leaders: TrendLeader[];
  /**
   * Ranking for the last 30 days; this is the card's default.
   *
   * Careful: in the all-time list, whoever joined earlier stays on top for good
   * (hours accumulate, never fall), so it says "who has been here longest" rather
   * than "who is doing well". The 30-day window puts everyone on the same scale.
   */
  leaders30: TrendLeader[];
  /**
   * Fewest hours: the bottom five.
   *
   * Careful: staff with zero hours are included, and they are the most important
   * row, so the `creditedSec > 0` filter that `leaders` uses is absent here.
   */
  laggards: TrendLaggard[];
  /** The window, in days, that the list above covers; the text relies on the server's number. */
  laggardDays: number;
}

/** E01: one hour of the team's day rhythm (`GET /live/pulse`). */
export interface TeamHour {
  /** Local hour in the work zone, 0-23. */
  hour: number;
  /** The team's total counted seconds in that hour. */
  activeSec: number;
  /**
   * How many people did any work at all in that hour.
   *
   * Careful: not drawn on the chart. Putting two measures on one axis would make it
   * a dual-axis chart, which is the best-known lie in charting. The number is in
   * the hover, because "6 hours" could be six people for an hour or one person for
   * six hours, which are different stories.
   */
  people: number;
}

export interface TeamPulse {
  /** Workday in the work zone, `YYYY-MM-DD`. */
  date: string;
  /** Always 24 entries; empty hours are present with zero. */
  hours: TeamHour[];
  totalActiveSec: number;
  peakPeople: number;
}

export interface HourlyBucket {
  /** Local hour in the work zone, 0-23. */
  hour: number;
  activeSec: number;
}

export interface HourlyChart {
  employeeId: number;
  date: string;
  /** Always 24 entries; empty hours carry `activeSec: 0`. */
  buckets: HourlyBucket[];
  totalActiveSec: number;
}

/**
 * E01/E02: `GET /api/v1/live`
 *
 * `usePolling(getLiveBoard, 30_000, [])` refreshes every 30 seconds.
 *
 * Careful: `todayWorkedSec` and `monthWorkedSec` are sums, not a UNION, for active
 * time (a presence policy counts presence instead). If someone runs two PCs at
 * once, active time counts twice. This is intentional (the agent's
 * tray shows the same number), and an overlap over 15 minutes raises a
 * `device_overlap` alert. This endpoint returns no `caveat` field.
 */
export function getLiveBoard(signal?: AbortSignal): Promise<LiveBoard> {
  return api<LiveBoard>('/live', { signal });
}

/**
 * E01: `GET /api/v1/live/pulse`, the team's day rhythm, 24 hours.
 *
 * Careful: it does not refresh in step with the board (`/live` every 30 seconds,
 * this one slower). Fetching an hourly bucket every 30 seconds would mean
 * fetching the same answer 120 times.
 */
export function getTeamPulse(signal?: AbortSignal): Promise<TeamPulse> {
  return api<TeamPulse>('/live/pulse', { signal });
}

/**
 * E01: `GET /api/v1/live/trend`, seven days and the current month.
 *
 * Careful: called slowly, like `pulse`. Both the daily totals and the monthly
 * rollup are built by the 15-minute job (K06), so calling every 30 seconds is
 * pointless.
 */
export function getTeamTrend(signal?: AbortSignal): Promise<TeamTrend> {
  return api<TeamTrend>('/live/trend', { signal });
}

/**
 * E04: `GET /api/v1/employees/:id/timeline?date=YYYY-MM-DD`
 *
 * Careful: if `date` is omitted, the server uses today in the work zone. But when the page
 * has a date picker, send it explicitly with `todayInWorkZone()`; otherwise the date
 * the user picked and the data shown can drift apart.
 */
export function getTimeline(
  employeeId: number,
  date?: string,
  signal?: AbortSignal,
): Promise<Timeline> {
  return api<Timeline>(`/employees/${employeeId}/timeline${qs({ date })}`, {
    signal,
  });
}

/** E05 — `GET /api/v1/employees/:id/hourly?date=YYYY-MM-DD` */
export function getHourly(
  employeeId: number,
  date?: string,
  signal?: AbortSignal,
): Promise<HourlyChart> {
  return api<HourlyChart>(`/employees/${employeeId}/hourly${qs({ date })}`, {
    signal,
  });
}
