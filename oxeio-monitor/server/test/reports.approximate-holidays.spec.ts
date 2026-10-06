import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';

import { notesFor } from '../src/reports/reports.pages';
import {
  APPROX_HOLIDAY_SUFFIX,
  approximateHolidayDates,
} from '../src/reports/reports.range';
import { summaryWorkbook } from '../src/reports/reports.sheets';
import {
  approximateHolidayNote,
  type ReportMeta,
  type SummaryReport,
} from '../src/reports/reports.types';

/**
 * G108: does the message "holiday dates are not final yet" reach the place
 * where the decision is made?
 *
 * This file is the real deliverable of G108, not the wiring. `approximateHolidayDates()`
 * had long returned the right numbers and had its own unit test
 * (`holidays.spec.ts`); the problem was that nobody read it. Nothing in the
 * repo asserted on that value, so the warning could vanish from Excel or PDF
 * and every test would stay green. G117 caught exactly this gap (09-Build-Log
 * section 3).
 *
 * So this does not test "the function gives the right answer"; it tests the
 * path: value to the Excel Info sheet, value to the PDF footnote, and whether
 * the two paths say the same text.
 */

const APPROX = '2026-08-26';
const APPROX_2 = '2026-09-15';

function meta(over: Partial<ReportMeta> = {}): ReportMeta {
  return {
    from: '2026-08-01',
    to: '2026-08-31',
    requestedTo: '2026-08-31',
    clampedToToday: false,
    days: 31,
    generatedAt: '2026-08-31T12:00:00.000Z',
    excludedEmployees: [],
    targetHoursInRange: {},
    expectedHours: {},
    approximateHolidayDates: [],
    // nobody in the sample is 'unobserved': this fixture makes no claim about G110/G111
    observed: {},
    trackedFrom: {},
    ...over,
  };
}

function summary(m: ReportMeta): SummaryReport {
  return {
    meta: m,
    groupBy: 'month',
    overtimeNote: 'x',
    rows: [
      {
        employeeId: 1,
        empCode: 'OX-001',
        fullName: 'Jane Doe',
        bucket: '2026-08',
        bucketStart: '2026-08-01',
        bucketEnd: '2026-08-31',
        workdays: 27,
        daysWithWork: 26,
        workedHours: 210,
        adjustmentHours: 0,
        creditedHours: 210,
        targetHours: 216,
        shortfallHours: 6,
        overtimeHours: 0,
      },
    ],
  };
}

/** Re-reads the generated workbook and returns the rows of the "Info" sheet */
async function infoSheetRows(m: ReportMeta): Promise<[string, string][]> {
  const buffer = await summaryWorkbook(summary(m));

  // The buffer is parsed again: calling `infoRows()` directly would prove
  // "the function builds the rows", not "the row reaches the file". Forgetting
  // to add the sheet would still leave the test green.
  const wb = new Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = wb.getWorksheet('Info');
  expect(sheet, 'ওয়ার্কবুকে "Info" শিটই নেই').toBeDefined();

  const rows: [string, string][] = [];
  sheet!.eachRow((row) => {
    rows.push([
      String(row.getCell(1).value ?? ''),
      String(row.getCell(2).value ?? ''),
    ]);
  });
  return rows;
}

describe('G108: warning text', () => {
  it('nothing is said when there are no approximate dates', () => {
    // `null`, not `''`: callers decide on `!== null`; returning an empty
    // string would add a blank "Note" row to every report.
    expect(approximateHolidayNote([])).toBeNull();
  });

  it('singular for one date, plural for several', () => {
    const one = approximateHolidayNote([APPROX])!;
    expect(one).toContain('1 holiday date');
    expect(one).toContain('is not final yet');

    const two = approximateHolidayNote([APPROX, APPROX_2])!;
    expect(two).toContain('2 holiday dates');
    expect(two).toContain('are not final yet');
  });

  it('the dates themselves are in the text: the reader knows which day may move', () => {
    const note = approximateHolidayNote([APPROX, APPROX_2])!;
    expect(note).toContain(APPROX);
    expect(note).toContain(APPROX_2);
  });

  it('it also says what may move: target hours and payroll', () => {
    // Saying only "dates are not final" would make readers think it is just a
    // calendar matter. The real risk: if the month's workdays change, `d / D`
    // changes, so the money changes.
    const note = approximateHolidayNote([APPROX])!;
    expect(note).toMatch(/working days/i);
    expect(note).toMatch(/target hours/i);
    expect(note).toMatch(/payroll/i);
  });
});

describe('G108: reaches the inside of the Excel file', () => {
  it('with approximate dates, the row appears in the Info sheet', async () => {
    const rows = await infoSheetRows(
      meta({ approximateHolidayDates: [APPROX] }),
    );
    const row = rows.find(([label]) => label === 'Holiday dates not final');

    expect(row, 'Info শিটে সতর্কবার্তার সারিই নেই').toBeDefined();
    expect(row![1]).toBe(approximateHolidayNote([APPROX]));
  });

  it('without them, there is no row either', async () => {
    const rows = await infoSheetRows(meta());
    expect(rows.map(([label]) => label)).not.toContain(
      'Holiday dates not final',
    );
  });
});

describe('G108: reaches the PDF footnote', () => {
  it('with approximate dates, the note is added', () => {
    const notes = notesFor(
      meta({ approximateHolidayDates: [APPROX] }),
      false,
      [],
    );
    expect(notes).toContain(approximateHolidayNote([APPROX]));
  });

  it('without them, it is not added', () => {
    expect(notesFor(meta(), false, [])).toEqual([]);
  });

  it('it survives next to other warnings: one does not suppress another', () => {
    // Clipping, excluded employees and uncertain holidays can all happen
    // together (late in the Eid month). It looks trivial because the code
    // `push`es, but if someone wrote `notes = [...]`, one would silently
    // disappear.
    const notes = notesFor(
      meta({
        clampedToToday: true,
        excludedEmployees: ['Ghost Employee'],
        approximateHolidayDates: [APPROX],
      }),
      true,
      ['extra note'],
    );

    expect(notes).toContain(approximateHolidayNote([APPROX]));
    expect(notes.some((n) => n.includes('future dates were dropped'))).toBe(
      true,
    );
    expect(notes.some((n) => n.includes('Ghost Employee'))).toBe(true);
    expect(notes).toContain('extra note');
  });
});

describe('G108: one text on every path', () => {
  it('Excel and PDF say exactly the same thing, character for character', async () => {
    // The equality is the real guard. With two separate sentences in two
    // places both would be right today, but one day one would change and the
    // other would say the old thing, and nobody comparing paper and sheet
    // could tell which is true.
    const m = meta({ approximateHolidayDates: [APPROX, APPROX_2] });

    const excel = (await infoSheetRows(m)).find(
      ([label]) => label === 'Holiday dates not final',
    )![1];
    const pdf = notesFor(m, false, []).find((n) => n.includes(APPROX))!;

    expect(excel).toBe(pdf);
  });

  it('the text comes from `meta`, it is not counted afresh', async () => {
    // If someone recounted from the holiday list at print time, there would be
    // a second definition of the uncertainty. Here `meta` holds a date that is
    // in no holiday list at all, and that date must still be printed.
    const invented = '2031-01-02';
    const rows = await infoSheetRows(
      meta({ approximateHolidayDates: [invented] }),
    );
    const row = rows.find(([label]) => label === 'Holiday dates not final')!;

    expect(row[1]).toContain(invented);
  });
});

describe('G108: the denominator and the warning come from the same rows', () => {
  it('the name marker on the rows used for counting workdays decides uncertainty', () => {
    // The marker lives in the DB row's name, not in a separate column: as soon
    // as the owner removes the marker in Settings > Holidays, the report goes
    // quiet.
    //
    // The marker is not hand-written here, it comes from the constant: the
    // seed writes it and the report reads it. Hand-writing it would let the
    // seed and the report drift apart on the day the constant changes, while
    // the test stayed green.
    const dates = approximateHolidayDates([
      {
        date: new Date('2026-08-26T00:00:00.000Z'),
        name: `Eid-e-Miladunnabi${APPROX_HOLIDAY_SUFFIX}`,
      },
      {
        date: new Date('2026-08-15T00:00:00.000Z'),
        name: 'National Mourning Day',
      },
    ]);

    expect(dates).toEqual([APPROX]);
    expect(approximateHolidayNote(dates)).toContain(APPROX);
  });
});
