import { describe, expect, it } from 'vitest';

import { UserRole } from '@prisma/client';

import {
  allocationSizes,
  BULK_MAX_LINES,
  canUseTasks,
  DROP_REASONS,
  dropReasonOf,
  isDropReason,
  isWebLink,
  LEGACY_DROP_REASONS,
  LINK_MAX,
  MAX_ISSUED_PER_DAY,
  onScreenSecOf,
  parseBulk,
  pastedLineCount,
  REFERENCE_MAX,
  TASK_NUMBER_START,
  taskOfLine,
  topUpSize,
} from '../src/tasks/tasks.rules';
import { cleanApps, resolveTasksSettings } from '../src/tasks/tasks-settings.rules';

/**
 * **Tasks: the pure rules.**
 *
 * The most important claim of this file: one pasted line is one task, its
 * reference is its identity, and every line that is not taken comes back with
 * a reason.
 */

describe('taskOfLine — one line, one task', () => {
  it('a plain line is the reference, with no link', () => {
    expect(taskOfLine('INV-2041')).toEqual({ reference: 'INV-2041', link: null });
  });

  it('`reference | link` splits at the bar, both trimmed', () => {
    expect(taskOfLine('  INV-2041  |  https://crm.example.com/inv/2041  ')).toEqual({
      reference: 'INV-2041',
      link: 'https://crm.example.com/inv/2041',
    });
  });

  it('only the first bar splits; a bar inside the link stays', () => {
    expect(taskOfLine('A | https://example.com/?q=a|b')).toEqual({
      reference: 'A',
      link: 'https://example.com/?q=a|b',
    });
  });

  it('a bare http(s) URL is both the reference and the link', () => {
    expect(taskOfLine('https://example.com/ticket/7')).toEqual({
      reference: 'https://example.com/ticket/7',
      link: 'https://example.com/ticket/7',
    });
    expect(taskOfLine('HTTP://example.com/x')).toEqual({
      reference: 'HTTP://example.com/x',
      link: 'HTTP://example.com/x',
    });
  });

  it('an empty link part means no link', () => {
    expect(taskOfLine('Call the bank |')).toEqual({ reference: 'Call the bank', link: null });
  });

  it('"| link" with no reference uses the link as the reference', () => {
    expect(taskOfLine('| https://example.com/a')).toEqual({
      reference: 'https://example.com/a',
      link: 'https://example.com/a',
    });
  });

  it('a reference longer than 200 characters is too long', () => {
    expect(taskOfLine('x'.repeat(REFERENCE_MAX))).toEqual({
      reference: 'x'.repeat(REFERENCE_MAX),
      link: null,
    });
    expect(taskOfLine('x'.repeat(REFERENCE_MAX + 1))).toEqual({ reason: 'too_long' });
  });

  it('a link longer than 500 characters is too long', () => {
    const long = `https://example.com/${'a'.repeat(LINK_MAX)}`;
    expect(taskOfLine(`REF-1 | ${long}`)).toEqual({ reason: 'too_long' });
  });

  /** A bare URL is also the reference, so it must fit in 200 characters */
  it('a bare URL longer than 200 characters is too long', () => {
    expect(taskOfLine(`https://example.com/${'a'.repeat(200)}`)).toEqual({ reason: 'too_long' });
  });

  it.each([
    'REF-1 | not a link',
    'REF-1 | ftp://example.com/file',
    'REF-1 | javascript:alert(1)',
    'REF-1 | example.com/page',
    'REF-1 | https://exa mple.com',
  ])('a link that is not an http(s) URL is rejected — %s', (line) => {
    expect(taskOfLine(line)).toEqual({ reason: 'bad_link' });
  });
});

describe('isWebLink', () => {
  it('only absolute http and https URLs', () => {
    expect(isWebLink('https://example.com')).toBe(true);
    expect(isWebLink('http://example.com/a?b=c#d')).toBe(true);
    expect(isWebLink('mailto:a@example.com')).toBe(false);
    expect(isWebLink('data:text/html,hi')).toBe(false);
    expect(isWebLink('/relative/path')).toBe(false);
  });
});

describe('parseBulk — many lines at once', () => {
  it('each non-empty line is one task, in order, with its line number', () => {
    const { accepted, rejected } = parseBulk(
      ['INV-1', 'INV-2 | https://example.com/2', 'https://example.com/3'].join('\n'),
    );

    expect(rejected).toEqual([]);
    expect(accepted).toEqual([
      { reference: 'INV-1', link: null, line: 1 },
      { reference: 'INV-2', link: 'https://example.com/2', line: 2 },
      { reference: 'https://example.com/3', link: 'https://example.com/3', line: 3 },
    ]);
  });

  /** The same reference twice in one paste: the second is rejected, not inserted twice */
  it('a reference repeated in the paste is rejected the second time', () => {
    const { accepted, rejected } = parseBulk(
      ['INV-1', 'INV-1 | https://example.com/other', 'INV-2'].join('\n'),
    );

    expect(accepted.map((a) => a.reference)).toEqual(['INV-1', 'INV-2']);
    expect(rejected).toEqual([
      { line: 2, text: 'INV-1 | https://example.com/other', reason: 'duplicate_in_paste' },
    ]);
  });

  it('a bare URL and the same URL as `ref | link` are the same task', () => {
    const { accepted, rejected } = parseBulk(
      'https://example.com/a\nhttps://example.com/a | https://example.com/a',
    );
    expect(accepted).toHaveLength(1);
    expect(rejected[0].reason).toBe('duplicate_in_paste');
  });

  /** An empty line is **not an error** */
  it('empty lines are silently skipped, not in the rejected list', () => {
    const { accepted, rejected } = parseBulk('\n\nINV-1\r\n\n   \n');

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  /** Failed lines come back with the line, the text and the reason */
  it('a rejection carries the line, the text and the reason', () => {
    const { rejected } = parseBulk(`OK-1\nX | nope\n${'y'.repeat(201)}`);

    expect(rejected).toEqual([
      { line: 2, text: 'X | nope', reason: 'bad_link' },
      { line: 3, text: 'y'.repeat(201), reason: 'too_long' },
    ]);
  });

  it('works with 500 lines', () => {
    const lines = Array.from({ length: BULK_MAX_LINES }, (_, i) => `TASK-${i}`);
    expect(parseBulk(lines.join('\n')).accepted).toHaveLength(500);
  });

  it('pastedLineCount counts only non-blank lines', () => {
    expect(pastedLineCount('a\n\n  \nb\r\nc\n')).toBe(3);
    expect(pastedLineCount('')).toBe(0);
  });
});

describe('TASK_NUMBER_START', () => {
  /** Seven digits: never the short numbers people already put in file names */
  it('starts at one million', () => {
    expect(TASK_NUMBER_START).toBe(1_000_000);
  });
});

describe('drop reasons', () => {
  it('the list', () => {
    expect([...DROP_REASONS]).toEqual(['not_needed', 'cannot_do', 'duplicate', 'other']);
    for (const r of DROP_REASONS) expect(isDropReason(r)).toBe(true);
    expect(isDropReason('not_found')).toBe(false);
    expect(isDropReason(7)).toBe(false);
  });

  /** The same mapping the migration applied to stored rows */
  it('old values map onto the new list', () => {
    expect(LEGACY_DROP_REASONS).toEqual({
      not_found: 'not_needed',
      copyright: 'cannot_do',
      events: 'cannot_do',
    });
    expect(dropReasonOf('not_found')).toBe('not_needed');
    expect(dropReasonOf('copyright')).toBe('cannot_do');
    expect(dropReasonOf('events')).toBe('cannot_do');
  });

  it('current values stay, unknown text becomes other, null stays null', () => {
    expect(dropReasonOf('duplicate')).toBe('duplicate');
    expect(dropReasonOf('whatever was typed')).toBe('other');
    expect(dropReasonOf(null)).toBeNull();
  });
});

describe('onScreenSecOf — three states', () => {
  const since = new Date('2026-09-01T00:00:00Z');
  const seconds = new Map([[1000001, 600]]);

  it('measured time comes through', () => {
    const row = { taskNumber: 1000001, completedAt: new Date('2026-09-05'), assignedAt: null };
    expect(onScreenSecOf(row, seconds, since)).toBe(600);
  });

  it('done but never on screen → 0', () => {
    const row = { taskNumber: 1000002, completedAt: new Date('2026-09-05'), assignedAt: null };
    expect(onScreenSecOf(row, seconds, since)).toBe(0);
  });

  it('in hand and not yet seen → null, not an accusation', () => {
    const row = { taskNumber: 1000002, completedAt: null, assignedAt: new Date('2026-09-05') };
    expect(onScreenSecOf(row, seconds, since)).toBeNull();
  });

  it('before titles were stored, or with detection off → null', () => {
    const row = { taskNumber: 1000002, completedAt: new Date('2026-08-05'), assignedAt: null };
    expect(onScreenSecOf(row, seconds, since)).toBeNull();
    expect(onScreenSecOf({ ...row, completedAt: new Date('2026-09-05') }, seconds, null)).toBeNull();
  });

  it('no task number → null', () => {
    expect(onScreenSecOf({ taskNumber: null, completedAt: new Date('2026-09-05'), assignedAt: null }, seconds, since)).toBeNull();
  });
});

describe('topUpSize — how many still to give today', () => {
  const T = 25;
  const at = (completedToday: number, openCount: number, issuedToday = 0) =>
    topUpSize({
      receivesTasks: true,
      completedToday,
      openCount,
      issuedToday,
      dailyTarget: T,
    });

  it('hand empty, nothing finished → the full 30', () => {
    expect(at(0, 0)).toBe(30);
  });

  it('10 finished, hand empty → 18 for the remaining 15', () => {
    expect(at(10, 0)).toBe(18);
  });

  it('enough in hand → 0', () => {
    expect(at(0, 30)).toBe(0);
    expect(at(10, 20)).toBe(0);
  });

  it('5 in hand, 18 needed → the remaining 13', () => {
    expect(at(10, 5)).toBe(13);
  });

  it('target already reached → 0, even if the hand is empty', () => {
    expect(at(25, 0)).toBe(0);
    expect(at(32, 0)).toBe(0);
  });

  /** Target 0 (for example a manager who helps out) — the morning hand-out is enough */
  it('target 0 → nothing is ever given', () => {
    expect(topUpSize({ receivesTasks: true, completedToday: 0, openCount: 0, issuedToday: 0, dailyTarget: 0 })).toBe(0);
  });

  /** The gate is inside the function: someone who does not receive tasks gets none */
  it('no top-up for someone who does not receive tasks — whatever the number', () => {
    expect(
      topUpSize({ receivesTasks: false, completedToday: 0, openCount: 0, issuedToday: 0, dailyTarget: 25 }),
    ).toBe(0);
  });

  it('one Skip brings back exactly one, and nothing once the ceiling is used up', () => {
    expect(at(0, 29)).toBe(1);
    expect(at(0, 29, MAX_ISSUED_PER_DAY)).toBe(0);
  });

  it('near the ceiling, only what is left', () => {
    expect(at(10, 0, MAX_ISSUED_PER_DAY - 4)).toBe(4);
  });

  it('with a target of 30 the ratio moves with it', () => {
    expect(topUpSize({ receivesTasks: true, completedToday: 0, openCount: 0, issuedToday: 0, dailyTarget: 30 })).toBe(30);
    expect(topUpSize({ receivesTasks: true, completedToday: 15, openCount: 0, issuedToday: 0, dailyTarget: 30 })).toBe(15);
  });
});

describe('allocationSizes — who gets how many', () => {
  it('30 is filled up after excluding what is in hand', () => {
    const sizes = allocationSizes(
      [
        { employeeId: 1, openCount: 0 },
        { employeeId: 2, openCount: 22 },
        { employeeId: 3, openCount: 30 },
      ],
      1000,
    );

    expect(sizes.get(1)).toBe(30);
    expect(sizes.get(2)).toBe(8);
    expect(sizes.has(3)).toBe(false);
  });

  it('when the pool is short, as many as possible in order', () => {
    const sizes = allocationSizes(
      [
        { employeeId: 1, openCount: 0 },
        { employeeId: 2, openCount: 0 },
      ],
      40,
    );

    expect(sizes.get(1)).toBe(30);
    expect(sizes.get(2)).toBe(10);
  });

  it('when the pool is empty, nobody gets anything', () => {
    expect(allocationSizes([{ employeeId: 1, openCount: 0 }], 0).size).toBe(0);
  });

  it('empty when there is nobody', () => {
    expect(allocationSizes([], 500).size).toBe(0);
  });
});

/**
 * **Who may use the task pool.** The real job of this describe is guarding
 * the allow-list: a `role !== employee` rule would let the next new role in
 * silently.
 */
describe('canUseTasks — who may touch the task pool', () => {
  it('owner, manager and coordinator may', () => {
    expect(canUseTasks(UserRole.owner)).toBe(true);
    expect(canUseTasks(UserRole.manager)).toBe(true);
    expect(canUseTasks(UserRole.coordinator)).toBe(true);
  });

  /** An assignee sees their own list in `/me/tasks`, not the whole team's pool */
  it('an employee may not', () => {
    expect(canUseTasks(UserRole.employee)).toBe(false);
  });

  it('every role outside the list is "no"', () => {
    const allowed = new Set<string>([UserRole.owner, UserRole.manager, UserRole.coordinator]);

    for (const role of Object.values(UserRole)) {
      expect(canUseTasks(role)).toBe(allowed.has(role));
    }
  });
});

describe('resolveTasksSettings — Settings → Tasks', () => {
  it('nothing saved → start detection off', () => {
    expect(resolveTasksSettings(null)).toEqual({ startDetection: { apps: [] } });
    expect(resolveTasksSettings({})).toEqual({ startDetection: { apps: [] } });
    expect(resolveTasksSettings({ startDetection: 'x' })).toEqual({ startDetection: { apps: [] } });
  });

  it('the saved apps come back cleaned', () => {
    expect(
      resolveTasksSettings({ startDetection: { apps: [' Excel.exe ', 'EXCEL.EXE', 7, '', 'C:\\x.exe', 'WINWORD.EXE'] } }),
    ).toEqual({ startDetection: { apps: ['Excel.exe', 'WINWORD.EXE'] } });
  });

  it('cleanApps keeps the first spelling of a repeat', () => {
    expect(cleanApps(['excel.EXE', 'Excel.exe'])).toEqual(['excel.EXE']);
  });
});
