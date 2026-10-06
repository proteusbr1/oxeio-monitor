import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';

import { attendanceLines } from '../src/reports/reports.pages';
import { attendanceWorkbook } from '../src/reports/reports.sheets';
import type {
  AttendanceReport,
  AttendanceRow,
  ReportMeta,
} from '../src/reports/reports.types';

/**
 * G130 (R2) — leave reached the numbers, not the labels.
 *
 * Leave already enters five places — the target, the expectation, the tray,
 * the Live Board, the reports — so nobody shows "behind" for leave any more.
 * But the paper said nothing like "On leave", so a leave day looked exactly
 * like a zero-hour work day: `Workday` · `No activity` · 0 hours. The
 * numbers were not lying, but they were not giving the reason — and to find
 * out "why did they not work that day" you had to go to Settings -> Leave.
 *
 * This file's claim is about printing, not calculation. The calculation is
 * guarded by `leave.spec.ts`; here we only check whether the truth reaches
 * the paper — exactly the gap this repo calls "the contract is written, the
 * caller is not".
 */

const meta: ReportMeta = {
  from: '2026-08-01',
  to: '2026-08-02',
  requestedTo: '2026-08-02',
  clampedToToday: false,
  days: 2,
  generatedAt: '2026-08-02T12:00:00.000Z',
  excludedEmployees: [],
  targetHoursInRange: {},
  expectedHours: {},
  approximateHolidayDates: [],
  observed: {},
  trackedFrom: {},
};

function row(over: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    employeeId: 1,
    empCode: 'OX-001',
    fullName: 'Jane Doe',
    receivesTasks: false,
    department: null,
    date: '2026-08-03',
    dayType: 'workday',
    status: 'no_activity',
    onLeave: false,
    workedHours: 0,
    idleHours: 0,
    adjustmentHours: 0,
    creditedHours: 0,
    tasksDone: null,
    targetHours: 0,
    ...over,
  };
}

function report(rows: AttendanceRow[]): AttendanceReport {
  return {
    meta,
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

/** Re-reads the built workbook and returns the Attendance sheet's headers and one row */
async function sheetRows(
  rows: AttendanceRow[],
): Promise<{ headers: string[]; cells: string[][] }> {
  // The buffer is parsed again — looking at the column definitions would not prove "it lands in the file"
  const wb = new Workbook();
  await wb.xlsx.load((await attendanceWorkbook(report(rows))) as unknown as ArrayBuffer);

  const sheet = wb.getWorksheet('Attendance');
  expect(sheet, 'the workbook has no "Attendance" sheet').toBeDefined();

  const all: string[][] = [];
  sheet!.eachRow((r) => {
    const line: string[] = [];
    r.eachCell({ includeEmpty: true }, (cell) => {
      line.push(String(cell.value ?? ''));
    });
    all.push(line);
  });

  return { headers: all[0], cells: all.slice(1) };
}

describe('G130 — the reason is written in the PDF row', () => {
  it('on a leave day the Day type cell says "On leave"', () => {
    const { lines } = attendanceLines(report([row({ onLeave: true })]));
    expect(lines[0].dayType).toBe('On leave');
  });

  it('when not on leave it is "Workday" as before', () => {
    const { lines } = attendanceLines(report([row()]));
    expect(lines[0].dayType).toBe('Workday');
  });

  /**
   * The place where it is easiest to go wrong.
   *
   * There is a temptation to put it in the `status` cell — that is where "No
   * activity" is written. But someone can work on a leave day too (section 4
   * — work on any day counts), and putting it in `status` would make those
   * hours vanish from the paper. Two different truths in two different cells.
   */
  it('working on a leave day keeps both facts — neither hides the other', () => {
    const { lines } = attendanceLines(
      report([
        row({
          onLeave: true,
          status: 'worked',
          workedHours: 3,
          creditedHours: 3,
        }),
      ]),
    );

    expect(lines[0].dayType).toBe('On leave');
    expect(lines[0].status).toBe('Worked');
    expect(lines[0].worked).toContain('3');
  });

  /**
   * The weekly holiday and personal leave are two different things. Merged,
   * the paper would not say whether the office was closed or one person was on leave.
   */
  it('the weekly holiday says its own thing', () => {
    const { lines } = attendanceLines(
      report([row({ dayType: 'weekly_off', onLeave: false })]),
    );
    expect(lines[0].dayType).toBe('Weekly off');
  });
});

describe('G130 — a separate column in Excel', () => {
  it('the "On leave" column is on the sheet', async () => {
    const { headers } = await sheetRows([row()]);
    expect(headers).toContain('On leave');
  });

  it('"Yes" on a leave row, empty on other rows', async () => {
    const { headers, cells } = await sheetRows([
      row({ date: '2026-08-03', onLeave: true }),
      row({ date: '2026-08-04', onLeave: false }),
    ]);

    const at = headers.indexOf('On leave');
    expect(at).toBeGreaterThanOrEqual(0);

    expect(cells[0][at]).toBe('Yes');
    /**
     * Empty, not "No" — and this is not a cosmetic decision. Writing "No"
     * down a 31-row column would make the eye stop reading it, and then the
     * one or two "Yes" would get lost — the column would be added and
     * achieve nothing.
     */
    expect(cells[1][at]).toBe('');
  });

  /**
   * The Day type cell is untouched in Excel, and that is deliberate.
   *
   * The PDF has no room for another column (A4 already has nine), so the
   * information went into the Day type cell there. Excel has no space
   * problem, so both cells stay intact — you can filter the sheet and count
   * "how many took leave on a work day", which merging would have made impossible.
   */
  it('Day type stays intact in Excel — can be filtered on the sheet', async () => {
    const { headers, cells } = await sheetRows([row({ onLeave: true })]);

    const dayType = headers.indexOf('Day type');
    expect(cells[0][dayType]).toBe('Workday');
  });
});
