import { describe, expect, it } from 'vitest';

import {
  attendanceLines,
  attendancePdf,
  summaryLines,
  summaryPdf,
} from '../src/reports/reports.pages';
import {
  MIME_OF,
  PDF_MIME,
  reportFilename,
} from '../src/reports/reports.download';
import {
  workStamp,
  EMPTY_CELL,
  hoursText,
  personLabel,
  toPdfText,
  truncateToWidth,
  truncationNote,
  UNPRINTABLE,
} from '../src/reports/reports.pdf.text';
import type {
  AttendanceReport,
  ReportMeta,
  SummaryReport,
} from '../src/reports/reports.types';

/**
 * F06: PDF export.
 *
 * Almost everything tested here is a mistake that would raise no error: a
 * cell would just be blank on the printed paper, or a warning would vanish.
 * No database is needed, so these run quietly.
 */

const meta: ReportMeta = {
  from: '2026-08-01',
  to: '2026-08-11',
  requestedTo: '2026-08-11',
  clampedToToday: false,
  days: 11,
  generatedAt: '2026-08-11T12:34:56.000Z',
  excludedEmployees: [],
  targetHoursInRange: {},
  expectedHours: {},
  // This sample world has no holidays, so empty: "no approximate dates"
  approximateHolidayDates: [],
  // nobody in the sample is 'unobserved': this fixture makes no claim about G110/G111
  observed: {},
  trackedFrom: {},
};

function attendance(over: Partial<AttendanceReport> = {}): AttendanceReport {
  return {
    meta,
    rows: [
      {
        employeeId: 1,
        empCode: 'OX-001',
        fullName: 'Jane Doe',
        receivesTasks: false,
    department: 'Support',
        date: '2026-08-11',
        dayType: 'workday',
        status: 'worked',
        // nobody in the sample is on leave: this fixture makes no claim about G130
        onLeave: false,
        workedHours: 7.5,
        presenceHours: 7.5,
        idleHours: 0.5,
        adjustmentHours: 0,
    tasksDone: null,
    creditedHours: 7.5,
        targetHours: 8,
      },
    ],
    totals: {
      employees: 1,
      rows: 1,
      workedHours: 7.5,
      creditedHours: 7.5,
      targetHours: 8,
      daysWithWork: 1,
    },
    ...over,
  };
}

function summary(over: Partial<SummaryReport> = {}): SummaryReport {
  return {
    meta,
    groupBy: 'month',
    overtimeNote: 'x',
    rows: [
      {
        employeeId: 1,
        empCode: 'OX-001',
        fullName: 'Jane Doe',
        bucket: '2026-08',
        bucketStart: '2026-08-01',
        bucketEnd: '2026-08-11',
        workdays: 9,
        daysWithWork: 8,
        workedHours: 62.5,
        adjustmentHours: 1,
        creditedHours: 63.5,
        targetHours: 72,
        shortfallHours: 8.5,
        overtimeHours: 0,
      },
    ],
    ...over,
  };
}

describe('toPdfText: which text can be printed at all', () => {
  it('ASCII characters stay intact', () => {
    expect(toPdfText('OX-001 Jane Doe')).toEqual({
      text: 'OX-001 Jane Doe',
      lossy: false,
    });
  });

  it('Latin-1 accents can be printed: European names are not dropped', () => {
    expect(toPdfText('Ábel Kovács')).toEqual({
      text: 'Ábel Kovács',
      lossy: false,
    });
  });

  it('non-Latin letters (CJK) become ? and it reports lossy', () => {
    const out = toPdfText('山田太郎');
    expect(out.lossy).toBe(true);
    // not removed: an empty string would look the same as "no name"
    expect(out.text).toBe(UNPRINTABLE.repeat('山田太郎'.length));
    expect(out.text.length).toBeGreaterThan(0);
  });

  it('null and empty string give an empty cell, not lossy', () => {
    expect(toPdfText(null)).toEqual({ text: EMPTY_CELL, lossy: false });
    expect(toPdfText('')).toEqual({ text: EMPTY_CELL, lossy: false });
    expect(toPdfText(undefined)).toEqual({ text: EMPTY_CELL, lossy: false });
  });

  it('Unicode punctuation becomes ASCII, but is not lossy', () => {
    // These exist in WinAnsi but are still replaced: two kinds of byte for
    // the same dash would make width measurement unpredictable
    expect(toPdfText('“a” – b… ‘c’')).toEqual({
      text: '"a" - b... \'c\'',
      lossy: false,
    });
  });

  it('NBSP becomes a normal space: same look in print, different measure', () => {
    expect(toPdfText('a b').text).toBe('a b');
  });
});

describe('personLabel: what goes in the cell for a non-Latin name', () => {
  it('a printable name stays as it is', () => {
    expect(personLabel('Jane Doe', 'OX-001')).toEqual({
      text: 'Jane Doe',
      lossy: false,
    });
  });

  it('a non-Latin name is replaced by the employee code, not a row of question marks', () => {
    // Nobody could recognise an employee from ???????; the code is in the
    // next column anyway and everybody knows it
    expect(personLabel('山田太郎', 'OX-004')).toEqual({
      text: 'OX-004',
      lossy: true,
    });
  });

  it('if even the code cannot be printed, a marker is used, not blank', () => {
    const out = personLabel('山田太郎', 'コード');
    expect(out.lossy).toBe(true);
    expect(out.text).toContain(UNPRINTABLE);
  });
});

describe('truncateToWidth: text must not spill out of the cell', () => {
  // a simple measure: one character = 10pt
  const measure = (s: string): number => s.length * 10;

  it('unchanged if it fits', () => {
    expect(truncateToWidth('abc', 100, measure)).toBe('abc');
  });

  it('cut with ... if it does not fit, so the cut is visible', () => {
    expect(truncateToWidth('abcdefgh', 60, measure)).toBe('abc...');
  });

  it('if even ... does not fit, as much raw text as fits', () => {
    expect(truncateToWidth('abcdefgh', 25, measure)).toBe('ab');
  });

  it('empty for zero or negative width, not an infinite loop', () => {
    expect(truncateToWidth('abc', 0, measure)).toBe('');
    expect(truncateToWidth('abc', -5, measure)).toBe('');
  });
});

describe('hoursText and workStamp', () => {
  it('hours always have two decimals, so decimal points line up in a column', () => {
    expect(hoursText(7)).toBe('7.00');
    expect(hoursText(7.5)).toBe('7.50');
    expect(hoursText(-0.25)).toBe('-0.25');
  });

  it('infinite/NaN gives a blank cell: "NaN" is never printed', () => {
    expect(hoursText(Number.NaN)).toBe(EMPTY_CELL);
    expect(hoursText(Number.POSITIVE_INFINITY)).toBe(EMPTY_CELL);
  });

  it('creation time is in the work-zone clock, not the server timezone', () => {
    // 12:34 UTC = 18:34 in the test work zone (UTC+6)
    expect(workStamp(new Date('2026-08-11T12:34:56.000Z'))).toBe(
      '2026-08-11 18:34 (Etc/GMT-6)',
    );
  });

  it('around the UTC date change the work-zone date is a day ahead', () => {
    // 20:00 UTC on 11 August = 02:00 on 12 August in the work zone
    expect(workStamp(new Date('2026-08-11T20:00:00.000Z'))).toBe(
      '2026-08-12 02:00 (Etc/GMT-6)',
    );
  });
});

describe('truncationNote: dropped rows are not lost silently', () => {
  it('no note when all rows are shown', () => {
    expect(truncationNote(50, 50)).toBeNull();
    expect(truncationNote(10, 50)).toBeNull();
  });

  it('when cut, both numbers are written and Excel is mentioned', () => {
    const note = truncationNote(5000, 2000);
    expect(note).toContain('2000');
    expect(note).toContain('5000');
    expect(note).toMatch(/xlsx/i);
  });
});

describe('attendanceLines: report to print lines', () => {
  it('numbers with two decimals, labels in English', () => {
    const { lines, lossy } = attendanceLines(attendance());

    expect(lossy).toBe(false);
    expect(lines[0]).toMatchObject({
      empCode: 'OX-001',
      name: 'Jane Doe',
      department: 'Support',
      dayType: 'Workday',
      status: 'Worked',
      worked: '7.50',
      target: '8.00',
    });
  });

  it('a non-Latin name sets lossy, otherwise the footnote would never appear', () => {
    const report = attendance();
    report.rows[0].fullName = '山田太郎';

    const { lines, lossy } = attendanceLines(report);
    expect(lossy).toBe(true);
    expect(lines[0].name).toBe('OX-001');
  });

  it('a non-Latin department alone also sets lossy', () => {
    const report = attendance();
    report.rows[0].department = '技術部';

    const { lines, lossy } = attendanceLines(report);
    expect(lossy).toBe(true);
    // the name stays fine: only the department cell gets the marker
    expect(lines[0].name).toBe('Jane Doe');
    expect(lines[0].department).toContain(UNPRINTABLE);
  });

  it('no department gives a blank cell, not lossy', () => {
    const report = attendance();
    report.rows[0].department = null;

    const { lines, lossy } = attendanceLines(report);
    expect(lossy).toBe(false);
    expect(lines[0].department).toBe(EMPTY_CELL);
  });
});

describe('summaryLines', () => {
  it('day counts are integers, hours have two decimals', () => {
    const { lines } = summaryLines(summary());

    expect(lines[0]).toMatchObject({
      bucket: '2026-08',
      // "9.00 workdays" reads oddly and would be confused with hours
      workdays: '9',
      daysWithWork: '8',
      credited: '63.50',
      shortfall: '8.50',
      overtime: '0.00',
    });
  });
});

describe('file name and MIME', () => {
  it('the extension follows the format: a PDF is never saved as .xlsx', () => {
    expect(reportFilename('attendance', '2026-08-01', '2026-08-11', 'pdf')).toBe(
      'oxeio-attendance-2026-08-01_2026-08-11.pdf',
    );
    expect(reportFilename('summary', '2026-08-01', '2026-08-11', 'xlsx')).toBe(
      'oxeio-summary-2026-08-01_2026-08-11.xlsx',
    );
  });

  it('the name is entirely ASCII, so Content-Disposition does not break', () => {
    const name = reportFilename('attendance', '2026-08-01', '2026-08-11', 'pdf');
    expect(/^[\x20-\x7E]+$/.test(name)).toBe(true);
  });

  it('the MIME map has both', () => {
    expect(MIME_OF.pdf).toBe(PDF_MIME);
    expect(MIME_OF.xlsx).toContain('spreadsheetml');
  });
});

describe('PDF generation (pdfkit)', () => {
  it('real PDF bytes come out', async () => {
    const buffer = await attendancePdf(attendance(), 'oXeio Office');

    expect(buffer.byteLength).toBeGreaterThan(500);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('the summary too', async () => {
    const buffer = await summaryPdf(summary(), 'oXeio Office');
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('zero rows does not break it: an empty range is a valid result', async () => {
    const empty = attendance({
      rows: [],
      totals: {
        employees: 0,
        rows: 0,
        workedHours: 0,
        creditedHours: 0,
        targetHours: 0,
        daysWithWork: 0,
      },
    });

    const buffer = await attendancePdf(empty, 'oXeio Office');
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('many rows make several pages, still one file', async () => {
    const base = attendance();
    const many = attendance({
      rows: Array.from({ length: 300 }, () => ({ ...base.rows[0] })),
    });

    const buffer = await attendancePdf(many, 'oXeio Office');
    expect(buffer.byteLength).toBeGreaterThan(2000);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
