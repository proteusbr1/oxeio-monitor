import { describe, expect, it } from 'vitest';

import {
  dropdownValueOf,
  FILTERS,
  stageOf,
  statusOptions,
} from '../src/pages/tasks/filters';

/**
 * **The Task pool's filters**: which control selects what.
 *
 * Careful: these rules used to live inside the page, so the only way to check
 * them was to look in a browser. They were split out when `no_file` was added,
 * because the mistake is silent: if the select jumps back to "All tasks"
 * right after picking, the list stays on screen but nobody can tell what it is a list of.
 */
describe('stageOf — step or status', () => {
  it('all six steps are recognised', () => {
    for (const key of [
      'to_check',
      'to_fix',
      'to_deliver',
      'to_publish',
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
   * rule would make the select jump to "All tasks" on picking, while the list had changed.
   */
  it('`no_file` shows itself, not `all`', () => {
    expect(dropdownValueOf('no_file', '', '', TODAY)).toBe('no_file');
  });

  it('the steps of the queue chips show `all` in the dropdown', () => {
    expect(dropdownValueOf('to_check', '', '', TODAY)).toBe('all');
    expect(dropdownValueOf('to_deliver', '', '', TODAY)).toBe('all');
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
   * reason for no trace is innocent (work done under another name).
   */
  it('it is in the dropdown, not in the queue chip row', () => {
    expect(statusOptions(true).map((o) => o.value)).toContain('no_file');
    expect(FILTERS.map((f) => f.key)).not.toContain('no_file');
  });

  /**
   * Careful: without start detection nothing is ever measured, so every
   * finished task would be "never on screen" — a list that accuses everyone.
   */
  it('it is not offered at all while start detection is off', () => {
    expect(statusOptions(false).map((o) => o.value)).not.toContain('no_file');
    expect(statusOptions(false).map((o) => o.value)).toContain('done_today');
  });

  it('the chip row holds only the daily work queues, in the order work moves', () => {
    expect(FILTERS.map((f) => f.key)).toEqual([
      'to_check',
      'to_fix',
      'to_deliver',
      'to_publish',
    ]);
  });
});
