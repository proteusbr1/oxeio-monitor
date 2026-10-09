import { api } from './client';

/**
 * The employee's own data (J04, J05, J08).
 *
 * Important: there is no `employeeId` parameter here, and that is the core
 * design. The server takes the id from the session, not the path, so the web
 * app has no way to ask for a colleague's data. Never add an id to `/me/...`
 * in any other file.
 *
 * The types were written by reading `server/src/me/me.service.ts`, not guessed.
 */

/** The server's `EmployeeProgress`; the agent's tray gets exactly these numbers too. */
export interface MyProgress {
  todayActiveSec: number;
  monthActiveSec: number;
  /**
   * Counted hours for the month: `monthActiveSec` plus corrections.
   *
   * Do not confuse it with `monthActiveSec`: the tile shows "worked" (as the
   * agent's tray does), while the list total below shows "credited". They answer
   * two different questions.
   */
  monthCreditedSec: number;
  monthlyTargetHours: number;
  /** Positive = ahead, negative = behind (in seconds). */
  paceSec: number;
  /** Careful: 0 on a day off. Show a sentence then, not an empty bar. */
  dailyTargetSec: number;
  week7ActiveSec: number;
  week7TargetSec: number;
  /**
   * Whether any finished workday has been counted for this person yet.
   *
   * Careful: when `false`, `paceSec` is 0 and the tile used to say "Ahead 0s",
   * i.e. praise on day one with no observation behind it. Do not infer this from
   * `paceSec === 0`: someone who exactly hit the target also has 0, and what they
   * deserve to be told is completely different.
   */
  observed: boolean;
  /**
   * The work policy has no hours target. Then `monthlyTargetHours`,
   * `dailyTargetSec`, `week7TargetSec` and `paceSec` are all 0.
   *
   * Careful: a 0 daily target does not mean "day off" here. Show the hours
   * plainly, with no target, ring, bar or ahead/behind.
   */
  noTarget: boolean;
}

export interface MySummary {
  employee: {
    empCode: string;
    fullName: string;
    designation: string | null;
    joinedOn: string | null;
  };
  progress: MyProgress;
  policySignedAt: string | null;
  /** Comes from the server (Settings → Privacy); hand-written text would lie once it changed. */
  screenshotRetentionDays: number;
  /** whether pictures of their screen are taken at all (module on and their policy takes them) */
  screenshotsTaken: boolean;
  /** whether the apps and websites they use are recorded (Apps & websites module) */
  appsTracked: boolean;
  /** whether they can open the pictures of their own screen (Settings → Privacy) */
  canSeeOwnScreenshots: boolean;
  /**
   * Tasks they **finished** today (completed in today's work day, by them) —
   * the same count the Live Board, the reports and the digest use.
   * `null` = nothing to show: no target and nothing finished.
   */
  tasks: TaskView | null;
  /**
   * What their policy counts as worked time. Under presence the page says so:
   * "Counted" and pace use presence, while the tiles stay active time.
   */
  hoursMeasure: 'active' | 'presence';
  /** presence: the longest pause, in minutes, still counted as work */
  presenceGapMin: number;
}

/**
 * Today's tasks: three states, not two (the server's `taskView`).
 *
 * | who | shown |
 * |---|---|
 * | has a target | `24 / 25` |
 * | no target, but finished some | `3` |
 * | neither | nothing (`null`) |
 */
export interface TaskView {
  done: number;
  /** Careful: `null` = this person has no task target, not a target of zero */
  target: number | null;
  /** Always `false` without a target: "not applicable", not "failed" */
  met: boolean;
}

export interface MyDay {
  workDate: string;
  workedSec: number;
  adjustmentSec: number;
  creditedSec: number;
  isOffDay: boolean;
}

export function getMySummary(signal?: AbortSignal): Promise<MySummary> {
  return api<MySummary>('/me', { signal });
}

/** Newest day first; the server sends them in that order. */
export function getMyDays(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<MyDay[]> {
  return api<MyDay[]>(
    `/me/days?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { signal },
  );
}

/**
 * The employee's own security deposit.
 *
 * Careful: money amounts arrive as strings (`"500.00"`), not numbers. The
 * server does all calculation in integer minor units, and sending a JSON number
 * could pass through floating-point decimals and be off by a cent for some amounts.
 */
export interface MyDepositMonth {
  /** '2026-08' */
  yearMonth: string;
  amount: string;
}

export interface MyDepositSettlement {
  outcome: 'refunded' | 'forfeited';
  amount: string;
  noticeGivenOn: string | null;
  lastWorkingDay: string | null;
  noticeDaysGiven: number | null;
  noticeDaysRule: number;
  note: string | null;
  settledAt: string;
  settledBy: string;
}

export interface MyDeposit {
  months: MyDepositMonth[];
  total: string;
  totalMinor: number;
  /** Once settled the ledger is closed; `total` is then history only. */
  settlement: MyDepositSettlement | null;
  /** How many days' notice is required before leaving; the screen shows the condition. */
  noticeDays: number;
}

export function getMyDeposit(signal?: AbortSignal): Promise<MyDeposit> {
  return api<MyDeposit>('/me/deposit', { signal });
}
