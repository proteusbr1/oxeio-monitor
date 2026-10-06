import {
  buildWorkbook,
  NUM_FMT_2,
  sheetOf,
  type ExcelColumn,
} from './reports.excel';
import {
  OVERTIME_NOTE,
  type AttendanceReport,
  type AttendanceRow,
  type DayStatus,
  type DayType,
  type ProductivityEmployeeRow,
  type ProductivityItem,
  type ProductivityReport,
  type ReportMeta,
  type SummaryReport,
  type SummaryRow,
  type UsageCategory,
  approximateHolidayNote,
} from './reports.types';

/**
 * F05: what each report's sheet looks like (columns, widths, labels).
 *
 * Kept apart from the service because changing column order or names is a
 * **presentation** decision, not a query one. In the same file, "add a column"
 * would mean reaching into the middle of the database code.
 *
 * The labels here are **for display only**; the JSON API carries machine-readable
 * values (`worked`, `weekly_off`). The other way round, the frontend would have
 * to write conditions matching display strings.
 */

const DAY_TYPE_LABEL: Record<DayType, string> = {
  workday: 'Workday',
  weekly_off: 'Weekly off',
  holiday: 'Holiday',
};

const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  worked: 'Worked',
  no_activity: 'No activity',
};

const CATEGORY_LABEL: Record<UsageCategory, string> = {
  productive: 'Productive',
  neutral: 'Neutral',
  unproductive: 'Unproductive',
  uncategorized: 'Uncategorized',
};

/** F01 */
export function attendanceWorkbook(report: AttendanceReport): Promise<Buffer> {
  const columns: ExcelColumn<AttendanceRow>[] = [
    { header: 'Emp code', width: 14, value: (r) => r.empCode },
    { header: 'Name', width: 26, value: (r) => r.fullName },
    // Type first: it is now the classification
    { header: 'Staff type', width: 14, value: (r) => r.staffType },
    // The cell was removed from the form, so it is empty for new employees
    { header: 'Department', width: 18, value: (r) => r.department },
    { header: 'Date', width: 13, value: (r) => r.date },
    { header: 'Day type', width: 16, value: (r) => DAY_TYPE_LABEL[r.dayType] },
    /**
     * **G130**: why no work was done that day is written on the paper itself.
     *
     * The neighbouring `Status` cell then says "No activity", and anyone reading
     * only that would assume the person did not come. Leave already fixed the
     * numbers (target 0), but the paper goes to meetings, where the row is read,
     * not the numbers.
     *
     * **The cell is empty when it is not leave**, not "No": "No" down a column
     * of 31 rows would make the eye stop reading it, and then the one or two
     * "Yes" entries would be lost.
     */
    { header: 'On leave', width: 10, value: (r) => (r.onLeave ? 'Yes' : null) },
    { header: 'Status', width: 16, value: (r) => DAY_STATUS_LABEL[r.status] },
    hours('Worked (hours)', (r: AttendanceRow) => r.workedHours),
    hours('Adjustment (hours)', (r: AttendanceRow) => r.adjustmentHours),
    hours('Credited (hours)', (r: AttendanceRow) => r.creditedHours),
    hours('Target (hours)', (r: AttendanceRow) => r.targetHours),
    hours('Idle (hours)', (r: AttendanceRow) => r.idleHours),
    /*
      The design count: the owner's target of 25.
      If the person is not a designer the cell is **empty**, not 0: in a
      spreadsheet 0 means "measured and found zero", which would be false here.
    */
    /**
     * How many designs were **completed** (the Complete button).
     *
     * Opening a file is **not** counted (owner's decision): that count could not
     * tell "the one who makes" from "the one who views".
     */
    { header: 'Designs', width: 10, value: (r: AttendanceRow) => r.designsDone },
  ];

  return buildWorkbook(
    [sheetOf('Attendance', columns, report.rows)],
    [
      ...infoRows('Attendance (F01)', report.meta),
      ['Total worked (hours)', String(report.totals.workedHours)],
      // The label says "days listed": this is the sum of the Target column above,
      // not "how much was due up to now". With only "Total target" a reader would
      // take it as the basis of the shortfall, though it includes days before the
      // agent was installed (see the note on `AttendanceReport.totals`).
      ['Total target · days listed (hours)', String(report.totals.targetHours)],
    ],
  );
}

/** F02 */
export function summaryWorkbook(report: SummaryReport): Promise<Buffer> {
  const monthly = report.groupBy === 'month';

  const columns: ExcelColumn<SummaryRow>[] = [
    { header: 'Emp code', width: 14, value: (r) => r.empCode },
    { header: 'Name', width: 26, value: (r) => r.fullName },
    { header: monthly ? 'Month' : 'Week', width: 14, value: (r) => r.bucket },
    { header: 'Start', width: 13, value: (r) => r.bucketStart },
    { header: 'End', width: 13, value: (r) => r.bucketEnd },
    { header: 'Workdays', width: 12, value: (r) => r.workdays },
    { header: 'Days with work', width: 16, value: (r) => r.daysWithWork },
    hours('Worked (hours)', (r: SummaryRow) => r.workedHours),
    hours('Adjustment (hours)', (r: SummaryRow) => r.adjustmentHours),
    hours('Credited (hours)', (r: SummaryRow) => r.creditedHours),
    // All three headers say clearly **what the number is measured against**:
    // the target covers these days, but the shortfall only covers days that were
    // observed and have finished. With just "Target/Shortfall" a reader would
    // subtract to reconcile and think the figures were wrong, though the two
    // answer two different questions (see the note on `SummaryRow`).
    hours('Target · days shown (hours)', (r: SummaryRow) => r.targetHours),
    hours(
      'Shortfall vs expected so far (hours)',
      (r: SummaryRow) => r.shortfallHours,
    ),
    hours(
      'Overtime beyond target (hours)',
      (r: SummaryRow) => r.overtimeHours,
    ),
  ];

  return buildWorkbook(
    [sheetOf('Summary', columns, report.rows)],
    [
      ...infoRows(
        `Summary (F02) · ${monthly ? 'Monthly' : 'Weekly'}`,
        report.meta,
      ),
      // The note stays inside the file. If it were only in the JSON, whoever opens
      // the sheet would not know, and would put in a rate of their own.
      ['Overtime hours', OVERTIME_NOTE],
    ],
  );
}

/** F04 */
export function productivityWorkbook(
  report: ProductivityReport,
): Promise<Buffer> {
  const appColumns: ExcelColumn<ProductivityItem>[] = [
    { header: 'App / site', width: 34, value: (r) => r.key },
    {
      header: 'Kind',
      width: 10,
      value: (r) => (r.kind === 'site' ? 'Site' : 'App'),
    },
    { header: 'Name', width: 24, value: (r) => r.displayName },
    { header: 'Category', width: 16, value: (r) => CATEGORY_LABEL[r.category] },
    {
      // The category next to it is then only the **biggest share**, not a single
      // truth: chrome.exe covers both github.com and youtube.com. Without this
      // column someone reading "chrome.exe — Productive" would feel reassured.
      header: 'Mixed category',
      width: 16,
      value: (r) => (r.mixed ? 'Yes' : '—'),
    },
    hours('Time (hours)', (r: ProductivityItem) => r.hours),
    {
      header: 'Share (%)',
      width: 12,
      numFmt: NUM_FMT_2,
      value: (r) => r.sharePct,
    },
  ];

  const employeeColumns: ExcelColumn<ProductivityEmployeeRow>[] = [
    { header: 'Emp code', width: 14, value: (r) => r.empCode },
    { header: 'Name', width: 26, value: (r) => r.fullName },
    hours(
      'Productive (hours)',
      (r: ProductivityEmployeeRow) => r.productiveHours,
    ),
    hours('Neutral (hours)', (r: ProductivityEmployeeRow) => r.neutralHours),
    hours(
      'Unproductive (hours)',
      (r: ProductivityEmployeeRow) => r.unproductiveHours,
    ),
    hours(
      'Uncategorized (hours)',
      (r: ProductivityEmployeeRow) => r.uncategorizedHours,
    ),
    hours(
      'Total tracked (hours)',
      (r: ProductivityEmployeeRow) => r.trackedHours,
    ),
    {
      header: 'Productive share (%)',
      width: 22,
      numFmt: NUM_FMT_2,
      value: (r) => r.productiveSharePct,
    },
    {
      // Score and uncategorised percentage **side by side**: if 90% of the time
      // is unknown, even a 100% score means nothing, yet the score alone looks great
      header: 'Productivity score (%)',
      width: 22,
      numFmt: NUM_FMT_2,
      // `null` when the categorised time is zero, not zero. In Excel the cell is
      // **empty**, and that is right: "0%" would say nobody was productive, when
      // the truth is there is nothing to say at all.
      value: (r) => r.productivityScorePct,
    },
    {
      header: 'Uncategorized share (%)',
      width: 24,
      numFmt: NUM_FMT_2,
      value: (r) => r.uncategorizedSharePct,
    },
  ];

  return buildWorkbook(
    [
      sheetOf('Top apps and sites', appColumns, report.top),
      sheetOf('By employee', employeeColumns, report.byEmployee),
    ],
    [
      ...infoRows('Productivity (F04)', report.meta),
      ['Total tracked time (hours)', String(report.totalTrackedHours)],
      ['Uncategorized time (hours)', String(report.uncategorizedHours)],
      // The product's hard rule is written on the sheet: whoever says "deduct the
      // unproductive hours" must stop to think that this number is not for salary.
      [
        'Note',
        'Categories are for viewing only — they have no effect on salary or target calculations',
      ],
    ],
  );
}

/** The hours column: always a number, shown with two decimals (F05's core rule) */
function hours<T>(header: string, value: (row: T) => number): ExcelColumn<T> {
  return { header, width: 22, numFmt: NUM_FMT_2, value };
}

/** The "Info" sheet of every workbook: range, truncation, excluded staff */
function infoRows(title: string, meta: ReportMeta): [string, string][] {
  const rows: [string, string][] = [
    ['Report', title],
    ['Range', `${meta.from} — ${meta.to}`],
    ['Days', String(meta.days)],
    ['Generated', meta.generatedAt],
  ];

  if (meta.clampedToToday) {
    // The clamping is written in the file; otherwise someone would think "up to
    // 31 August" and make decisions on data only up to the 11th
    rows.push([
      'Note',
      `Requested through ${meta.requestedTo}; future days were excluded, so this shows up to ${meta.to}`,
    ]);
  }

  if (meta.excludedEmployees.length > 0) {
    rows.push(['Excluded staff', meta.excludedEmployees.join(', ')]);
  }

  /**
   * G108: the uncertainty goes **inside the file**, not only in JSON.
   *
   * The numbers are not wrong, but they **rest on an assumption**, and until
   * now that was only in the holiday's *name* (`(সম্ভাব্য)`, "probable"), not in
   * the report. Whoever downloads the sheet and sends it to accounts would not
   * know that the month's work days, and so `d ÷ D`, can still move.
   *
   * The number comes from `meta` and is not counted again: counting would make a
   * **second definition of uncertainty**, and one day the report and payroll
   * would show two lists.
   */
  const approx = approximateHolidayNote(meta.approximateHolidayDates);
  if (approx !== null) rows.push(['Holiday dates not final', approx]);

  return rows;
}
