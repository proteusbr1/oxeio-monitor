import {
  buildWorkbook,
  NUM_FMT_2,
  sheetOf,
  type ExcelColumn,
} from '../reports/reports.excel';
import type { StatementMailLine } from './statement-mail';

export interface StatementDayRow {
  fullName: string;
  empCode: string;
  date: string;
  arrived: string | null;
  left: string | null;
  presenceHours: number;
  activeHours: number;
  adjustmentHours: number;
  creditedHours: number;
}

type SheetLine = StatementMailLine & {
  fromDate: string;
  toDate: string;
  measuredSec: number;
};

/** The statement as a spreadsheet: a summary sheet and the day-by-day detail (English, like the other reports) */
export function statementWorkbook(input: {
  start: string;
  end: string;
  lines: readonly SheetLine[];
  days: readonly StatementDayRow[];
}): Promise<Buffer> {
  const summary: ExcelColumn<SheetLine>[] = [
    { header: 'Emp code', width: 12, value: (l) => l.empCode },
    { header: 'Name', width: 26, value: (l) => l.fullName },
    { header: 'From', width: 12, value: (l) => l.fromDate },
    { header: 'To', width: 12, value: (l) => l.toDate },
    {
      header: 'Hours to post',
      width: 14,
      value: (l) => Math.trunc(l.toPostMin / 60),
    },
    { header: 'Minutes to post', width: 15, value: (l) => l.toPostMin % 60 },
    {
      header: 'Measured (hours)',
      width: 16,
      numFmt: NUM_FMT_2,
      value: (l) => l.measuredSec / 3600,
    },
    {
      header: 'Carried over (minutes)',
      width: 20,
      value: (l) => Math.trunc(l.carryInSec / 60),
    },
    { header: 'Leave days', width: 11, value: (l) => l.leaveDays },
    { header: 'Holidays', width: 10, value: (l) => l.holidayDays },
    { header: 'Workdays with no time', width: 20, value: (l) => l.noDataDays },
  ];
  const detail: ExcelColumn<StatementDayRow>[] = [
    { header: 'Emp code', width: 12, value: (d) => d.empCode },
    { header: 'Name', width: 26, value: (d) => d.fullName },
    { header: 'Date', width: 12, value: (d) => d.date },
    { header: 'First use', width: 10, value: (d) => d.arrived },
    { header: 'Last use', width: 10, value: (d) => d.left },
    {
      header: 'Presence (hours)',
      width: 16,
      numFmt: NUM_FMT_2,
      value: (d) => d.presenceHours,
    },
    {
      header: 'Active (hours)',
      width: 14,
      numFmt: NUM_FMT_2,
      value: (d) => d.activeHours,
    },
    {
      header: 'Adjustment (hours)',
      width: 18,
      numFmt: NUM_FMT_2,
      value: (d) => d.adjustmentHours,
    },
    {
      header: 'Credited (hours)',
      width: 16,
      numFmt: NUM_FMT_2,
      value: (d) => d.creditedHours,
    },
  ];
  return buildWorkbook(
    [
      sheetOf('Hours to post', summary, input.lines),
      sheetOf('Day by day', detail, input.days),
    ],
    [['Period', `${input.start} to ${input.end}`]],
  );
}
