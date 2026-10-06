import { describe, expect, it } from 'vitest';

import {
  dropdownValueOf,
  FILTERS,
  stageOf,
  STATUS_OPTIONS,
} from '../src/pages/targets/filters';

/**
 * **The Design Pool's filters**: which control selects what.
 *
 * Careful: these rules used to live inside the page, so the only way to check
 * them was to look in a browser. They were split out when `no_file` was added,
 * because the mistake is silent: if the select jumps back to "All targets"
 * right after picking, the list stays on screen but nobody can tell what it is a list of.
 */
describe('stageOf — step or status', () => {
  it('all six steps are recognised', () => {
    for (const key of [
      'to_check',
      'to_fix',
      'to_upload',
      'to_live',
      'to_review',
      'no_file',
    ] as const) {
      expect(stageOf(key)).toBe(key);
    }
  });

  it('the statuses are not steps', () => {
    expect(stageOf('all')).toBeUndefined();
    expect(stageOf('pool')).toBeUndefined();
    expect(stageOf('done')).toBeUndefined();
  });
});

describe('dropdownValueOf — what the dropdown shows', () => {
  const TODAY = '2026-09-09';

  /**
   * **This claim is the heart of the new filter.**
   *
   * Careful: every other step shows `'all'` because they are picked on the
   * **chip**. But `no_file` is inside the dropdown itself: applying the same
   * rule would make the select jump to "All targets" on picking, while the list had changed.
   */
  it('`no_file` shows itself, not `all`', () => {
    expect(dropdownValueOf('no_file', '', '', TODAY)).toBe('no_file');
  });

  it('the steps of the queue chips show `all` in the dropdown', () => {
    expect(dropdownValueOf('to_check', '', '', TODAY)).toBe('all');
    expect(dropdownValueOf('to_upload', '', '', TODAY)).toBe('all');
    expect(dropdownValueOf('to_review', '', '', TODAY)).toBe('all');
  });

  /**
   * Careful: `done_today` is not a real status: it is not remembered, it is
   * **matched**. So when the dates are changed by hand the select drops to `done` at once.
   */
  it('`done` with the two dates of today is `done_today`', () => {
    expect(dropdownValueOf('done', TODAY, TODAY, TODAY)).toBe('done_today');
  });

  it('once the dates move it is no longer `done_today`', () => {
    expect(dropdownValueOf('done', '2026-09-01', TODAY, TODAY)).toBe('done');
    expect(dropdownValueOf('done', TODAY, '2026-09-30', TODAY)).toBe('done');
    expect(dropdownValueOf('done', '', '', TODAY)).toBe('done');
  });

  it('the remaining statuses are themselves', () => {
    expect(dropdownValueOf('all', '', '', TODAY)).toBe('all');
    expect(dropdownValueOf('pool', '', '', TODAY)).toBe('pool');
    expect(dropdownValueOf('assigned', '', '', TODAY)).toBe('assigned');
  });
});

describe('where it sits: the owner condition of a quiet list', () => {
  /**
   * **`no_file` is not in the chips, and that is the whole decision.**
   * (Owner's condition: "a quiet list, not an alert".)
   *
   * Careful: in a chip it would carry a **number**, and a number would make it
   * a queue: something to empty daily, in effect an alert. Yet the most common
   * reason for no trace is innocent (a file never saved).
   */
  it('it is in the dropdown, not in the queue chip row', () => {
    expect(STATUS_OPTIONS.map((o) => o.value)).toContain('no_file');
    expect(FILTERS.map((f) => f.key)).not.toContain('no_file');
  });

  it('the chip row holds only the daily queues of researchers', () => {
    expect(FILTERS.map((f) => f.key)).toEqual([
      'to_check',
      'to_fix',
      'to_upload',
      'to_live',
    ]);
  });
});
