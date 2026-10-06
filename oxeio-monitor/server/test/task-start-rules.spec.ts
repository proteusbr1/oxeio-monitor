import { describe, expect, it } from 'vitest';

import {
  KNOWN_NUMBER_FROM,
  dailyCompletionCap,
  hasTaskTarget,
  keepKnownLongNumbers,
  startDetectionApps,
  taskNumberOf,
  taskNumbersFirstSeenInDay,
  taskTargetOf,
  taskView,
} from '../src/summary/task-start.rules';

/**
 * **Start detection and the daily task numbers.**
 *
 * The two most important claims in this file: nothing is read except from an
 * app the owner listed (otherwise a browser title would one day slip in as a
 * task start), and only people who receive tasks with a target above 0 are
 * held to a target.
 */

const EXCEL = startDetectionApps(['Excel.exe']);
const OFFICE = startDetectionApps(['Excel.exe', 'WINWORD.EXE']);

describe('startDetectionApps — the configured list', () => {
  it('lower-cases, trims and drops blanks and repeats', () => {
    expect([...startDetectionApps([' Excel.exe ', 'EXCEL.EXE', '', '  ', 'winword.exe'])]).toEqual([
      'excel.exe',
      'winword.exe',
    ]);
  });

  it('an empty list means detection is off', () => {
    expect(startDetectionApps([]).size).toBe(0);
    expect(taskNumberOf('Excel.exe', '1000042 - Report.xlsx', startDetectionApps([]))).toBeNull();
  });
});

describe('taskNumberOf — task number from a title', () => {
  it.each([
    ['37933-Quarterly report.xlsx - Excel', '37933'],
    ['37904Budget.xlsx', '37904'],
    ['3218-Invoice 7.xlsx', '3218'],
    ['37769......Plan.xlsx', '37769'],
  ])('%s → %s', (title, id) => {
    expect(taskNumberOf('Excel.exe', title, EXCEL)).toBe(id);
  });

  /**
   * Allow-list: an app never comes under reading by itself. If this test
   * breaks, someone has probably turned it into a deny-list.
   */
  it('nothing is read except from the listed apps', () => {
    for (const app of ['chrome.exe', 'ms-teams.exe', 'explorer.exe', 'notepad.exe']) {
      expect(taskNumberOf(app, '37933-Something.xlsx', OFFICE)).toBeNull();
    }
  });

  it('the app name matches in any letter case', () => {
    expect(taskNumberOf('EXCEL.EXE', '1234-x.xlsx', EXCEL)).toBe('1234');
    expect(taskNumberOf('excel.exe', '1234-x.xlsx', EXCEL)).toBe('1234');
    expect(taskNumberOf('WinWord.exe', '1234-x.docx', OFFICE)).toBe('1234');
  });

  /** Unsaved and template windows drop out automatically: they do not start with a digit */
  it.each([
    'Book1 - Excel',
    'Template.xlsx',
    'Report draft.docx',
    'Untitled-3*',
  ])('titles without a leading number are ignored — %s', (title) => {
    expect(taskNumberOf('Excel.exe', title, EXCEL)).toBeNull();
  });

  /** Task numbers start at 1,000,000: seven digits must come through whole */
  it.each([
    ['1000042-Report.xlsx', '1000042'],
    ['1000299-Budget.xlsx', '1000299'],
    ['1000000-First One.xlsx', '1000000'],
  ])('seven-digit task number — %s → %s', (title, id) => {
    expect(taskNumberOf('Excel.exe', title, EXCEL)).toBe(id);
  });

  /** Two consecutive numbers must stay separate (the boundary check) */
  it('consecutive task numbers do not merge', () => {
    const a = taskNumberOf('Excel.exe', '1000042-A.xlsx', EXCEL);
    const b = taskNumberOf('Excel.exe', '1000043-B.xlsx', EXCEL);
    expect(a).toBe('1000042');
    expect(b).toBe('1000043');
  });

  /** Eight or more digits = a stock or date id, not a task number */
  it.each([
    '10163372_181_Vector.xlsx',
    '136482370_79_stock.xlsx',
    '20260820164512_export.xlsx',
  ])('8+ digit ids are excluded — %s', (title) => {
    expect(taskNumberOf('Excel.exe', title, EXCEL)).toBeNull();
  });

  it('not fewer than three digits', () => {
    expect(taskNumberOf('Excel.exe', '4 [Converted].xlsx', EXCEL)).toBeNull();
    expect(taskNumberOf('Excel.exe', '99-x.xlsx', EXCEL)).toBeNull();
    expect(taskNumberOf('Excel.exe', '100-x.xlsx', EXCEL)).toBe('100');
  });

  it('leading spaces in the title are trimmed', () => {
    expect(taskNumberOf('Excel.exe', '   1000042 - x', EXCEL)).toBe('1000042');
  });

  it('no crash when there is no title', () => {
    expect(taskNumberOf('Excel.exe', null, EXCEL)).toBeNull();
    expect(taskNumberOf('Excel.exe', '', EXCEL)).toBeNull();
  });
});

describe('taskNumbersFirstSeenInDay — unique numbers and first instant', () => {
  const AT = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 6, h, m));

  it('the same number appearing many times counts once', () => {
    const rows = [
      { processName: 'Excel.exe', windowTitle: '37933-A.xlsx', startedAt: AT(5) },
      { processName: 'Excel.exe', windowTitle: '37933-A.xlsx [Read-Only]', startedAt: AT(6) },
      { processName: 'Excel.exe', windowTitle: '37904-B.xlsx', startedAt: AT(7) },
      { processName: 'chrome.exe', windowTitle: '37905-C — Google Chrome', startedAt: AT(8) },
      { processName: 'Excel.exe', windowTitle: 'Book3', startedAt: AT(9) },
    ];

    expect([...taskNumbersFirstSeenInDay(rows, EXCEL).keys()].sort()).toEqual(['37904', '37933']);
  });

  /** Rows can arrive in any order: the earliest instant is kept, not the last */
  it('across several rows with the same number, the earliest instant wins', () => {
    const rows = [
      { processName: 'Excel.exe', windowTitle: '37933-A.xlsx', startedAt: AT(14) },
      { processName: 'Excel.exe', windowTitle: '37933-A.xlsx', startedAt: AT(9, 12) },
      { processName: 'Excel.exe', windowTitle: '37933-B.xlsx', startedAt: AT(11) },
    ];

    expect(taskNumbersFirstSeenInDay(rows, EXCEL).get('37933')).toEqual(AT(9, 12));
  });

  it('nothing at all while no app is listed', () => {
    const rows = [{ processName: 'Excel.exe', windowTitle: '37933-A.xlsx', startedAt: AT(5) }];
    expect(taskNumbersFirstSeenInDay(rows, startDetectionApps([])).size).toBe(0);
  });

  it('empty when there is nothing', () => {
    expect(taskNumbersFirstSeenInDay([], EXCEL).size).toBe(0);
  });
});

describe('hasTaskTarget · taskView', () => {
  it('a target needs both: receiving tasks and a number above 0', () => {
    expect(hasTaskTarget(true, 25)).toBe(true);
    expect(hasTaskTarget(true, 0)).toBe(false);
    expect(hasTaskTarget(false, 25)).toBe(false);
    expect(hasTaskTarget(null, 25)).toBe(false);
    expect(hasTaskTarget(undefined, 25)).toBe(false);
  });

  /** Someone without a target who still finished tasks: the number is real, so it shows */
  it('no target but did the work — the number is shown, no target', () => {
    expect(taskView(false, 43, 25)).toEqual({ done: 43, target: null, met: false });
    expect(taskView(true, 3, 0)?.target).toBeNull();
  });

  /** The check mark means "target reached" — never for someone without one */
  it('someone without a target never gets the check mark', () => {
    expect(taskView(false, 999, 25)?.met).toBe(false);
  });

  /** If no work was done, show nothing — reading "0" feels like an accusation */
  it('nothing is shown when nothing was done and there is no target', () => {
    expect(taskView(false, 0, 25)).toBeNull();
    expect(taskView(null, 0, 25)).toBeNull();
    expect(taskView(true, 0, 0)).toBeNull();
  });

  it('with a target, zero done still shows 0/25', () => {
    expect(taskView(true, 0, 25)).toEqual({ done: 0, target: 25, met: false });
  });

  it('exactly at the target = reached', () => {
    expect(taskView(true, 25, 25)).toEqual({ done: 25, target: 25, met: true });
    expect(taskView(true, 24, 25)?.met).toBe(false);
    expect(taskView(true, 39, 25)?.met).toBe(true);
  });
});

describe('dailyCompletionCap — the most "done" allowed per day', () => {
  /** The cap is the target number itself, not a separate constant */
  it("a person's own target is the cap", () => {
    expect(dailyCompletionCap(true, 30, 25)).toBe(30);
    expect(dailyCompletionCap(true, null, 25)).toBe(25);
  });

  /** Someone who does not receive tasks has no cap, even with 25 in the policy */
  it('no target means no cap — even with 25 in the policy', () => {
    expect(dailyCompletionCap(false, null, 25)).toBeNull();
    expect(dailyCompletionCap(null, null, 25)).toBeNull();
  });

  /** 0 means "this person's target is off", not a cap of 0 */
  it('a target of 0 means no cap, not a cap of 0', () => {
    expect(dailyCompletionCap(true, 0, 25)).toBeNull();
    expect(dailyCompletionCap(true, null, 0)).toBeNull();
    expect(dailyCompletionCap(true, null, null)).toBeNull();
  });
});

describe('keepKnownLongNumbers — long numbers must be real task numbers', () => {
  it('the threshold is one million', () => {
    expect(KNOWN_NUMBER_FROM).toBe(1_000_000);
  });

  it('a known task number is kept', () => {
    const kept = keepKnownLongNumbers(new Set(['1000042']), new Set(['1000042']));
    expect([...kept]).toEqual(['1000042']);
  });

  it.each(['1536601', '5005369', '5524618', '9937760'])(
    'unknown long numbers are dropped — %s',
    (id) => {
      expect(keepKnownLongNumbers(new Set([id]), new Set()).size).toBe(0);
    },
  );

  /** Six digits or fewer are outside this condition: older numbers have no task row */
  it.each(['193', '3218', '37933', '973065'])(
    'short numbers are kept without the list — %s',
    (id) => {
      expect([...keepKnownLongNumbers(new Set([id]), new Set())]).toEqual([id]);
    },
  );

  it('in a mixed set only the unknown long ones are dropped', () => {
    const kept = keepKnownLongNumbers(
      new Set(['37933', '1000042', '5524618', '973065']),
      new Set(['1000042']),
    );
    expect([...kept].sort()).toEqual(['1000042', '37933', '973065']);
  });

  it('with an empty list, long numbers are not kept', () => {
    expect(keepKnownLongNumbers(new Set(['1000042']), new Set()).size).toBe(0);
  });
});

describe('taskTargetOf — whose target is how much', () => {
  it("a person's own number wins when they have one", () => {
    expect(taskTargetOf(15, 25)).toBe(15);
  });

  it("the policy's number applies when they have none", () => {
    expect(taskTargetOf(null, 25)).toBe(25);
    expect(taskTargetOf(undefined, 25)).toBe(25);
  });

  /** `||` instead of `??` would break this: the owner could not switch a target off */
  it('0 means "target off" — it does not fall back to the policy', () => {
    expect(taskTargetOf(0, 25)).toBe(0);
  });

  it('0 when neither exists', () => {
    expect(taskTargetOf(null, null)).toBe(0);
    expect(taskTargetOf(undefined, undefined)).toBe(0);
  });

  it('a 0 in the policy applies too', () => {
    expect(taskTargetOf(null, 0)).toBe(0);
  });
});
