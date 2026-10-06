import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { SummaryQuery } from './dto';
import { metaOf, ReportsContextService } from './reports.context.service';
import type { DownloadFormat } from './reports.download';
import { ReportsExportService } from './reports.export.service';
import { summaryPdf } from './reports.pages';
import {
  bucketOf,
  eachDate,
  isWorkday,
  secondsToHours,
  toIsoDate,
  weekStartIsoDay,
  type GroupBy,
} from './reports.range';
import { summaryWorkbook } from './reports.sheets';
import {
  OVERTIME_NOTE,
  type ReportFile,
  type SummaryReport,
  type SummaryRow,
} from './reports.types';

/** F02 · weekly / monthly summary, and its xlsx/pdf. */
@Injectable()
export class ReportsSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportContext: ReportsContextService,
    private readonly exporter: ReportsExportService,
  ) {}

  async summary(q: SummaryQuery): Promise<SummaryReport> {
    const ctx = await this.reportContext.context(q);
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
        ? await summaryPdf(report, this.exporter.orgName)
        : await summaryWorkbook(report);

    return this.exporter.fileOf('summary', report.meta, report.rows.length, format, {
      buffer,
      actorUserId,
      ip,
    });
  }
}
