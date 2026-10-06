import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmployeeStatus, SegmentState, type Productivity } from '@prisma/client';

import {
  addSeconds,
  emptyBuckets,
  foldUsage,
  scoreOf,
  type CategoryMeta,
  type SecondBuckets,
  type UsageGroup,
  type UsageTally,
} from '../activity/activity.math';
import { WORK_TIMEZONE, workDateOf } from '../agent/util/work-time';
import { AuditService } from '../audit/audit.service';
import { REGIME_SELECT, targetSpreadOf } from '../calendar/work-regime';
import { PrismaService } from '../prisma/prisma.service';
import {
  countLeaveWorkdays,
  elapsedWindow,
  elapsedWorkdays,
  isObserved,
} from '../summary/summary.math';
import { trackedFromBy } from '../summary/tracking-start';
import type { ProductivityQuery, ReportRangeQuery, SummaryQuery } from './dto';
import {
  MIME_OF,
  reportFilename,
  type DownloadFormat,
} from './reports.download';
import { attendancePdf, summaryPdf } from './reports.pages';
import {
  attendanceWorkbook,
  productivityWorkbook,
  summaryWorkbook,
} from './reports.sheets';
/**
 * `countWorkdays` and `monthBoundsOf` are **deliberately not imported here.**
 * The denominator of the daily target is the policy's `expected_workdays`, not
 * a number counted from the calendar, and it was exactly because those two
 * functions were at hand that the denominator once slid back to the calendar.
 * If counting work days is needed, `targetSecIn()` does it itself (that is the
 * numerator, not the denominator).
 */
import {
  approximateHolidayDates,
  bucketOf,
  dailyTargetSec,
  eachDate,
  isoDayOf,
  isWorkday,
  monthsIn,
  overlapOf,
  parseReportRange,
  secondsToHours,
  sharePct,
  targetSecIn,
  toIsoDate,
  weekStartIsoDay,
  type DateSpan,
  type GroupBy,
  type ReportRange,
  type WorkdayRule,
} from './reports.range';
import {
  OVERTIME_NOTE,
  type AttendanceReport,
  type AttendanceRow,
  type DayType,
  type ProductivityEmployeeRow,
  type ProductivityItem,
  type ProductivityReport,
  type ReportFile,
  type ReportMeta,
  type SummaryReport,
  type SummaryRow,
} from './reports.types';
import { isOffWeekday } from '../summary/weekly-off';

const DEFAULT_TOP = 25;

/**
 * The organisation's name printed on the letterhead.
 * Careful: if `ORG_NAME` is missing the letterhead is not blank; at least the
 * product's name goes in, because a paper with no heading could not say whose company it is.
 */
const DEFAULT_ORG_NAME = 'oXeio Monitoring';

// ── Internal helper types ───────────────────────────────────────────────────

interface ResolvedEmployee {
  id: number;
  empCode: string;
  fullName: string;
  department: string | null;
  /** Kind of work: the designs column is filled only for designers */
  staffType: 'designer' | 'researcher' | 'manager' | null;
  joinedOn: Date | null;
  leftOn: Date | null;
  monthlyTargetSec: number;
  weeklyOffDays: readonly number[];
  /**
   * One work day's target = monthly ÷ the policy's `expected_workdays`.
   *
   * Worked out **once** per employee and does not change when the month
   * changes: this very constancy is what keeps it in line with `prorate()`. It
   * used to vary by month (the denominator was that month's calendar work
   * days), so for the same employee in the same month the report said 7.70
   * hours and the tray said 8.00.
   */
  dailyTargetSec: number;
}

interface ReportContext {
  range: ReportRange;
  employees: ResolvedEmployee[];
  excluded: string[];
  /**
   * Of the holiday dates this report's denominator rests on, those that are not
   * final yet ('YYYY-MM-DD'). They come from exactly the rows the work days
   * were counted with: one number, one definition.
   */
  approximateHolidayDates: string[];
  /**
   * Per employee, "how much was due so far", in hours: `ReportMeta.expectedHours`.
   * The definition, and why it is on the server, are both in that type's note.
   */
  expectedHours: Record<number, number>;
  /**
   * Per employee, **the total target of this span**, in hours: office days ×
   * daily target, minus Fridays, public holidays and their own leave. The
   * definition is in the note on `ReportMeta.targetHoursInRange`.
   */
  targetHoursInRange: Record<number, number>;
  /** G111: per employee, whether at least one finished work day has been observed */
  observed: Record<number, boolean>;
  /** G110: per employee, the day tracking started, **only for drawing** */
  trackedFrom: Record<number, string | null>;
  /** That employee's target for that day, in seconds (0 on a leave day) */
  targetSecOf(employee: ResolvedEmployee, date: Date): number;
  /**
   * The span's **expectation**, in seconds: the target of only that part of
   * the span that falls inside `elapsedWindow()`.
   *
   * It is **less than or equal to** the sum of `targetSecOf()`, and the
   * difference is deliberate: the days before tracking started and today's
   * unfinished day are in the target but not the expectation. A shortfall is
   * measured **only** against this number; an unobserved day is nobody's failure.
   */
  expectedSecOf(employee: ResolvedEmployee, span: DateSpan): number;
  /**
   * **G130 (R2)**: whether that day is approved leave for that employee.
   *
   * Leave reached the numbers long ago (target 0, expectation 0) but **did not
   * reach the label**, so a leave day looked exactly like a zero-hour work day.
   * The number was not lying, but it **did not give the reason**, and to answer
   * "why did they not work that day" you had to go to Settings → Leave.
   *
   * It comes from exactly **the same** `leaveBy` set that zeroes the target
   * (`targetSecOf`): one definition. With a separate query, one day the badge
   * would be there while the target was not cut, or the reverse.
   */
  onLeaveOn(employee: ResolvedEmployee, date: Date): boolean;
  ruleOf(employee: ResolvedEmployee): WorkdayRule;
  employedOn(employee: ResolvedEmployee, date: Date): boolean;
}

/**
 * F01–F02/F04/F05/F08: reports and Excel export.
 *
 * **There are no money calculations here.** Everything about salary is in
 * `src/payroll/`, where `monthly_salary` is read; managers also see these
 * reports (§ 4.3), so a money column slipping in here would leak salaries.
 *
 * **Categories never enter the pay calculation**: F04's productive/unproductive
 * split is for viewing only; it has no effect on `worked_sec`, `credited_sec` or the target.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  private readonly orgName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.orgName =
      config.get<string>('ORG_NAME')?.trim() || DEFAULT_ORG_NAME;
  }

  // ── F01 · attendance ───────────────────────────────────────────────────────

  async attendance(q: ReportRangeQuery): Promise<AttendanceReport> {
    const ctx = await this.context(q);
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
     * **How many targets each person marked "finished" on each day** (the
     * owner's request).
     *
     * `daily_summary` does not have this and should not: that table keeps time,
     * and this is about work. So it is read straight from `design_targets`.
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
        FROM design_targets
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
          staffType: employee.staffType,
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
           * `null` (the column is empty) if no designs were done, not zero.
           * If someone who is not a designer does some, the number shows: a
           * manager also designs, and hiding that would lose information.
           */
          /**
           * **Only "finished"** (owner's decision): `daily_summary.designsDone`
           * used to go here, i.e. how many files were **opened**. That number
           * caused confusion in the field: a manager with 44 minutes in 19 files
           * was showing "16".
           *
           * `null` when 0: in a spreadsheet 0 means "measured and found zero",
           * which would be false on the row of someone outside design.
           */
          designsDone:
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
        ? await attendancePdf(report, this.orgName)
        : await attendanceWorkbook(report);

    return this.fileOf('attendance', report.meta, report.rows.length, format, {
      buffer,
      actorUserId,
      ip,
    });
  }

  // ── F02 · weekly / monthly summary ─────────────────────────────────────────

  async summary(q: SummaryQuery): Promise<SummaryReport> {
    const ctx = await this.context(q);
    const { range } = ctx;
    const groupBy: GroupBy = q.groupBy ?? 'month';

    const daily = await this.prisma.dailySummary.findMany({
      where: {
        employeeId: { in: ctx.employees.map((e) => e.id) },
        workDate: { gte: range.from, lte: range.to },
      },
      select: {
        employeeId: true,
        workDate: true,
        workedSec: true,
        adjustmentSec: true,
        creditedSec: true,
      },
    });

    const byKey = new Map(
      daily.map((d) => [`${d.employeeId}|${d.workDate.getTime()}`, d]),
    );

    const dates = eachDate(range.from, range.to);
    const rows: SummaryRow[] = [];

    for (const employee of ctx.employees) {
      const weekStart = weekStartIsoDay(employee.weeklyOffDays);
      const rule = ctx.ruleOf(employee);

      /** bucket key → the running totals */
      const buckets = new Map<
        string,
        {
          start: Date;
          end: Date;
          workdays: number;
          daysWithWork: number;
          workedSec: number;
          adjustmentSec: number;
          creditedSec: number;
          targetSec: number;
        }
      >();

      for (const date of dates) {
        if (!ctx.employedOn(employee, date)) continue;

        const bucket = bucketOf(date, groupBy, weekStart);
        let acc = buckets.get(bucket.key);
        if (!acc) {
          acc = {
            // Not the bucket's own bounds but **what actually went into the
            // calculation** is shown. In a report starting on 10 August, writing
            // the '2026-08' bucket's start as 1 August would make the reader
            // think the whole month's figures were in hand, though only 22 days
            // of target were counted.
            start: date,
            end: date,
            workdays: 0,
            daysWithWork: 0,
            workedSec: 0,
            adjustmentSec: 0,
            creditedSec: 0,
            targetSec: 0,
          };
          buckets.set(bucket.key, acc);
        }
        acc.end = date;

        const summary = byKey.get(`${employee.id}|${date.getTime()}`);
        acc.workedSec += summary?.workedSec ?? 0;
        acc.adjustmentSec += summary?.adjustmentSec ?? 0;
        acc.creditedSec += summary?.creditedSec ?? 0;
        acc.targetSec += ctx.targetSecOf(employee, date);
        if (isWorkday(date, rule)) acc.workdays += 1;
        if ((summary?.workedSec ?? 0) > 0) acc.daysWithWork += 1;
      }

      for (const [key, acc] of [...buckets].sort(([a], [b]) =>
        a < b ? -1 : 1,
      )) {
        /**
         * **The shortfall's denominator is the expectation and the overtime's
         * is the target. Deliberately different, and this is the most important
         * decision in this file.**
         *
         * The target is a **calendar fact**: how many hours there were for these
         * days. A shortfall is a **verdict about a person**, and a verdict can
         * only rest on days we really observed and that have finished, so its
         * denominator is `expectedSecOf()`.
         *
         * Without this, what happened last round would happen: the Monthly page
         * said "expected 8h · pace −2h" while the Excel/PDF for **the same
         * month** said "target 83.2h · shortfall 77.2h", because it also counted
         * the days before the agent was installed. Between the two, people trust
         * the paper, and the paper was the one accusing.
         *
         * Overtime is measured against **the full target**, not the expectation.
         * With the expectation, hours worked today (today is not in the
         * expectation) would print as "overtime" for everyone, though the
         * month's target has not even been reached. "Ahead of pace" and "worked
         * extra" are not the same thing.
         *
         * Once a period has ended (last month's report) the window covers the
         * whole bucket, i.e. expectation = target and the two denominators
         * coincide, so old months' printed papers do not move with this change.
         *
         * Both are compared with `credited_sec`, not `worked_sec` (§ 2.1-e);
         * otherwise the owner's corrections would vanish from the report.
         */
        const expectedSec = ctx.expectedSecOf(employee, {
          from: acc.start,
          to: acc.end,
        });

        rows.push({
          employeeId: employee.id,
          empCode: employee.empCode,
          fullName: employee.fullName,
          bucket: key,
          bucketStart: toIsoDate(acc.start),
          bucketEnd: toIsoDate(acc.end),
          workdays: acc.workdays,
          daysWithWork: acc.daysWithWork,
          workedHours: secondsToHours(acc.workedSec),
          adjustmentHours: secondsToHours(acc.adjustmentSec),
          creditedHours: secondsToHours(acc.creditedSec),
          targetHours: secondsToHours(acc.targetSec),
          shortfallHours: secondsToHours(
            Math.max(0, expectedSec - acc.creditedSec),
          ),
          overtimeHours: secondsToHours(
            Math.max(0, acc.creditedSec - acc.targetSec),
          ),
        });
      }
    }

    return { meta: metaOf(ctx), groupBy, overtimeNote: OVERTIME_NOTE, rows };
  }

  async summaryFile(
    q: SummaryQuery,
    format: DownloadFormat,
    actorUserId: number,
    ip: string,
  ): Promise<ReportFile> {
    const report = await this.summary(q);
    const buffer =
      format === 'pdf'
        ? await summaryPdf(report, this.orgName)
        : await summaryWorkbook(report);

    return this.fileOf('summary', report.meta, report.rows.length, format, {
      buffer,
      actorUserId,
      ip,
    });
  }

  // ── F04 · productivity ────────────────────────────────────────────────────

  /**
   * **There is one definition of productivity, and it is in
   * [activity.math.ts](../activity/activity.math.ts).** This method now only
   * fetches rows and arranges them into the printed shape.
   *
   * It used to have its own `switch` that put seconds into productive /
   * neutral / unproductive / uncategorized, an exact copy of `addSeconds()` in
   * different code. Being separate routes the two never met, but **they already
   * gave different answers**: here the percentage's denominator included
   * uncategorised time, in `scoreOf()` it did not. If anyone asked, there was
   * no way to say "which one is true". Now both numbers come from the same
   * `scoreOf()`, each with its own name and meaning
   * ([reports.types.ts](./reports.types.ts)).
   *
   * `window_title` is never selected and there is no full URL anywhere, only
   * `domain` (ADR-013). A title often holds a whole link or a private
   * document's name; if that reached the report, the domain-only rule would
   * be effectively empty.
   *
   * With two devices running at once, time may be added twice here (§ 2.1-c's
   * UNION is not done here: a one-year range would pull hundreds of thousands
   * of rows into memory). This does not move anyone's **money**: pay goes by
   * `credited_sec`, which is set in the rollup with the UNION; this report only
   * shows "where the time goes".
   */
  async productivity(q: ProductivityQuery): Promise<ProductivityReport> {
    const ctx = await this.context(q);
    const ids = ctx.employees.map((e) => e.id);
    const where = {
      employeeId: { in: ids },
      workDate: { gte: ctx.range.from, lte: ctx.range.to },
      // R22a: only segments seen while ACTIVE are counted. Rows seen while idle
      // are now stored (to recognise meetings) but go into no calculation.
      segmentState: SegmentState.active,
    };
    const limit = q.limit ?? DEFAULT_TOP;

    const [byKey, byEmployee, meta] = await Promise.all([
      this.prisma.appUsage.groupBy({
        by: ['processName', 'domain', 'categoryId'],
        where,
        _sum: { durationSec: true },
        // `foldUsage` counts how many rows matched too: 3 hours on one domain in
        // 4 long segments or in 200 short ones are very different habits
        _count: { _all: true },
      }),
      this.prisma.appUsage.groupBy({
        by: ['employeeId', 'categoryId'],
        where,
        _sum: { durationSec: true },
      }),
      this.categoryMeta(),
    ]);

    // ── Top apps and sites
    //
    // Every DB row goes into **exactly one** list: a site if it has a domain,
    // otherwise an app. This split is done here in TypeScript, not in two
    // separate queries: with two `where`s a row with an empty-string domain
    // would fall into both lists or neither, and the total time would be
    // silently wrong.
    // This is where it differs from `/activity/top`: there, apps and sites are
    // two different slicings of **the same** time (youtube.com inside
    // chrome.exe), so they cannot be added. Here the two parts do not overlap,
    // so their sum is the total time.
    const appGroups: UsageGroup[] = [];
    const siteGroups: UsageGroup[] = [];

    for (const row of byKey) {
      const seconds = row._sum.durationSec ?? 0;
      if (seconds <= 0) continue;

      const site =
        row.domain !== null && row.domain.trim().length > 0 ? row.domain : null;

      const group: UsageGroup = {
        key: site ?? row.processName,
        categoryId: row.categoryId,
        seconds,
        records: row._count._all,
      };

      if (site === null) appGroups.push(group);
      else siteGroups.push(group);
    }

    const apps = foldUsage(appGroups, meta, 'app', limit);
    const sites = foldUsage(siteGroups, meta, 'site', limit);
    const totalSec = apps.totalSec + sites.totalSec;

    // The top `limit` is taken from each list and then cut to `limit` again.
    // Nothing is lost: the overall best `limit` is always within the best
    // `limit` of the two lists.
    // Sorted **by seconds**, not hours. Hours are rounded to two decimals, so
    // two rows 35 seconds apart would look equal and the order would drift into
    // alphabetical, so the smaller row would rise to the top.
    const top: ProductivityItem[] = [
      ...apps.rows.map((tally) => ({ tally, kind: 'app' as const })),
      ...sites.rows.map((tally) => ({ tally, kind: 'site' as const })),
    ]
      // On a tie, alphabetical by key: opening the same report twice gives the same order
      .sort(
        (a, b) =>
          b.tally.seconds - a.tally.seconds ||
          (a.tally.key < b.tally.key ? -1 : 1),
      )
      .slice(0, limit)
      .map(({ tally, kind }) => itemOf(tally, kind, totalSec));

    // ── Per employee
    const perEmployee = new Map<number, SecondBuckets>();

    for (const row of byEmployee) {
      const seconds = row._sum.durationSec ?? 0;
      if (seconds <= 0) continue;

      let buckets = perEmployee.get(row.employeeId);
      if (!buckets) {
        buckets = emptyBuckets();
        perEmployee.set(row.employeeId, buckets);
      }

      // A `null` category = **unknown**, not neutral: `addSeconds()` does that,
      // and if the two were merged every unknown app would silently raise the
      // score's denominator (the more unknown, the lower the score, the cause invisible).
      addSeconds(buckets, categoryOf(meta, row.categoryId), seconds);
    }

    let uncategorizedSec = 0;
    const rows: ProductivityEmployeeRow[] = ctx.employees.map((employee) => {
      // Those with no rows at all are in the list too: left out, "agent off" and
      // "all fine" would look the same
      const score = scoreOf(perEmployee.get(employee.id) ?? emptyBuckets());
      uncategorizedSec += score.unknownSec;

      return {
        employeeId: employee.id,
        empCode: employee.empCode,
        fullName: employee.fullName,
        productiveHours: secondsToHours(score.productiveSec),
        neutralHours: secondsToHours(score.neutralSec),
        unproductiveHours: secondsToHours(score.unproductiveSec),
        uncategorizedHours: secondsToHours(score.unknownSec),
        trackedHours: secondsToHours(score.totalSec),
        productiveSharePct: sharePct(score.productiveSec, score.totalSec),
        productivityScorePct: score.scorePct,
        uncategorizedSharePct: score.unknownPct,
      };
    });

    return {
      meta: metaOf(ctx),
      totalTrackedHours: secondsToHours(totalSec),
      uncategorizedHours: secondsToHours(uncategorizedSec),
      top,
      byEmployee: rows,
    };
  }

  /** productivity has no PDF: `ProductivityQuery` blocks it in the DTO itself (F06) */
  async productivityFile(
    q: ProductivityQuery,
    actorUserId: number,
    ip: string,
  ): Promise<ReportFile> {
    const report = await this.productivity(q);
    const buffer = await productivityWorkbook(report);

    return this.fileOf(
      'productivity',
      report.meta,
      report.top.length,
      'xlsx',
      { buffer, actorUserId, ip },
    );
  }

  // ── Common part ────────────────────────────────────────────────────────────

  /**
   * The basis of all three reports: the validated range, the list of employees,
   * the holiday calendar and each day's target.
   */
  private async context(q: ReportRangeQuery): Promise<ReportContext> {
    let range: ReportRange;
    try {
      range = parseReportRange(q.from, q.to);
    } catch (err) {
      // The pure function throws RangeError (like payroll.math); translation
      // into HTTP language happens only here
      if (err instanceof RangeError) throw new BadRequestException(err.message);
      throw err;
    }

    const [employeeRows, defaultPolicy] = await Promise.all([
      this.prisma.employee.findMany({
        where: {
          ...(q.employeeId === undefined ? {} : { id: q.employeeId }),
          AND: [
            { OR: [{ joinedOn: null }, { joinedOn: { lte: range.to } }] },
            { OR: [{ leftOn: null }, { leftOn: { gte: range.from } }] },
          ],
        },
        select: {
          id: true,
          empCode: true,
          fullName: true,
          department: true,
          staffType: true,
          status: true,
          joinedOn: true,
          leftOn: true,
          // `monthlySalary` is **not** here and must never be added: managers
          // call this endpoint too
          policy: {
            // `expectedWorkdays` is the **denominator** of the daily target.
            // Without fetching it, the calendar-counted work days would creep in
            // here again, which was exactly the source of the two numbers in
            // the report and the tray.
            select: REGIME_SELECT,
          },
        },
        orderBy: { empCode: 'asc' },
      }),
      this.prisma.workPolicy.findFirst({
        where: { isActive: true },
        orderBy: { id: 'asc' },
        select: REGIME_SELECT,
      }),
    ]);

    const employees: ResolvedEmployee[] = [];
    const excluded: string[] = [];

    for (const e of employeeRows) {
      // Inactive yet `left_on` empty: it is not known since when they were gone,
      // so putting zero rows across the range would give a wrong picture. They
      // are left out, but the name goes in meta.
      if (e.status === EmployeeStatus.inactive && e.leftOn === null) {
        excluded.push(e.fullName);
        continue;
      }

      const policy = e.policy ?? defaultPolicy;
      if (!policy) {
        // 208 is not assumed. With no policy the target is **unknown**, and
        // printing a shortfall against an unknown target would silently invent a policy.
        throw new InternalServerErrorException(
          'There is no active work policy — the target cannot be worked out',
        );
      }

      // per month, per week, per day or none — as seconds over workdays
      const spread = targetSpreadOf(policy);
      const monthlyTargetSec = spread.periodTargetSec;

      employees.push({
        id: e.id,
        empCode: e.empCode,
        fullName: e.fullName,
        department: e.department,
        staffType: e.staffType,
        joinedOn: e.joinedOn,
        leftOn: e.leftOn,
        monthlyTargetSec,
        weeklyOffDays: policy.weeklyOffDays,
        dailyTargetSec: dailyTargetSec(
          spread.periodTargetSec,
          spread.periodWorkdays,
        ),
      });
    }

    if (excluded.length > 0) {
      this.logger.warn(
        `${excluded.length} inactive staff have no left_on — they are missing from the report`,
      );
    }

    // Holidays are fetched for the **whole months**, not just the range, for two
    // reasons, and neither is the daily target's denominator (that is the
    // policy constant): see the note on `monthsIn()`.
    const months = monthsIn(range.from, range.to);
    const holidayRows = await this.prisma.holiday.findMany({
      where: {
        holidayDate: {
          gte: months[0].first,
          lte: months[months.length - 1].last,
        },
      },
      // `name` is fetched too, because the uncertainty marker ("(সম্ভাব্য)",
      // "probable") is in the name, not a separate column (see the top of
      // `prisma/holidays.data.ts`).
      select: { holidayDate: true, name: true },
    });
    const holidays = new Set(holidayRows.map((h) => h.holidayDate.getTime()));

    const ruleOf = (employee: ResolvedEmployee): WorkdayRule => ({
      weeklyOffDays: employee.weeklyOffDays,
      holidays,
    });

    /**
     * **R2: leave, per employee.**
     *
     * Leave days are **not** poured into the `holidays` set, though the two
     * functions below would then come out right anyway. The reason is that the
     * same set feeds `approximateHolidayDates()`, so one person's personal leave
     * would appear in the report's footnote as a "public holiday" for everyone to see.
     */
    const leaveRows = await this.prisma.leave.findMany({
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        leaveDate: {
          gte: months[0].first,
          lte: months[months.length - 1].last,
        },
      },
      select: { employeeId: true, leaveDate: true },
    });
    const leaveBy = new Map<number, Set<number>>();
    for (const l of leaveRows) {
      let set = leaveBy.get(l.employeeId);
      if (!set) leaveBy.set(l.employeeId, (set = new Set()));
      set.add(l.leaveDate.getTime());
    }

    /**
     * **One rate.** If the day is a work day, its target is the employee's own
     * `dailyTargetSec`, whatever the month and however many holidays it has.
     *
     * The denominator here used to be **that month's calendar work days**, and
     * that was the source of two different daily targets for the same employee
     * in the same month: the tray and `monthly_summary` said 208 ÷ 26 = 8.00
     * hours, the report said 208 ÷ 27 = 7.70. Worse, more holidays **raised**
     * the report's daily target, so a holiday gave the employee no benefit at all.
     * Why the policy constant is right is in the note on `dailyTargetSec()`.
     */
    /**
     * G130: the badge and the target deduction read **the same set**, so the two
     * can never disagree. The `leaves` table is read directly and nothing is
     * written to any column: delete a leave and the badge goes at once.
     */
    const onLeaveOn = (employee: ResolvedEmployee, date: Date): boolean =>
      leaveBy.get(employee.id)?.has(date.getTime()) ?? false;

    const targetSecOf = (employee: ResolvedEmployee, date: Date): number => {
      if (!isWorkday(date, ruleOf(employee))) return 0;
      // R2: a leave day has target 0, just like a weekly off day
      if (onLeaveOn(employee, date)) return 0;
      return employee.dailyTargetSec;
    };

    /**
     * **"How much was due so far": here, once.**
     *
     * The window is **not** built by hand: `elapsedWindow()` from
     * `summary.math.ts` is called, exactly as the monthly rollup and the tray
     * call it. Writing `today − 1` again here would be a fourth definition, and
     * that is exactly how the previous three were born.
     *
     * **That employee's own** tracking start (their oldest `daily_summary` row),
     * not the organisation's first day; otherwise for someone whose record was
     * created later, the days before it would also become their shortfall.
     *
     * **What this does not fix** (see the same note in `summary.math.ts` and
     * `progress.service.ts`): someone active from 1 October who got the agent on
     * 8 October. `refreshDate()` writes a row for every active employee, with
     * data or without, so their tracking start also lands on 1 October, and the
     * seven agentless days are **still a full shortfall**. This window covers
     * the gap of the first install, not of an employee who joined later (G120).
     *
     * The total uses `targetSecIn()`: **work days × daily target**, exactly how
     * `prorate()` works out the month's target. The daily target is now the same
     * in every month, so this product and the day-by-day sum give the same
     * hours, i.e. the number is the sum of the cells seen on the page. **Both**
     * are guarded by `test/reports.target.spec.ts`; if the denominator varied by
     * month that equality would break, and multiplying would be wrong.
     */
    const trackedFrom = await trackedFromBy(
      this.prisma,
      employees.map((e) => e.id),
    );

    // Today in the work zone: `parseReportRange()` finds the clamping limit exactly this way
    const today = workDateOf(new Date());

    const windowBy = new Map(
      employees.map((employee) => [
        employee.id,
        elapsedWindow({
          periodStart: range.from,
          periodEnd: range.to,
          today,
          joinedOn: employee.joinedOn,
          leftOn: employee.leftOn,
          // `?? today`: the window of an unseen employee is empty, expectation 0 (G120)
          trackingStartedOn: trackedFrom.get(employee.id) ?? today,
        }),
      ]),
    );

    /**
     * **The only place the expectation is measured**: the number in meta and the
     * row's shortfall both go through here. Adding up the buckets' expectations
     * returns exactly `meta.expectedHours`, because the buckets split the range.
     *
     * A `null` window = empty (today is the range's first day, or they have not
     * yet been seen on even one finished day); then the expectation is 0, and
     * nobody can have a shortfall against 0. That is what we want.
     */
    /**
     * **Office days × daily target − leave**: the project's only target
     * formula, written **once** here.
     *
     * The formula used to be written in two places, and that is exactly how G117
     * was born: leave was subtracted on one side and not the other. Now the two
     * callers (the expectation and the span's target) only pass a **different
     * window**, not a different calculation.
     *
     * R2: leave has to be subtracted separately, because `targetSecIn()`
     * multiplies (it does not add day by day). Without it the number in meta and
     * the sum of the rows would not match; `test/reports.target.spec.ts` guards that equality.
     */
    const netTargetSecIn = (
      employee: ResolvedEmployee,
      span: DateSpan,
    ): number => {
      const onLeave = countLeaveWorkdays(
        leaveBy.get(employee.id),
        span.from,
        span.to,
        employee.weeklyOffDays,
        holidays,
      );
      return (
        targetSecIn(span, ruleOf(employee), employee.dailyTargetSec) -
        onLeave * employee.dailyTargetSec
      );
    };

    const expectedSecOf = (
      employee: ResolvedEmployee,
      span: DateSpan,
    ): number => {
      const window = windowBy.get(employee.id) ?? null;
      if (window === null) return 0;

      const seen = overlapOf(window, span);
      if (seen === null) return 0;

      return netTargetSecIn(employee, seen);
    };

    const expectedHours: Record<number, number> = {};
    for (const employee of employees) {
      expectedHours[employee.id] = secondsToHours(
        expectedSecOf(employee, { from: range.from, to: range.to }),
      );
    }

    /**
     * **G111: which kind of 0 the 0 above is, is decided here.**
     *
     * `expectedHours === 0` can come from two completely different causes: they
     * have **not yet been seen on even one finished work day**, or they have
     * been seen but had no target at all on those days (all leave). On screen
     * both show as "0 shortfall", i.e. they look like a met target.
     *
     * The flag comes **from `workdaysElapsed`**, not from `expectedHours`. The
     * tray and Live Board read this same number (`isObserved`), so the three
     * screens can never give three different verdicts.
     *
     * Leave days are removed from the numerator (`leaveBy`), exactly as when
     * counting the expectation. Otherwise someone back from leave would show as
     * "observed" with an expectation of 0, the same two stories again.
     */
    const observed: Record<number, boolean> = {};
    const trackedFromMeta: Record<number, string | null> = {};
    for (const employee of employees) {
      observed[employee.id] = isObserved({
        workdaysElapsed: elapsedWorkdays(
          {
            periodStart: range.from,
            periodEnd: range.to,
            today,
            joinedOn: employee.joinedOn,
            leftOn: employee.leftOn,
            // `?? today`: exactly the same borrowing as `windowBy` above (G120)
            trackingStartedOn: trackedFrom.get(employee.id) ?? today,
            weeklyOffDays: employee.weeklyOffDays,
            holidays,
          },
          leaveBy.get(employee.id),
        ),
      });

      /**
       * G110: **the date, not the rule.** The page uses it only to draw cells
       * ("we were not watching on this day"); the expectation still comes from
       * `expectedHours`.
       */
      const seenFrom = trackedFrom.get(employee.id);
      trackedFromMeta[employee.id] =
        seenFrom === undefined ? null : toIsoDate(seenFrom);
    }

    /**
     * **Their total target in this span**, the owner's rule: 8 hours a day,
     * excluding holidays and Fridays, counting office days, not months.
     *
     * So **office days are counted, not the month**: the span's work days ×
     * the daily target, Fridays and public holidays excluded.
     *
     * This fixed G117: the policy's **flat 208** used to go here, yet in
     * October there are 24 office days (= 192h). The report showed a **phantom
     * shortfall** of 16 hours, while the tray said a different number for the same month.
     *
     * Because the month is not what is counted, the question "which month's
     * target" no longer arises: for one month, half a month or three, the
     * number means the same.
     *
     * **Personal leave is also subtracted** (`netTargetSecIn`); otherwise paid
     * leave days would become shortfall, and there would again be two numbers
     * against the tray, `monthly_summary` and payroll, just with the opposite sign.
     *
     * Trimmed to the employment period: the days before joining or after leaving
     * are nobody's target. If the overlap is empty the answer is **0**, and 0 is
     * a valid answer ("they have no office days").
     *
     * **The window is `requestedTo`, not `to`, and that is not a casual choice.**
     *
     * `range.to` is clamped to today (`clampedToToday`). Using it, on 23 August
     * August's target would come out as **160h** (20 office days), yet August's
     * target is 208: a target does not shrink because the month has not ended.
     *
     * Clamped, the number would also become effectively a **copy** of
     * `expectedHours`, though the two do different jobs: this is "how much is due
     * in total" (the denominator of progress), and that is "how much is due so
     * far" (the yardstick of shortfall). Making one equal the other would leave
     * the Monthly page's progress bar sitting near 100% all day.
     *
     * Caught in CI by a red test in this file's tests; `to` was used at first.
     */
    const targetHoursInRange: Record<number, number> = {};
    const targetSpan = { from: range.from, to: range.requestedTo };
    for (const employee of employees) {
      const employed = overlapOf(targetSpan, {
        from: employee.joinedOn ?? targetSpan.from,
        to: employee.leftOn ?? targetSpan.to,
      });
      targetHoursInRange[employee.id] = secondsToHours(
        employed === null ? 0 : Math.round(netTargetSecIn(employee, employed)),
      );
    }

    return {
      range,
      employees,
      excluded,
      expectedHours,
      targetHoursInRange,
      observed,
      trackedFrom: trackedFromMeta,
      onLeaveOn,
      expectedSecOf,
      /**
       * **Exactly the rows** from which the `holidays` set above was built, and
       * so the month's work days and the daily target's denominator. A separate
       * query would bring the two numbers from two places, and one day (if the
       * range or filter changed a little) they would say different things.
       */
      approximateHolidayDates: approximateHolidayDates(
        holidayRows.map((h) => ({ date: h.holidayDate, name: h.name })),
      ),
      ruleOf,
      employedOn: (employee, date) =>
        (employee.joinedOn === null ||
          date.getTime() >= employee.joinedOn.getTime()) &&
        (employee.leftOn === null ||
          date.getTime() <= employee.leftOn.getTime()),
      targetSecOf,
    };
  }

  /**
   * id → category identity. About 110 rows, so reading all of it each time is simplest.
   *
   * All ids are fetched, not only the used ones: `matchType` is needed to pick the
   * label (`foldUsage`'s chrome.exe/YouTube trap), and for that label choice to
   * stay exactly the same as `/activity/top`, the map has to be the same kind.
   *
   * `AppCategoryService`'s cache is not used: it holds `compile()`d rules, and
   * rules with a bad regex are dropped there. A report may well have old rows
   * carrying such a rule's id; taking from the cache would silently show them
   * as "unknown", though the category is set in the database.
   */
  private async categoryMeta(): Promise<Map<number, CategoryMeta>> {
    const rows = await this.prisma.appCategory.findMany({
      select: { id: true, displayName: true, category: true, matchType: true },
    });

    return new Map(
      rows.map((r) => [
        r.id,
        {
          displayName: r.displayName,
          category: r.category,
          matchType: r.matchType,
        },
      ]),
    );
  }

  /**
   * An export is an event: who downloaded which range in which format is
   * recorded (§ 7).
   *
   * `format` used to be hardcoded as `'xlsx'`. Had that not been changed when
   * PDF was added, the audit log would have **lied**: someone downloading a PDF
   * would still be recorded as xlsx, yet "who took what" is supposed to be
   * answered from the audit.
   */
  private async fileOf(
    report: string,
    meta: ReportMeta,
    rows: number,
    format: DownloadFormat,
    out: { buffer: Buffer; actorUserId: number; ip: string },
  ): Promise<ReportFile> {
    await this.audit.record({
      userId: out.actorUserId,
      action: 'export_report',
      targetType: 'report',
      targetId: report,
      ipAddress: out.ip,
      meta: { from: meta.from, to: meta.to, rows, format },
    });

    return {
      filename: reportFilename(report, meta.from, meta.to, format),
      mime: MIME_OF[format],
      buffer: out.buffer,
    };
  }
}

/**
 * `null` if the id is not in the map: "unknown", not a crash. With the foreign
 * key it should not happen, but it can between a rule being deleted and the map
 * being read, and then there is no reason for the whole report to give a 500.
 *
 * `activity.math.ts` has exactly this rule too, but it is file-private. If it
 * were exported these six lines could be deleted; the note says so.
 */
function categoryOf(
  meta: ReadonlyMap<number, CategoryMeta>,
  categoryId: number | null,
): Productivity | null {
  if (categoryId === null) return null;
  return meta.get(categoryId)?.category ?? null;
}

/**
 * `activity.math`'s `UsageTally` → an F04 row.
 *
 * The denominator of `sharePct` is the **total of both lists together**, not
 * `foldUsage`'s own total. Otherwise apps and sites would each add up to 100%
 * separately, and side by side in one table the percentages would sum to 200.
 */
function itemOf(
  tally: UsageTally,
  kind: 'app' | 'site',
  totalSec: number,
): ProductivityItem {
  return {
    key: tally.key,
    kind,
    category: tally.category ?? 'uncategorized',
    // When `foldUsage` finds no rule name it uses the key as the label; F04's
    // contract says "null if the rule has no name"
    displayName: tally.label === tally.key ? null : tally.label,
    mixed: tally.mixed,
    hours: secondsToHours(tally.seconds),
    sharePct: sharePct(tally.seconds, totalSec),
  };
}

// ── Small helpers ───────────────────────────────────────────────────────────

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

function metaOf(ctx: ReportContext): ReportMeta {
  return {
    from: toIsoDate(ctx.range.from),
    to: toIsoDate(ctx.range.to),
    requestedTo: toIsoDate(ctx.range.requestedTo),
    clampedToToday: ctx.range.clampedToToday,
    days: ctx.range.days,
    generatedAt: new Date().toISOString(),
    excludedEmployees: ctx.excluded,

    // The uncertainty reaches the number: which of these months' holiday dates
    // are not final yet. If they move, work days move, the target moves, and
    // payroll's fraction moves, so we cannot stay silent.
    approximateHolidayDates: ctx.approximateHolidayDates,

    // Their **real** target in this span: office days × daily target (G117).
    // It used to be the policy's flat 208 here, which was only right for a
    // month with 26 office days; October has 24 days = 192h, a phantom 16-hour shortfall.
    // The calculation is in `context()`, on **the same formula** as `expectedHours`.
    targetHoursInRange: ctx.targetHoursInRange,

    // "How much was due so far": the window is `elapsedWindow()`'s, i.e. exactly
    // the same definition as the tray and Live Board.
    expectedHours: ctx.expectedHours,

    // G111: whether the 0 above is "target met" or "not observed yet". A
    // **state**, not a number; otherwise the page would have to guess.
    observed: ctx.observed,

    // G110: since when we have been watching. **Only for drawing**; do not
    // compute the expectation from it, which is how the earlier bug was born.
    trackedFrom: ctx.trackedFrom,
  };
}
