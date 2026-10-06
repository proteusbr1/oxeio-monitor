import { Injectable } from '@nestjs/common';

import { WORK_TIMEZONE } from '../agent/util/work-time';
import { PrismaService } from '../prisma/prisma.service';
import { isOffWeekday } from '../summary/weekly-off';
import type { ReportRangeQuery } from './dto';
import { metaOf, ReportsContextService } from './reports.context.service';
import type { DownloadFormat } from './reports.download';
import { ReportsExportService } from './reports.export.service';
import { attendancePdf } from './reports.pages';
import {
  eachDate,
  isoDayOf,
  secondsToHours,
  toIsoDate,
  type WorkdayRule,
} from './reports.range';
import { attendanceWorkbook } from './reports.sheets';
import type {
  AttendanceReport,
  AttendanceRow,
  DayType,
  ReportFile,
} from './reports.types';

/** F01 · attendance: one row per employee per day, and its xlsx/pdf (F05/F06). */
@Injectable()
export class ReportsAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportContext: ReportsContextService,
    private readonly exporter: ReportsExportService,
  ) {}

  async attendance(q: ReportRangeQuery): Promise<AttendanceReport> {
    const ctx = await this.reportContext.context(q);
    const { range } = ctx;

    const daily = await this.prisma.dailySummary.findMany({
      where: {
        employeeId: { in: ctx.employees.map((e) => e.id) },
        workDate: { gte: range.from, lte: range.to },
      },
      select: {
        employeeId: true,
        workDate: true,
        workedSec: true,
        idleSec: true,
        adjustmentSec: true,
        creditedSec: true,
      },
    });

    const byKey = new Map(
      daily.map((d) => [`${d.employeeId}|${d.workDate.getTime()}`, d]),
    );

    /**
     * **How many tasks each person marked "finished" on each day.**
     *
     * `daily_summary` does not have this and should not: that table keeps time,
     * and this is about work. So it is read straight from `tasks`.
     *
     * `completed_at` is a timestamptz, and the rows must be split into **work
     * days**, hence the raw query; Prisma's `groupBy` cannot cut dates.
     *
     * **One query for the whole range**: counting per row separately would be
     * 30 days × 13 people = 390 queries (N+1).
     */
    const finishedRows = await this.prisma.$queryRaw<
      { employee_id: number; work_date: Date; n: number }[]
    >`
      SELECT assigned_to_id AS employee_id,
             (completed_at AT TIME ZONE ${WORK_TIMEZONE})::date AS work_date,
             count(*)::int AS n
        FROM tasks
       WHERE assigned_to_id = ANY(${ctx.employees.map((e) => e.id)}::int[])
         AND completed_at IS NOT NULL
         AND (completed_at AT TIME ZONE ${WORK_TIMEZONE})::date
             BETWEEN ${range.from}::date AND ${range.to}::date
       GROUP BY 1, 2
    `;

    /**
     * The key is the same as `daily_summary`'s: a UTC-midnight Date. The raw
     * query returns a `date`, so the hours and minutes are trimmed to the same shape.
     */
    const finishedByKey = new Map(
      finishedRows.map((r) => [
        `${r.employee_id}|${Date.UTC(
          r.work_date.getUTCFullYear(),
          r.work_date.getUTCMonth(),
          r.work_date.getUTCDate(),
        )}`,
        Number(r.n),
      ]),
    );

    const dates = eachDate(range.from, range.to);
    const rows: AttendanceRow[] = [];
    let workedSec = 0;
    let creditedSec = 0;
    let targetSec = 0;
    let daysWithWork = 0;

    for (const employee of ctx.employees) {
      const rule = ctx.ruleOf(employee);

      for (const date of dates) {
        // Days before joining or after leaving do not come as rows at all.
        // Otherwise someone who joined on the 20th would get 19 days of "no
        // activity" and a full target.
        if (!ctx.employedOn(employee, date)) continue;

        const summary = byKey.get(`${employee.id}|${date.getTime()}`);
        const dayTarget = ctx.targetSecOf(employee, date);
        const worked = summary?.workedSec ?? 0;
        const credited = summary?.creditedSec ?? 0;

        rows.push({
          employeeId: employee.id,
          empCode: employee.empCode,
          fullName: employee.fullName,
          receivesTasks: employee.receivesTasks,
          department: employee.department,
          date: toIsoDate(date),
          dayType: dayTypeOf(date, rule),
          /**
           * **G130**: the number was already right; now the reason is written too.
           *
           * Deliberately not folded into `dayType`: leave is an event on a
           * **work day**, while `dayType` says what the day is in the office
           * calendar (work day, weekly off, public holiday). Mixed, "how many
           * people took leave on work days" could no longer be counted.
           */
          onLeave: ctx.onLeaveOn(employee, date),
          // No data and no work both read "no activity" in the report. The row
          // still **stays**: dropping absences would make them vanish from the
          // report altogether, rather than show as "no data".
          status: worked > 0 ? 'worked' : 'no_activity',
          workedHours: secondsToHours(worked),
          idleHours: secondsToHours(summary?.idleSec ?? 0),
          adjustmentHours: secondsToHours(summary?.adjustmentSec ?? 0),
          creditedHours: secondsToHours(credited),
          /**
           * **Only "finished"**: `daily_summary.tasksStarted` (how many were
           * merely brought to the screen) cannot tell the one who does the work
           * from the one who looks at it.
           *
           * `null` when 0: in a spreadsheet 0 means "measured and found zero",
           * which would be false on the row of someone the measure is not for.
           * Anyone who finished tasks shows the number, target or not.
           */
          tasksDone:
            finishedByKey.get(`${employee.id}|${date.getTime()}`) ?? null,
          targetHours: secondsToHours(dayTarget),
        });

        workedSec += worked;
        creditedSec += credited;
        targetSec += dayTarget;
        if (worked > 0) daysWithWork += 1;
      }
    }

    return {
      meta: metaOf(ctx),
      rows,
      totals: {
        employees: ctx.employees.length,
        rows: rows.length,
        workedHours: secondsToHours(workedSec),
        creditedHours: secondsToHours(creditedSec),
        /**
         * This is **the sum of the Target column of the rows above**, not "how
         * much was due so far" (that is `meta.expectedHours`). On the web and in
         * the PDF the number sits as a footnote right under that column, so
         * taking it from the expectation window would mean **the column no
         * longer added up**: a total that does not match its own column is worse
         * than any wrong number. So the difference is stated in the label
         * ("Target · days listed"), not by changing the total.
         */
        targetHours: secondsToHours(targetSec),
        daysWithWork,
      },
    };
  }

  /**
   * F05 (xlsx) and F06 (pdf): the same report, two wrappers.
   *
   * Both formats are built from **the same `attendance()` call**. With separate
   * queries a filter would one day land in only one, and then the Excel and
   * PDF of the same range would show different totals, the worst mistake a
   * report can have.
   */
  async attendanceFile(
    q: ReportRangeQuery,
    format: DownloadFormat,
    actorUserId: number,
    ip: string,
  ): Promise<ReportFile> {
    const report = await this.attendance(q);
    const buffer =
      format === 'pdf'
        ? await attendancePdf(report, this.exporter.orgName)
        : await attendanceWorkbook(report);

    return this.exporter.fileOf('attendance', report.meta, report.rows.length, format, {
      buffer,
      actorUserId,
      ip,
    });
  }
}

/**
 * The day's type and "was work done" are two separate columns. Merged into
 * one, work done on a holiday would be lost as "holiday", or the holiday
 * information would be wiped out as "worked". Hours on a holiday count in
 * full but the target is 0, so that day goes straight to extra (§ 2.1-b, which is intended).
 */
function dayTypeOf(date: Date, rule: WorkdayRule): DayType {
  if (rule.holidays.has(date.getTime())) return 'holiday';
  if (isOffWeekday(isoDayOf(date), rule.weeklyOffDays)) {
    return 'weekly_off';
  }
  return 'workday';
}
