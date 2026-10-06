/**
 * **R26: sending the report automatically when a month is closed**, its pure rules.
 *
 * A separate file because mistakes here are silent: a wrong date range means
 * sending the wrong month's numbers, and nobody reading it could catch that;
 * the file would look perfect. So the decision logic is free of I/O, with tests.
 */

/**
 * `'2026-07'` → the first and last day of that month.
 *
 * The last day is **computed**, not assumed to be 30/31: in February (and leap
 * years) an assumed number would be off by up to two days, and those days'
 * hours would silently drop out of the report.
 *
 * `Date.UTC(y, m, 0)`: day "0" of the next month is the last day of this month.
 */
export function monthRange(yearMonth: string): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) throw new RangeError(`Not a month: ${yearMonth}`);

  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new RangeError(`Not a month: ${yearMonth}`);

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return {
    from: `${yearMonth}-01`,
    to: `${yearMonth}-${String(lastDay).padStart(2, '0')}`,
  };
}

export interface MonthCaptionInput {
  orgName: string;
  yearMonth: string;
  /** How many staff are in the report */
  people: number;
  /** Everyone's total counted hours */
  totalHours: number;
}

/**
 * The one or two lines that go with the file on Telegram.
 *
 * **No employee name is here, on purpose.** The message sits on Telegram's
 * servers and who is in that chat changes over time, so the caption has only
 * **totals**. The name-by-name figures are in the attached file, which has to
 * be downloaded deliberately to open (the same reasoning as the allowlist in
 * `ops.rules.ts`).
 *
 * No Markdown/HTML: a single `_` in the organisation's name would make the
 * whole call a 400.
 */
export function monthCaption(input: MonthCaptionInput): string {
  const hours = Math.round(input.totalHours);

  return (
    `${input.orgName} — ${input.yearMonth} is closed.\n` +
    `${input.people} staff · ${hours} hours counted.\n` +
    `Full sheet attached. Figures are locked for this month.`
  );
}

/**
 * The file name: ASCII, with dates, so that even with several months side by
 * side in a chat you can tell which is which at a glance.
 *
 * It uses the same format as `reportFilename()`
 * (`oxeio-<report>-<from>_<to>.<ext>`); with different names in two places,
 * answering "which file?" in support would be hard.
 */
export function monthReportName(yearMonth: string, ext: 'xlsx' | 'pdf'): string {
  const { from, to } = monthRange(yearMonth);
  return `oxeio-summary-${from}_${to}.${ext}`;
}
