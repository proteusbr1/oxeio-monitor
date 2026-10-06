/**
 * **B05b** - the pure part of the tray's "ahead / behind" number (§ 2.1-b).
 *
 * Kept in its own file because `ProgressService` runs on every heartbeat:
 * 15 PCs x every 30 seconds = about 21,600 times a day. A wrong formula would
 * show on every tray all day, and the only way to catch it would be to fill the
 * DB with heartbeats. Here it can be tested without the DB.
 *
 * **The formula no longer lives in this file**; it is `proratedExpectedSec()`
 * in `summary.math.ts`. The same math used to be hand-written here, and that
 * was the real risk: if the monthly rollup formula changed, the tray would
 * quietly keep giving the old answer, and the number staff saw on their tray
 * would differ from what the owner saw on the dashboard. This file now adds
 * only the **heartbeat safety** (see the note below), not the math.
 */

import { proratedExpectedSec } from '../summary/summary.math';

const SEC_PER_HOUR = 3600;

export interface PaceInput {
  /** worked + the owner's adjustments (§ 2.1-e); a negative value counts as 0. */
  creditedSec: number;
  /** From the work policy, not hardcoded 208 (after G37, **their prorated** target). */
  monthlyTargetHours: number;
  /** Workdays in the whole month for **them** (excluding weekly off days and `holidays`). */
  expectedWorkdays: number;
  /**
   * How many workdays have **already finished**; must come from
   * `elapsedWorkdays()` in `summary.math.ts`.
   *
   * Careful: it is **not** "from the 1st of the month **through today**". That
   * is what this used to say, and `ProgressService` really counted that way,
   * which had two bugs:
   *   1. Today was counted as expected, so the tray showed "behind" in the
   *      morning and fixed itself by evening.
   *   2. Days before tracking began were counted too, so unseen days from
   *      before the agent was installed became the employee's deficit.
   * As a result the tray and the Monthly page differed by about 89 hours.
   */
  workdaysElapsed: number;
  /**
   * R2 - the workdays they have approved leave for in that month.
   *
   * Careful: the tray needs this too. Otherwise someone back from leave would
   * see "behind" on the tray and "on track" on the Live Board, and the tray is
   * the screen they look at all day.
   */
  leaveWorkdays?: number;
}

/**
 * How many seconds should have been worked up to today.
 *
 * Careful: `rollupMonth()` in `summary.math.ts` is deliberately not called,
 * although the expected-seconds formula is the same. It throws a `RangeError`
 * when `targetSec <= 0`. That is right for the monthly rollup (failing loudly is
 * good), but on the heartbeat path a misconfigured work policy would turn
 * **every** heartbeat of that employee into a 500, so one bad number would stop
 * all tracking. So only the number itself (`proratedExpectedSec`) is used,
 * which does not throw.
 */
export function expectedSecOf(input: PaceInput): number {
  return proratedExpectedSec({
    targetSec: input.monthlyTargetHours * SEC_PER_HOUR,
    expectedWorkdays: input.expectedWorkdays,
    leaveWorkdays: input.leaveWorkdays,
    workdaysElapsed: input.workdaysElapsed,
  });
}

/**
 * `credited - expected`; positive = ahead, negative = behind.
 *
 * Careful: `credited` is clamped at 0, for the same reason as in
 * `payroll.math.ts`. If one person's large deduction made `credited` negative,
 * the tray would show "-312 hours behind", which means nothing to anyone.
 */
export function paceSecOf(input: PaceInput): number {
  return Math.max(0, input.creditedSec) - expectedSecOf(input);
}
