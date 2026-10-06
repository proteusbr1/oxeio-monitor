import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  compile,
  matchCategory,
  type CompiledRule,
  type UsageFacts,
} from './category-matcher';

/** How much one page of recategorize() needs. */
interface UsageRow {
  id: bigint;
  processName: string;
  domain: string | null;
  windowTitle: string | null;
  categoryId: number | null;
}

/**
 * Hold and apply the category rules (D05).
 *
 * Rules change rarely: the owner occasionally adds a domain (D06).
 * But ingest needs them for every row, and at busy times batches arrive from
 * 15 PCs every 5 minutes. Hence the cache.
 */
@Injectable()
export class AppCategoryService {
  private readonly logger = new Logger(AppCategoryService.name);

  /**
   * Cache lifetime. Once D06 exists, <see cref="invalidate"/> is called
   * immediately; until then this TTL ensures that a changed seed takes effect
   * within five minutes, without a server restart.
   */
  private static readonly TtlMs = 5 * 60_000;

  private cache: { rules: CompiledRule[]; at: number } | null = null;

  /**
   * Careful: if several batches arrive together, each would go to the DB
   * separately. They all share one in-flight promise instead.
   */
  private loading: Promise<CompiledRule[]> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Must be called when the rules change (D06); the next call re-reads them. */
  invalidate(): void {
    this.cache = null;
  }

  async rules(now = Date.now()): Promise<CompiledRule[]> {
    if (this.cache && now - this.cache.at < AppCategoryService.TtlMs) {
      return this.cache.rules;
    }

    this.loading ??= this.load(now).finally(() => {
      this.loading = null;
    });

    return this.loading;
  }

  private async load(now: number): Promise<CompiledRule[]> {
    const raw = await this.prisma.appCategory.findMany({
      select: {
        id: true,
        matchType: true,
        pattern: true,
        displayName: true,
        category: true,
        priority: true,
      },
    });

    const rules = compile(raw);

    if (rules.length < raw.length) {
      // compile() drops only invalid or empty patterns, and not silently.
      this.logger.warn(
        `${raw.length - rules.length} category rules were skipped (invalid regex or empty pattern)`,
      );
    }

    this.cache = { rules, at: now };
    return rules;
  }

  /**
   * The category a row falls into; <c>null</c> if nothing matches.
   *
   * Careful: an unknown app is never forced to "neutral". null and neutral
   * differ: null means "we do not know", neutral means "we know, and it is
   * neutral". Merging them would silently count unknown apps on the good side
   * of the D07 score, and we could not tell which apps are still outside the
   * rules.
   */
  async categoryIdFor(facts: UsageFacts): Promise<number | null> {
    const rules = await this.rules();
    return matchCategory(rules, facts)?.id ?? null;
  }

  /**
   * Recategorize old rows.
   *
   * Needed at two times: when rules change (D06: old rows hold the old
   * decision), and for rows stored before the rules existed.
   *
   * Careful: done page by page. A month brings about a hundred thousand rows
   * from 15 PCs, which cannot all be loaded into memory at once.
   */
  async recategorize(
    options: { onlyUnmatched?: boolean; pageSize?: number } = {},
  ): Promise<{ scanned: number; changed: number }> {
    const rules = await this.rules();
    const pageSize = options.pageSize ?? 2_000;

    let cursor: bigint | null = null;
    let scanned = 0;
    let changed = 0;

    for (;;) {
      // Careful: the type is written by hand. `cursor` comes from inside `page`,
      // and `page`'s type comes from a `cursor`-dependent where; TypeScript
      // cannot break the cycle.
      const page: UsageRow[] = await this.prisma.appUsage.findMany({
        where: {
          ...(options.onlyUnmatched === true ? { categoryId: null } : {}),
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        select: {
          id: true,
          processName: true,
          domain: true,
          windowTitle: true,
          categoryId: true,
        },
        orderBy: { id: 'asc' },
        take: pageSize,
      });

      if (page.length === 0) break;

      scanned += page.length;
      cursor = page[page.length - 1].id;

      // Careful: not one UPDATE per row; all rows going to the same category are
      // updated together. Otherwise a 2000-row page would mean 2000 round-trips.
      const byCategory = new Map<number | null, bigint[]>();

      for (const row of page) {
        const next = matchCategory(rules, row)?.id ?? null;
        if (next === row.categoryId) continue;

        const bucket = byCategory.get(next);
        if (bucket) bucket.push(row.id);
        else byCategory.set(next, [row.id]);
      }

      for (const [categoryId, ids] of byCategory) {
        await this.prisma.appUsage.updateMany({
          where: { id: { in: ids } },
          data: { categoryId },
        });
        changed += ids.length;
      }

      if (page.length < pageSize) break;
    }

    this.logger.log(`Recategorised: ${scanned} scanned, ${changed} changed`);
    return { scanned, changed };
  }
}
