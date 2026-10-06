import { describe, expect, it } from 'vitest';

import type { AttendanceReport, AttendanceRow, ReportMeta } from '../src/api/reports';
import { buildMonthGrid } from '../src/pages/monthly/heatmap';

/**
 * **G110 · G111**: do the picture and the number on the Monthly page say the same thing?
 *
 * Both defects are of one kind, which is why they share a file: **no error is
 * raised and no number is wrong**; one state just looks like another, and
 * people believe the disguise.
 *
 *   · G110: a day **before** tracking began looked like "did nothing on a
 *     workday" (a reddish tint). On the same page the number says "no claim",
 *     the picture says "slacking", and people look at the picture first.
 *   · G111: someone not yet observed on even one finished workday has a
 *     shortfall of 0, so the row says **"On track"**.
 *
 * Careful: before this file, `heatmap.ts` had **no tests at all**, though
 * nearly all of the page's rules live there.
 */

/** August 2026: Fridays are the 7th, 14th, 21st, 28th */
const MONTH = '2026-08';
const TRACKED_FROM = '2026-08-13';

function meta(over: Partial<ReportMeta> = {}): ReportMeta {
  return {
    from: '2026-08-01',
    to: '2026-08-20',
    requestedTo: '2026-08-20',
    clampedToToday: true,
    days: 20,
    generatedAt: '2026-08-20T12:00:00.000Z',
    excludedEmployees: [],
    targetHoursInRange: { 1: 168 },
    expectedHours: { 1: 40 },
    approximateHolidayDates: [],
    observed: { 1: true },
    trackedFrom: { 1: TRACKED_FROM },
    ...over,
  };
}

function row(over: Partial<AttendanceRow> & { date: string }): AttendanceRow {
  return {
    employeeId: 1,
    empCode: 'OX-01',
    fullName: 'Rakib Hasan',
    department: 'Design',
    dayType: 'workday',
    status: 'no_activity',
    // Careful: nobody in the sample is on leave; this fixture makes no claim about G130
    onLeave: false,
    designsDone: null,
    workedHours: 0,
    idleHours: 0,
    adjustmentHours: 0,
    creditedHours: 0,
    targetHours: 8,
    ...over,
  };
}

function report(
  rows: AttendanceRow[],
  metaOver: Partial<ReportMeta> = {},
): AttendanceReport {
  return {
    meta: meta(metaOver),
    rows,
    totals: {
      employees: 1,
      rows: rows.length,
      workedHours: 0,
      creditedHours: 0,
      targetHours: 0,
      daysWithWork: 0,
    },
  };
}

/** A row for every day from 1 to 20 August: the Fridays are the weekly day off */
function wholeRange(): AttendanceRow[] {
  const rows: AttendanceRow[] = [];
  for (let d = 1; d <= 20; d += 1) {
    const date = `2026-08-${String(d).padStart(2, '0')}`;
    const friday = d === 7 || d === 14;
    rows.push(
      row({
        date,
        dayType: friday ? 'weekly_off' : 'workday',
        targetHours: friday ? 0 : 8,
      }),
    );
  }
  return rows;
}

const cellOn = (grid: ReturnType<typeof buildMonthGrid>, date: string) =>
  grid.rows[0].cells.find((c) => c.date === date)!;

/**
 * **The rest of G130: approved leave on the heatmap too.**
 *
 * Careful: **the gap this describe guards:** the server sent `onLeave` (G130),
 * and the report row even said *"On leave"*, but `buildMonthGrid()` **never
 * copied the field** into the cell, so the heatmap could not know. On a leave day
 * `dayType` is `workday` (that is the **office** calendar, not one person's)
 * and the hours are 0, so the cell got *"nothing done on a workday"*, a **reddish
 * slacking mark**.
 *
 * Exactly like G110: the number was not lying, the picture was.
 */
describe('G130 — approved leave days on the heatmap', () => {
  /** The real guard: does the field actually travel from row to cell */
  it('`onLeave` reaches the cell of a leave day', () => {
    const rows = wholeRange().map((r) =>
      r.date === '2026-08-18' ? { ...r, onLeave: true, targetHours: 0 } : r,
    );

    const grid = buildMonthGrid(report(rows), MONTH);

    expect(cellOn(grid, '2026-08-18').onLeave).toBe(true);
  });

  /**
   * Careful: **the first test alone is not enough without the second**: it
   * would stay green even if it always returned `true`. That the other days
   * are `false` proves the number really comes from the row.
   */
  it('`onLeave` is false on a day that is not leave', () => {
    const rows = wholeRange().map((r) =>
      r.date === '2026-08-18' ? { ...r, onLeave: true, targetHours: 0 } : r,
    );

    const grid = buildMonthGrid(report(rows), MONTH);

    expect(cellOn(grid, '2026-08-17').onLeave).toBe(false);
    expect(cellOn(grid, '2026-08-19').onLeave).toBe(false);
  });

  /**
   * Careful: a leave day does not become `untracked`: tracking was running,
   *    the person was just on leave. Mixing the two up would make the cell say the wrong thing again.
   */
  it('a leave day is an ordinary day, not `untracked`', () => {
    const rows = wholeRange().map((r) =>
      r.date === '2026-08-18' ? { ...r, onLeave: true, targetHours: 0 } : r,
    );

    expect(cellOn(buildMonthGrid(report(rows), MONTH), '2026-08-18').kind).toBe(
      'day',
    );
  });
});

describe('G110 — the days before tracking began', () => {
  it('an earlier workday is `untracked`, the next is an ordinary `day`', () => {
    const grid = buildMonthGrid(report(wholeRange()), MONTH);

    // 12 August: the day before tracking began
    expect(cellOn(grid, '2026-08-12').kind).toBe('untracked');
    // 13 August: exactly the first day, no longer unobserved
    expect(cellOn(grid, '2026-08-13').kind).toBe('day');
  });

  it('a day off stays a day off: its look was already right', () => {
    // Careful: Friday 7 August, and even before tracking began. Still not `untracked`:
    //    a day off's own look never makes anyone seem a slacker, so there is no
    //    reason to change it. Changing it would lose information.
    const grid = buildMonthGrid(report(wholeRange()), MONTH);
    expect(cellOn(grid, '2026-08-07').kind).toBe('day');
    expect(cellOn(grid, '2026-08-07').dayType).toBe('weekly_off');
  });

  it('on an unobserved day, if the owner enters hours the day is no longer unobserved', () => {
    // Careful: this is the edge of the rule that is easiest to get wrong. Hours
    //    entered through an adjustment are truly counted hours; covering them with
    //    a dotted empty cell would make them vanish from the screen while staying
    //    in the total hours: picture and number saying two things again, only the opposite way.
    const rows = wholeRange().map((r) =>
      r.date === '2026-08-10'
        ? { ...r, adjustmentHours: 8, creditedHours: 8 }
        : r,
    );

    expect(cellOn(buildMonthGrid(report(rows), MONTH), '2026-08-10').kind).toBe(
      'day',
    );
  });

  it('never observed (`trackedFrom` null): every workday of the month is unobserved', () => {
    const grid = buildMonthGrid(
      report(wholeRange(), { trackedFrom: { 1: null } }),
      MONTH,
    );

    const workdayCells = grid.rows[0].cells.filter(
      (c) => c.dayType === 'workday',
    );
    expect(workdayCells.length).toBeGreaterThan(0);
    expect(workdayCells.every((c) => c.kind === 'untracked')).toBe(true);
  });

  it('an unobserved cell changes neither total hours nor expectation', () => {
    // Careful: this is a pure drawing change: if even one number moves, it is not G110 but a new bug.
    const drawn = buildMonthGrid(report(wholeRange()), MONTH);
    const blind = buildMonthGrid(
      report(wholeRange(), { trackedFrom: {} }),
      MONTH,
    );

    expect(drawn.rows[0].creditedHours).toBe(blind.rows[0].creditedHours);
    expect(drawn.rows[0].expectedHours).toBe(blind.rows[0].expectedHours);
    expect(drawn.rows[0].paceHours).toBe(blind.rows[0].paceHours);
  });

  it('expectation is still the server number, not counted from `trackedFrom`', () => {
    // This test is the real guard of G110. The date was sent **only for
    //    drawing**, and the easiest mistake is to count expectation with it again:
    //    that is exactly how the earlier bug was born. Here `expectedHours` is a
    //    number that counting by the date could never produce.
    const grid = buildMonthGrid(
      report(wholeRange(), { expectedHours: { 1: 3.5 } }),
      MONTH,
    );

    expect(grid.rows[0].expectedHours).toBe(3.5);
  });
});

describe('G111 — someone not yet observed', () => {
  it('`observed` comes straight from the server meta', () => {
    const seen = buildMonthGrid(report(wholeRange()), MONTH);
    expect(seen.rows[0].observed).toBe(true);

    const unseen = buildMonthGrid(
      report(wholeRange(), { observed: { 1: false } }),
      MONTH,
    );
    expect(unseen.rows[0].observed).toBe(false);
  });

  it('if meta is silent, "observed" is assumed', () => {
    // Careful: the other way round, against an old server the whole page would
    //    show "nobody has figures"; the numbers would stay right, only the explanation would be false.
    const grid = buildMonthGrid(report(wholeRange(), { observed: {} }), MONTH);
    expect(grid.rows[0].observed).toBe(true);
  });

  it('an unobserved person is not counted as "behind" either, but counted separately', () => {
    // Careful: their `paceHours` is exactly 0, so they do not fall into the
    //    "behind" list, and that was the trap: they would silently go into the
    //    "fine" group. Instead of putting them in either list, they are counted in a third cell.
    const grid = buildMonthGrid(
      report(wholeRange(), { observed: { 1: false }, expectedHours: { 1: 0 } }),
      MONTH,
    );

    expect(grid.totals.behind).toBe(0);
    expect(grid.totals.notObserved).toBe(1);
  });

  it('an observed person who is behind is "behind" as before', () => {
    const grid = buildMonthGrid(
      report(wholeRange(), { observed: { 1: true }, expectedHours: { 1: 40 } }),
      MONTH,
    );

    expect(grid.totals.behind).toBe(1);
    expect(grid.totals.notObserved).toBe(0);
  });

  it('a shortfall of 0 and unobserved: the same in number, different in state', () => {
    // This equality is the whole reason for G111. The two grids' `paceHours`
    //    are exactly the same (0), yet one person was observed and the other was
    //    not. Without the flag the screen sees these two states as **completely
    //    identical**, and both would read "On track".
    const met = buildMonthGrid(
      report(
        wholeRange().map((r) =>
          r.dayType === 'workday' ? { ...r, creditedHours: 8, workedHours: 8 } : r,
        ),
        // 18 workdays in 1-20 August (the 7th and 14th are Fridays) x 8h = 144: exactly met
        { observed: { 1: true }, expectedHours: { 1: 144 } },
      ),
      MONTH,
    );
    const unseen = buildMonthGrid(
      report(wholeRange(), { observed: { 1: false }, expectedHours: { 1: 0 } }),
      MONTH,
    );

    expect(met.rows[0].paceHours).toBe(0);
    expect(unseen.rows[0].paceHours).toBe(0);
    expect(met.rows[0].observed).not.toBe(unseen.rows[0].observed);
  });
});
