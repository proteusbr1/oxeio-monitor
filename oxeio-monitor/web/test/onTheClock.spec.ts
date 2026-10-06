import { describe, expect, it } from 'vitest';

import type { LiveCard, LiveStatus } from '../src/api/dashboard';
import { isWorking, splitBoard } from '../src/pages/live/onTheClock';

/**
 * The Live Board's two tabs: **working** and **not working**.
 *
 * Careful: a mistake here looks small but costs a lot: if someone falls into
 * neither tab, they **silently vanish** from the board. In a 15-person office,
 * one person fewer would not be noticed.
 */
const ALL: LiveStatus[] = ['active', 'idle', 'offline'];

const card = (status: LiveStatus, employeeId: number): LiveCard =>
  ({ employeeId, status }) as LiveCard;

describe('isWorking', () => {
  it('only active counts as working', () => {
    expect(isWorking('active')).toBe(true);
  });

  /**
   * Careful: `idle` means the PC is on but the hands have stopped: not work.
   * Merging the two would inflate the number in front of the owner's eyes,
   * though nobody worked more.
   */
  it('idle is not working', () => {
    expect(isWorking('idle')).toBe(false);
  });

  it('offline is not working', () => {
    expect(isWorking('offline')).toBe(false);
  });
});

describe('splitBoard', () => {
  it('those who are working come in the first group', () => {
    const { working } = splitBoard([card('active', 1), card('idle', 2)]);

    expect(working.map((c) => c.employeeId)).toEqual([1]);
  });

  /**
   * **The main test of this file.** If someone built the second tab as
   * `status === 'idle'`, the `offline` cards would be in **no tab at all**.
   */
  it('every card appears exactly once: nobody is lost, nobody comes twice', () => {
    const cards = ALL.map((s, i) => card(s, i + 1));

    const { working, resting } = splitBoard(cards);
    const seen = [...working, ...resting].map((c) => c.employeeId).sort();

    // Careful: not a hand-written list: counted from ALL, otherwise adding or
    //    removing one status would break the test while the claim stayed intact.
    expect(seen).toEqual(ALL.map((_, i) => i + 1));
    expect(working.length + resting.length).toBe(cards.length);
  });

  /**
   * Careful: even if a new `LiveStatus` is added, it falls into the "not
   * working" group by itself, because the condition is written by **exclusion**,
   * not by selection. This test holds that promise.
   */
  it('an unknown status falls into the not-working group and is not lost', () => {
    const { working, resting } = splitBoard([
      card('locked_out_someday' as LiveStatus, 9),
    ]);

    expect(working).toHaveLength(0);
    expect(resting).toHaveLength(1);
  });

  it('on an empty board both are empty', () => {
    const { working, resting } = splitBoard([]);

    expect(working).toHaveLength(0);
    expect(resting).toHaveLength(0);
  });

  /** Careful: when nobody works the first tab is empty: the page is not broken, just empty */
  it('when nobody works the first group is empty', () => {
    const { working, resting } = splitBoard([card('idle', 1), card('offline', 2)]);

    expect(working).toHaveLength(0);
    expect(resting).toHaveLength(2);
  });

  /** The order does not change: inside each group, the order the server sent */
  it('keeps the server order', () => {
    const cards = [card('active', 5), card('idle', 6), card('active', 7)];

    expect(splitBoard(cards).working.map((c) => c.employeeId)).toEqual([5, 7]);
  });
});
