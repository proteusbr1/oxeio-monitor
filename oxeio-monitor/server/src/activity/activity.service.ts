import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SegmentState, type Prisma } from '@prisma/client';

import { workDateOf } from '../agent/util/work-time';
import { PrismaService } from '../prisma/prisma.service';
import {
  foldDailyScores,
  foldTeamSites,
  foldUsage,
  resolveRange,
  scoreOf,
  emptyBuckets,
  toDateKey,
  TOP_N,
  type CategoryMeta,
  type DailyScore,
  type ProductivityScore,
  type TeamSiteReport,
  type UsageReport,
  type WorkDateRange,
} from './activity.math';
import type {
  EmployeeRangeQueryDto,
  RangeQueryDto,
  TeamQueryDto,
  TopQueryDto,
} from './dto';

export interface EmployeeProductivity {
  employeeId: number;
  empCode: string;
  fullName: string;
  days: DailyScore[];
  total: ProductivityScore;
}

export interface ProductivityReport {
  from: string;
  to: string;
  employees: EmployeeProductivity[];
  caveat: string;
}

export interface TopReport {
  from: string;
  to: string;
  employeeId: number | null;
  apps: UsageReport;
  sites: UsageReport;
  caveat: string;
}

export interface TeamReport extends TeamSiteReport {
  from: string;
  to: string;
  employeesWithData: number;
  caveat: string;
}

/**
 * Careful: **if one person runs two PCs, their time is counted twice**
 * (spec § 2.1-c).
 *
 * `worked_sec` avoids that by taking the **UNION** of ACTIVE segments. But
 * `app_usage` has no meaningful way to union: if VS Code runs on the desktop
 * and YouTube on the laptop at the same moment, "whose second is it?" has no
 * correct answer, and picking one would silently become policy.
 *
 * So the **sum** is used here, and that is stated explicitly:
 * - **Ratios (scorePct, sharePct) hold**: numerator and denominator grow
 *   proportionally.
 * - **Absolute seconds are not worked hours**: never reconcile them with
 *   `credited_sec`, and they never enter pay calculations.
 */
const OVERLAP_CAVEAT =
  'When one person runs more than one device the time is added up (§ 2.1-c) — the ratios stay correct, but the absolute seconds must not be treated as worked hours';

@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  // ── D07 · daily productivity score ────────────────────────────────────────────

  async productivity(query: EmployeeRangeQueryDto): Promise<ProductivityReport> {
    const range = this.range(query);
    const employees = await this.employees(query.employeeId);

    const [groups, meta] = await Promise.all([
      this.prisma.appUsage.groupBy({
        by: ['employeeId', 'workDate', 'categoryId'],
        where: this.where(range, employees.map((e) => e.id)),
        _sum: { durationSec: true },
      }),
      this.categoryMeta(),
    ]);

    const folded = foldDailyScores(
      groups.map((g) => ({
        employeeId: g.employeeId,
        workDate: g.workDate,
        categoryId: g.categoryId,
        seconds: g._sum.durationSec ?? 0,
      })),
      meta,
    );

    return {
      from: toDateKey(range.from),
      to: toDateKey(range.to),
      // People with no rows at all stay in the list too: dropping a zero day
      // silently would make "agent off" look the same as "all fine".
      employees: employees.map((e) => {
        const rows = folded.get(e.id);
        return {
          employeeId: e.id,
          empCode: e.empCode,
          fullName: e.fullName,
          days: rows?.days ?? [],
          total: rows?.total ?? scoreOf(emptyBuckets()),
        };
      }),
      caveat: OVERLAP_CAVEAT,
    };
  }

  // ── D08 · top 10 apps and sites ───────────────────────────────────────────────

  async top(query: TopQueryDto): Promise<TopReport> {
    const range = this.range(query);
    const employeeIds =
      query.employeeId === undefined
        ? undefined
        : (await this.employees(query.employeeId)).map((e) => e.id);

    const where = this.where(range, employeeIds);
    const limit = query.limit ?? TOP_N;

    const [appGroups, siteGroups, meta] = await Promise.all([
      this.prisma.appUsage.groupBy({
        by: ['processName', 'categoryId'],
        where,
        _sum: { durationSec: true },
        _count: { _all: true },
      }),
      this.prisma.appUsage.groupBy({
        by: ['domain', 'categoryId'],
        // Careful: if rows with no domain (apps that are not browsers) entered the
        // site list, a row named "(empty)" would sit at the very top.
        where: { ...where, domain: { not: null } },
        _sum: { durationSec: true },
        _count: { _all: true },
      }),
      this.categoryMeta(),
    ]);

    return {
      from: toDateKey(range.from),
      to: toDateKey(range.to),
      employeeId: query.employeeId ?? null,
      apps: foldUsage(
        appGroups.map((g) => ({
          key: g.processName,
          categoryId: g.categoryId,
          seconds: g._sum.durationSec ?? 0,
          records: g._count._all,
        })),
        meta,
        'app',
        limit,
      ),
      sites: foldUsage(
        siteGroups
          .filter((g): g is typeof g & { domain: string } => g.domain !== null)
          .map((g) => ({
            key: g.domain,
            categoryId: g.categoryId,
            seconds: g._sum.durationSec ?? 0,
            records: g._count._all,
          })),
        meta,
        'site',
        limit,
      ),
      // Careful: app and site time **cannot be added**: the 1 hour on youtube.com
      // is inside chrome.exe's 3 hours. The two lists are two different cuts of
      // the same time, not two separate parts.
      caveat: `${OVERLAP_CAVEAT}. App time and site time are two different breakdowns of the same time — they must not be added together`,
    };
  }

  // ── D09 · per-team site summary ───────────────────────────────────────────────

  /**
   * How much time the whole team spent on each site.
   *
   * Careful: there is deliberately **no** `employeeId` filter. For one person's
   * numbers there is `/activity/top`. Merging the two would return "team habits"
   * and "one person's habits" in the same response shape, and you could not tell
   * which one you were looking at. Each row also carries `employees` and
   * `topEmployeeId`, so one person's time cannot be passed off as the team's.
   */
  async team(query: TeamQueryDto): Promise<TeamReport> {
    const range = this.range(query);

    const [groups, meta] = await Promise.all([
      this.prisma.appUsage.groupBy({
        by: ['domain', 'employeeId', 'categoryId'],
        where: { ...this.where(range), domain: { not: null } },
        _sum: { durationSec: true },
      }),
      this.categoryMeta(),
    ]);

    const rows = groups.filter(
      (g): g is typeof g & { domain: string } => g.domain !== null,
    );

    const report = foldTeamSites(
      rows.map((g) => ({
        domain: g.domain,
        employeeId: g.employeeId,
        categoryId: g.categoryId,
        seconds: g._sum.durationSec ?? 0,
      })),
      meta,
      query.limit ?? TOP_N,
    );

    return {
      ...report,
      from: toDateKey(range.from),
      to: toDateKey(range.to),
      employeesWithData: new Set(rows.map((g) => g.employeeId)).size,
      caveat: OVERLAP_CAVEAT,
    };
  }

  // ── shared helpers ────────────────────────────────────────────────────────────

  /**
   * Careful: the pure `resolveRange()` knows nothing about HTTP, so it throws a
   * `RangeError`. It is converted to a 400 here; otherwise a user's typo would
   * come back as a 500 Internal Server Error and pile up needless stack traces
   * in the log.
   */
  private range(query: RangeQueryDto): WorkDateRange {
    try {
      // "Today" means today in **Dhaka**, whatever the server's timezone.
      return resolveRange(query.from, query.to, workDateOf(new Date()));
    } catch (err) {
      if (err instanceof RangeError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  private where(
    range: WorkDateRange,
    employeeIds?: number[],
  ): Prisma.AppUsageWhereInput {
    return {
      workDate: { gte: range.from, lte: range.to },
        // R22a - only fragments seen as ACTIVE are counted. Rows seen while idle
        // are now stored (to detect meetings) but go into no calculation.
        segmentState: SegmentState.active,
      ...(employeeIds === undefined ? {} : { employeeId: { in: employeeIds } }),
    };
  }

  /**
   * Careful: `monthly_salary` is **never** selected. The only place that reads
   * it is `PayrollService`, which is owner-only and audited (ADR-023). Without
   * an explicit `select` here the whole Employee row would come back, and salary
   * would leak into the manager's response too.
   */
  private async employees(
    employeeId?: number,
  ): Promise<Array<{ id: number; empCode: string; fullName: string }>> {
    const rows = await this.prisma.employee.findMany({
      where: employeeId === undefined ? { status: 'active' } : { id: employeeId },
      select: { id: true, empCode: true, fullName: true },
      orderBy: { empCode: 'asc' },
    });

    if (employeeId !== undefined && rows.length === 0) {
      throw new NotFoundException(`No staff member with id ${employeeId}`);
    }

    return rows;
  }

  /**
   * id -> category identity. About 110 rows, so reading all of them each time
   * is the simplest approach.
   *
   * Careful: the `AppCategoryService` cache is **not used**. It holds
   * `compile()`d rules, which drop rules with a bad regex. Reports can still
   * contain old rows carrying such a rule's id; going through the cache would
   * silently show them as "unknown", although the category is stored in the
   * database.
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
}
