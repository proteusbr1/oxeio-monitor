import { describe, expect, it } from 'vitest';

import {
  blockedNotice,
  openInTabs,
  type OpenedTab,
} from '../src/lib/popups';

/**
 * **Opening 30 tabs at once.**
 *
 * Careful: the real subject of the test is **not success but being blocked**:
 * the browser allows more than one tab per press only after permission, and
 * that is exactly what will happen in the field every day. If mishandled, the
 * designer would see one tab and think the button was broken.
 *
 * No `window` is needed: `openInTabs` takes the opening job from outside, so a
 * fake browser can be set up without jsdom (the rule in `vitest.config.ts`).
 */

/** A fake tab: whether `opener` was cleared is the thing to look at */
function tab(): OpenedTab {
  return { opener: { fake: 'window' } };
}

describe('openInTabs', () => {
  it('when all open, all are counted', () => {
    const opened = openInTabs(['a', 'b', 'c'], () => tab());
    expect(opened).toEqual({ opened: 3, blocked: 0 });
  });

  /**
   * Careful: tabnabbing: without this one line an opened tab could use
   * `window.opener` to redirect the designer's page to a fake login.
   */
  it('cuts the opener of every tab it opens', () => {
    const made: OpenedTab[] = [];
    openInTabs(['a', 'b'], () => {
      const t = tab();
      made.push(t);
      return t;
    });
    expect(made).toHaveLength(2);
    expect(made.every((t) => t.opener === null)).toBe(true);
  });

  /** Chrome's real behaviour: the first opens, the rest are blocked */
  it('counts correctly when the first opens and the rest are blocked', () => {
    let n = 0;
    const result = openInTabs(['a', 'b', 'c'], () => (n++ === 0 ? tab() : null));
    expect(result).toEqual({ opened: 1, blocked: 2 });
  });

  /**
   * Careful: the loop does not stop when one is blocked: if a middle one is
   * blocked the last must not be lost. Not every browser follows Chrome's rule.
   */
  it('keeps trying the later ones even when blocked midway', () => {
    const pattern = [tab(), null, tab()];
    let n = 0;
    const result = openInTabs(['a', 'b', 'c'], () => pattern[n++]);
    expect(result).toEqual({ opened: 2, blocked: 1 });
  });

  it('does nothing when the list is empty', () => {
    expect(openInTabs([], () => tab())).toEqual({ opened: 0, blocked: 0 });
  });
});

describe('blockedNotice', () => {
  it('stays quiet when nothing is blocked', () => {
    expect(blockedNotice(30, 0)).toBeNull();
  });

  it('when all are blocked the number is the total', () => {
    expect(blockedNotice(30, 30)).toContain('all 30 tabs');
  });

  it('when partly blocked it says both numbers', () => {
    expect(blockedNotice(30, 29)).toContain('29 of 30 tabs');
  });

  /**
   * Careful: the most important test: the message **must** say what to do.
   * With just "blocked", nobody would know what next, and would open 30 links by hand every day.
   */
  it('also says what to do', () => {
    const msg = blockedNotice(30, 29) ?? '';
    expect(msg).toContain('Allow pop-ups');
    expect(msg).toContain('address bar');
  });
});
