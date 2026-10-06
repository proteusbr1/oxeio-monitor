import type { LiveCard } from '../../api/dashboard';
import { isWorking } from './onTheClock';

/**
 * **Two roster decisions**: the order, and what the meter says.
 *
 * Important: in a separate file because both are **rules**, not layout. Especially
 * the order: hours sorted in one row want to become a ranking by themselves, and
 * resisting that is a **deliberate** decision. A one-line `sort by hours` somewhere
 * must not slip in, so the rule lives here, with tests.
 */

/**
 * Which truth today's meter is telling.
 *
 * Careful: **zero and unknown are different things, and the screen must not show
 * them the same.** "Did nothing today" (measured) and "we do not know" (agent never
 * installed / never responded): showing both as the same empty bar would silently
 * turn the second into an accusation of the first.
 */
export type MeterKind = 'counted' | 'zero' | 'unknown';

export function meterKind(card: LiveCard): MeterKind {
  // Careful: unknown is checked before zero; the order matters. An employee without
  //    an agent keeps `todayWorkedSec` at 0, and with the checks reversed they would
  //    count as "zero work" when they were never measured.
  if (card.agentPresence !== 'installed' || card.lastHeartbeatAt === null) {
    return 'unknown';
  }
  return card.todayWorkedSec > 0 ? 'counted' : 'zero';
}

/**
 * Whether they have a target today, and if not, why.
 *
 * Careful: **a day off used to be invisible on the card.** `todayIsWorkday` says
 * whether the day is a workday in the **office** calendar: weekly days off and public
 * holidays. Personal leave is not in it, so the card of someone on leave showed
 * **"0h / 8h" and an empty meter**, which looks exactly like someone slacking.
 * Yet the numbers (target, expected, pace) had excused them long ago; only the
 * picture had not.
 *
 * Important: the three screens (`TeamRoster`, `TeamBars`, `TeamTable`) used to
 * write this condition **three times separately**. It is now in one place, or the
 * leave rule would land in one and not the others, this repo's best-known sin.
 *
 * Careful: `'leave'` and `'off'` are kept apart even though neither shows a meter:
 * the screen says different things ("on leave" vs "day off"). Merging them would
 * make a leave day's card say "day off", meaning **the whole office is closed**,
 * a new falsehood introduced while fixing another.
 *
 * `'none'`: a workday for someone whose policy has no hours target (`noTarget`).
 */
export type DayDuty = 'target' | 'leave' | 'off' | 'none';

export function dayDuty(card: LiveCard): DayDuty {
  /**
   * Careful: **leave is checked first, and the order is intentional.** If someone's
   * leave is entered on a weekly day off or a public holiday, the card should still say
   * "day off": nobody has a target that day, so singling them out would be
   * meaningless. Hence the condition sits **inside** `todayIsWorkday`.
   */
  if (!card.todayIsWorkday) return 'off';
  /**
   * Careful: **a person with no hours target has `dailyTargetSec` 0, but that is
   * not a day off.** `'none'` means a working day with nothing to measure against:
   * the screens show the hours plainly, with no "day off" and no bar. Leave still
   * shows as leave.
   */
  if (card.noTarget) return card.onLeaveToday ? 'leave' : 'none';
  if (card.dailyTargetSec <= 0) return 'off';
  return card.onLeaveToday ? 'leave' : 'target';
}

/**
 * **Row order: never by hours.**
 *
 * Those who are working come first, then those who are not. Careful: **inside each
 * group the server's order is kept intact** (`empCode` ascending, in
 * dashboard.service), so the order is neutral.
 *
 * Careful: sorting by hours would turn the page into a **leaderboard** every
 * morning, and that is exactly what this product does not do (the README's
 * "never" list). The split is not taken from `splitBoard` and rewritten here:
 * `isWorking` should live in one place, or the tab counts and row order would one
 * day disagree (the lesson of G88).
 */
export function rosterRows(cards: readonly LiveCard[]): LiveCard[] {
  const working: LiveCard[] = [];
  const resting: LiveCard[] = [];

  for (const card of cards) {
    (isWorking(card.status) ? working : resting).push(card);
  }

  return [...working, ...resting];
}

/**
 * Where the first "not working" row is; the separated band goes there.
 * `-1` if there is none, in which case the band is not drawn at all.
 */
export function restingStartsAt(rows: readonly LiveCard[]): number {
  return rows.findIndex((c) => !isWorking(c.status));
}

export interface TaskView {
  /**
   * How many tasks were **finished** today (the Complete button).
   *
   * Careful: a start is deliberately not counted: seeing a task number in a
   * window title cannot tell "who does it" from "who looks at it".
   */
  done: number;
  /** Careful: `null` = **this employee has no task target**, not a target of zero */
  target: number | null;
  /** Always `false` without a target: "not applicable", not "failed" */
  met: boolean;
}

/**
 * **Today's tasks: three states, not two.**
 *
 * | Who | What is shown |
 * |---|---|
 * | Receives tasks, with a target | `24 / 25` |
 * | Anyone else who still finished tasks | just `43` |
 * | Nobody finished any | nothing |
 *
 * Careful: the middle row is the decision: someone without a target (a
 * manager helping out, a target of 0) may still finish tasks. "How many" and
 * "did they hit the target" stay two separate questions, and hiding the
 * number would lose real work.
 *
 * Careful: **an exact copy of the server's `taskView`** (`task-start.rules.ts`).
 * If the two differ, the digest would say one thing and the screen another,
 * and this project has fallen in exactly that trap before (see the note on
 * `compareVersion` in `fleet.ts`).
 */
export function taskView(card: LiveCard): TaskView | null {
  /**
   * **Only "finished" is counted.**
   *
   * Careful: `card.tasksStarted` still comes in the API (it is how the Live
   * Board knows work began), but it is not **shown** as the count: a start
   * only says a window was opened.
   */
  const done = card.tasksDone;

  if (card.receivesTasks && card.taskTargetPerDay > 0) {
    return {
      done,
      target: card.taskTargetPerDay,
      met: done >= card.taskTargetPerDay,
    };
  }

  return done > 0 ? { done, target: null, met: false } : null;
}
