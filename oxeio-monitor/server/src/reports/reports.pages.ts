import { buildPdf, tableOf, type PdfColumn, type PdfSpec } from './reports.pdf';
import { hoursText, personLabel, toPdfText } from './reports.pdf.text';
import { approximateHolidayNote } from './reports.types';
import type {
  AttendanceReport,
  DayStatus,
  DayType,
  ReportMeta,
  SummaryReport,
} from './reports.types';

/**
 * F06: what each PDF looks like (columns, widths, labels). For the same reason
 * `reports.sheets.ts` is separate from `reports.excel.ts`: "add a column" should
 * not mean touching the query code.
 *
 * **Labels are in English**. The reason is written in one place: the note at
 * the top of [reports.pdf.text.ts](./reports.pdf.text.ts). Only the result
 * matters here: pdfkit's built-in font prints non-Latin text **silently
 * blank**, so a non-Latin label would mean an empty header.
 *
 * The report → **print lines** conversion is pure (`attendanceLines`,
 * `summaryLines`) and entirely separate from pdfkit. Two reasons:
 *
 * 1. Where non-Latin characters get replaced is decided here, and can be tested
 *    without the DB or the PDF engine; a mistake would otherwise show up as a
 *    silent empty cell, not an error.
 * 2. The `lossy` flag must be known **before printing starts**, because whether
 *    the footnote is added depends on it. Learning it from a column's `value()`
 *    function would be too late: the notes would already be written.
 */

const DAY_TYPE_EN: Record<DayType, string> = {
  workday: 'Workday',
  weekly_off: 'Weekly off',
  holiday: 'Holiday',
};

const DAY_STATUS_EN: Record<DayStatus, string> = {
  worked: 'Worked',
  no_activity: 'No activity',
};

/**
 * Printed only when something really had to be replaced. Always shown, it would
 * be meaningless noise in an English-named office, and once noise stops being
 * read, nobody would read it on the day it really matters.
 */
const LOSSY_NOTE =
  'Some non-Latin text (names, departments) cannot be rendered with this PDF ' +
  'font. Names are shown as employee codes and other characters as "?". ' +
  'The Excel (xlsx) export carries the original text.';

/** The rule is written in reports without categories too, as it is on the sheet */
const CATEGORY_NOTE =
  'Hours here are attendance figures only. App/site categories never affect ' +
  'worked, credited or target hours.';

/**
 * The **print-friendly form** of `OVERTIME_NOTE` in `reports.types.ts`: the em
 * dash (—) exists in WinAnsi, but a plain hyphen is used here to keep the
 * variety of bytes in the printed text low (the rule in reports.pdf.text.ts).
 * The two say the same thing: if one changes the other must too, or one day
 * xlsx and PDF would state two different policies (O4).
 *
 * **O4 is settled**: there is **no** separate rate. So it no longer says "not
 * decided yet" but "no separate rate" ([reports.types.ts](reports.types.ts)).
 */
const OVERTIME_NOTE_EN =
  'Overtime hours are not converted to money - there is no separate ' +
  'overtime rate.';

/**
 * On the printed page **three numbers answer three different questions**;
 * without this sentence a reader would subtract to reconcile and think the
 * figures were wrong.
 *
 * It cannot go in the column headers: PDF column widths are fixed in pixels
 * and a long header would be cut off. So it is a footnote, but one that
 * **must be there**, because people trust the paper, and in the last round the
 * paper complained of a shortfall that was really days before the agent was
 * installed.
 */
const SHORTFALL_NOTE_EN =
  'Target (h) covers every day shown. Shortfall (h) is measured only against ' +
  'what was expected by yesterday - days before tracking started, and today, ' +
  'are never counted as a shortfall. Overtime (h) is hours beyond the full ' +
  'target for the days shown.';

// ── Print lines (pure) ───────────────────────────────────────────────────────

/**
 * All the `toPdfText` calls in one place, so the answer to "did anything get
 * replaced?" comes from a single place. If every call site matched `lossy`
 * separately, one forgotten call would mean a silently lost footnote.
 */
class Printable {
  lossy = false;

  text(value: string | null | undefined): string {
    const out = toPdfText(value);
    if (out.lossy) this.lossy = true;
    return out.text;
  }

  person(fullName: string, empCode: string): string {
    const out = personLabel(fullName, empCode);
    if (out.lossy) this.lossy = true;
    return out.text;
  }
}

export interface AttendanceLine {
  empCode: string;
  name: string;
  department: string;
  date: string;
  dayType: string;
  status: string;
  worked: string;
  /** presence (first to last use, minus long pauses), beside worked as in the xlsx */
  presence: string;
  adjust: string;
  credited: string;
  target: string;
}

export interface Lines<T> {
  lines: T[];
  /** At least one cell's text had to be changed: a footnote is needed */
  lossy: boolean;
}

export function attendanceLines(
  report: AttendanceReport,
): Lines<AttendanceLine> {
  const p = new Printable();

  const lines = report.rows.map((r) => ({
    empCode: p.text(r.empCode),
    name: p.person(r.fullName, r.empCode),
    department: p.text(r.department),
    date: r.date,
    /**
     * **G130**: a leave day is printed on paper as "On leave".
     *
     * There is no room to add a column in the PDF (A4 already has eleven), so the
     * information goes **in the Day type cell**. Leave is an event on a work
     * day, but the reader's question is "what was that day for them", and for
     * them that day was leave.
     *
     * `status` is untouched: if someone works on a leave day it still says
     * "Worked" there, and the two facts can be read side by side. Put into
     * `status`, those hours would vanish from the paper.
     *
     * In JSON the two fields stay separate (`onLeave`); this merging is purely a
     * **print** decision, so it lives here, not in `reports.attendance.service.ts`.
     */
    dayType: r.onLeave ? 'On leave' : DAY_TYPE_EN[r.dayType],
    status: DAY_STATUS_EN[r.status],
    worked: hoursText(r.workedHours),
    presence: hoursText(r.presenceHours),
    adjust: hoursText(r.adjustmentHours),
    credited: hoursText(r.creditedHours),
    target: hoursText(r.targetHours),
  }));

  return { lines, lossy: p.lossy };
}

export interface SummaryLine {
  empCode: string;
  name: string;
  bucket: string;
  from: string;
  to: string;
  workdays: string;
  daysWithWork: string;
  worked: string;
  credited: string;
  target: string;
  shortfall: string;
  overtime: string;
}

export function summaryLines(report: SummaryReport): Lines<SummaryLine> {
  const p = new Printable();

  const lines = report.rows.map((r) => ({
    empCode: p.text(r.empCode),
    name: p.person(r.fullName, r.empCode),
    bucket: r.bucket,
    from: r.bucketStart,
    to: r.bucketEnd,
    // Day counts do not use `hoursText`: "9.00 workdays" reads oddly, and
    // would be confused with the hours columns
    workdays: String(r.workdays),
    daysWithWork: String(r.daysWithWork),
    worked: hoursText(r.workedHours),
    credited: hoursText(r.creditedHours),
    target: hoursText(r.targetHours),
    shortfall: hoursText(r.shortfallHours),
    overtime: hoursText(r.overtimeHours),
  }));

  return { lines, lossy: p.lossy };
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/** F01: attendance PDF */
export function attendancePdf(
  report: AttendanceReport,
  orgName: string,
): Promise<Buffer> {
  const { lines, lossy } = attendanceLines(report);

  const columns: PdfColumn<AttendanceLine>[] = [
    { header: 'Emp code', width: 58, value: (r) => r.empCode },
    { header: 'Name', width: 140, value: (r) => r.name },
    { header: 'Department', width: 90, value: (r) => r.department },
    { header: 'Date', width: 60, value: (r) => r.date },
    { header: 'Day type', width: 66, value: (r) => r.dayType },
    { header: 'Status', width: 62, value: (r) => r.status },
    right('Worked (h)', 56, (r) => r.worked),
    right('Presence (h)', 62, (r) => r.presence),
    right('Adjust (h)', 56, (r) => r.adjust),
    right('Credited (h)', 62, (r) => r.credited),
    right('Target (h)', 58, (r) => r.target),
  ];

  return buildPdf({
    letterhead: letterhead(orgName, 'Attendance report (F01)', report.meta),
    table: tableOf(columns, lines),
    totals: [
      ['Employees', String(report.totals.employees)],
      ['Days with work', String(report.totals.daysWithWork)],
      ['Total worked (h)', hoursText(report.totals.workedHours)],
      ['Total credited (h)', hoursText(report.totals.creditedHours)],
      // "days listed": this is the sum of the Target column above, not "how much
      // was due up to now" (see the note on `AttendanceReport.totals`)
      ['Total target - days listed (h)', hoursText(report.totals.targetHours)],
    ],
    notes: notesFor(report.meta, lossy, [CATEGORY_NOTE]),
  });
}

/** F02: weekly / monthly summary PDF */
export function summaryPdf(
  report: SummaryReport,
  orgName: string,
): Promise<Buffer> {
  const { lines, lossy } = summaryLines(report);
  const monthly = report.groupBy === 'month';

  const columns: PdfColumn<SummaryLine>[] = [
    { header: 'Emp code', width: 58, value: (r) => r.empCode },
    { header: 'Name', width: 140, value: (r) => r.name },
    { header: monthly ? 'Month' : 'Week', width: 62, value: (r) => r.bucket },
    { header: 'From', width: 60, value: (r) => r.from },
    { header: 'To', width: 60, value: (r) => r.to },
    right('Workdays', 52, (r) => r.workdays),
    right('Days worked', 56, (r) => r.daysWithWork),
    right('Worked (h)', 52, (r) => r.worked),
    right('Credited (h)', 56, (r) => r.credited),
    right('Target (h)', 52, (r) => r.target),
    right('Shortfall (h)', 60, (r) => r.shortfall),
    right('Overtime (h)', 62, (r) => r.overtime),
  ];

  return buildPdf({
    letterhead: letterhead(
      orgName,
      `Work summary (F02) - ${monthly ? 'monthly' : 'weekly'}`,
      report.meta,
    ),
    table: tableOf(columns, lines),
    notes: notesFor(report.meta, lossy, [
      // The shortfall sentence **first**, because looking at the paper people
      // ask about that column before anything else
      SHORTFALL_NOTE_EN,
      // The note stays inside the file: if it were only in the JSON, someone who
      // prints the PDF and takes it to a meeting would not know, and would put
      // in a rate of their own (O4)
      OVERTIME_NOTE_EN,
      CATEGORY_NOTE,
    ]),
  });
}

function right<T>(
  header: string,
  width: number,
  value: (row: T) => string,
): PdfColumn<T> {
  return { header, width, align: 'right', value };
}

function letterhead(
  orgName: string,
  reportTitle: string,
  meta: ReportMeta,
): PdfSpec['letterhead'] {
  return {
    orgName: toPdfText(orgName).text,
    reportTitle,
    rangeFrom: meta.from,
    rangeTo: meta.to,
    generatedAt: meta.generatedAt,
  };
}

/**
 * Footnotes for every PDF.
 *
 * Clamping (`clampedToToday`) and excluded staff must both be **inside the
 * file**. In Excel they are on the "Info" sheet, but a PDF has no separate
 * sheet; left out, someone would think "up to 31 August" and make decisions on
 * data only up to the 11th.
 */
/**
 * `export` is only for tests; nobody outside calls it. The reason: pdfkit
 * compresses the text inside the generated PDF, so searching the buffer to
 * verify "did the note reach the paper" is not possible. Without exporting,
 * this function would have **no assertion at all**, and everything would stay
 * green even if the note were lost.
 */
export function notesFor(
  meta: ReportMeta,
  lossy: boolean,
  extra: string[],
): string[] {
  const notes: string[] = [];

  if (meta.clampedToToday) {
    notes.push(
      `Requested up to ${meta.requestedTo}; future dates were dropped and the ` +
        `report ends at ${meta.to}.`,
    );
  }

  if (meta.excludedEmployees.length > 0) {
    const names = meta.excludedEmployees.map((n) => toPdfText(n).text).join(', ');
    notes.push(
      `Excluded (marked inactive with no leaving date): ${names}. ` +
        'These employees have no rows in this report.',
    );
  }

  /**
   * G108: the uncertainty is written on the printed paper itself.
   *
   * The paper goes to meetings, where there is neither JSON nor a screen. O4's
   * overtime note was put in the PDF for exactly this reason; otherwise someone
   * would put in a rate of their own.
   *
   * The number comes from `meta`, not counted again; otherwise there would be
   * a second definition of uncertainty.
   */
  const approx = approximateHolidayNote(meta.approximateHolidayDates);
  if (approx !== null) notes.push(approx);

  if (lossy) notes.push(LOSSY_NOTE);

  return [...notes, ...extra];
}
