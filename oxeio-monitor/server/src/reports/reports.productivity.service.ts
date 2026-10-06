import { Injectable } from '@nestjs/common';
import { SegmentState, type Productivity } from '@prisma/client';

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
import { PrismaService } from '../prisma/prisma.service';
import type { ProductivityQuery } from './dto';
import { metaOf, ReportsContextService } from './reports.context.service';
import { ReportsExportService } from './reports.export.service';
import { secondsToHours, sharePct } from './reports.range';
import { productivityWorkbook } from './reports.sheets';
import type {
  ProductivityEmployeeRow,
  ProductivityItem,
  ProductivityReport,
  ReportFile,
} from './reports.types';

const DEFAULT_TOP = 25;

/**
 * F04 · productivity: where the time goes (top apps and sites, and per
 * employee), and its xlsx.
 *
 * **Categories never enter the pay calculation**: the productive/unproductive
 * split is for viewing only.
 */
@Injectable()
export class ReportsProductivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportContext: ReportsContextService,
    private readonly exporter: ReportsExportService,
  ) {}

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
    const ctx = await this.reportContext.context(q);
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

    return this.exporter.fileOf(
      'productivity',
      report.meta,
      report.top.length,
      'xlsx',
      { buffer, actorUserId, ip },
    );
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
