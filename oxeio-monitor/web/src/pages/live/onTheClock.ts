import type { LiveCard, LiveStatus } from '../../api/dashboard';

/**
 * The board splits into two groups: **working now** and **not working**.
 *
 * Important — why this is a separate file: the split is a one-line `filter`, but a
 * mistake in it is not a one-line problem. If the "Working now" tile at the top and
 * the tab counts were computed in different places, they would eventually disagree
 * and the board would contradict itself again (a 16:50 screenshot on top, "never
 * responded" below).
 *
 * Careful: the real risk is a card dropping out of both groups. If someone built the
 * second tab as `status === 'idle'`, then `offline` and `agent_down` cards would be in
 * no tab at all and people would silently vanish from the board. So the "not working"
 * list is computed by exclusion, not by selection.
 */

/**
 * Careful: only `active` counts as working. `idle` means the PC is on but the user's
 * hands are still, which is not work. Merging the two would inflate the board's
 * numbers without anyone working more.
 */
export function isWorking(status: LiveStatus): boolean {
  return status === 'active';
}

export interface BoardSplit {
  working: LiveCard[];
  resting: LiveCard[];
}

/**
 * Careful: every card lands in exactly one list, never dropped and never duplicated.
 * A new `LiveStatus` value automatically falls into the "not working" group,
 * because that condition is written as an exclusion.
 */
export function splitBoard(cards: readonly LiveCard[]): BoardSplit {
  const working: LiveCard[] = [];
  const resting: LiveCard[] = [];

  for (const card of cards) {
    if (isWorking(card.status)) working.push(card);
    else resting.push(card);
  }

  return { working, resting };
}
