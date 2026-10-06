import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { MatchType, Productivity } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { patternProblem } from './activity.math';
import { AppCategoryService } from './app-category.service';
import type {
  CreateCategoryDto,
  RecategorizeDto,
  UpdateCategoryDto,
} from './dto';

export interface CategoryRuleView {
  id: number;
  matchType: MatchType;
  pattern: string;
  displayName: string;
  category: Productivity;
  /** The smaller number wins. */
  priority: number;
}

export interface DeleteResult {
  deleted: CategoryRuleView;
  /**
   * Careful: how many rows had their category set to `null` by this delete.
   *
   * The FK is `ON DELETE SET NULL`, so the database itself turns those rows
   * into "unknown". Without returning the count, the owner would not learn that
   * deleting one rule pushed a thousand rows out of the D07 calculation.
   */
  orphanedRows: number;
  hint: string;
}

const SELECT = {
  id: true,
  matchType: true,
  pattern: true,
  displayName: true,
  category: true,
  priority: true,
} as const;

/**
 * D06 - the owner's category rules.
 *
 * **`AppCategoryService.invalidate()` must be called after every mutation.**
 * The rules are cached with a 5-minute TTL; if the cache is not cleared:
 *
 * 1. A new or changed rule would do nothing for up to five minutes. The owner
 *    would see the rule in the list while ingest kept applying the old decision.
 * 2. **The id of a deleted rule would stay in the cache**, and ingest would
 *    insert with that id, violate the foreign key and return a 500 for five
 *    minutes straight ([09 § 3a.11](../../../../docs/09-Build-Log.md)).
 *
 * Careful: with several API instances, `invalidate()` clears only **its own**
 * process's cache; the others rely on the TTL. v1 has a single container
 * (§ 6.1), so this is not a problem now, but it will be when scaling out.
 */
@Injectable()
export class CategoryService {
  private readonly logger = new Logger(CategoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: AppCategoryService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The list is in matcher order, so the owner sees the rules in the same order
   * in which they actually win ([category-matcher.ts](./category-matcher.ts),
   * `compile()`). Sorted alphabetically, the list would not answer "why is my
   * new rule not winning?".
   */
  async list(): Promise<CategoryRuleView[]> {
    return this.prisma.appCategory.findMany({
      select: SELECT,
      orderBy: [{ priority: 'asc' }, { pattern: 'asc' }, { id: 'asc' }],
    });
  }

  async create(
    dto: CreateCategoryDto,
    actorUserId: number,
    ip: string,
  ): Promise<CategoryRuleView> {
    this.assertPattern(dto.matchType, dto.pattern);

    const pattern = dto.pattern.trim();
    await this.assertNotDuplicate(dto.matchType, pattern, null);

    const rule = await this.prisma.appCategory.create({
      data: {
        matchType: dto.matchType,
        pattern,
        displayName: dto.displayName.trim(),
        category: dto.category,
        priority: dto.priority ?? 100,
      },
      select: SELECT,
    });

    // Right after the DB write, before the audit. Even if the audit fails (it
    // swallows its own errors), the cache must never be left stale.
    this.categories.invalidate();

    await this.audit.record({
      userId: actorUserId,
      action: 'change_setting',
      targetType: 'app_category',
      targetId: rule.id,
      ipAddress: ip,
      meta: { op: 'create', ...ruleMeta(rule) },
    });

    return rule;
  }

  async update(
    id: number,
    dto: UpdateCategoryDto,
    actorUserId: number,
    ip: string,
  ): Promise<CategoryRuleView> {
    const before = await this.prisma.appCategory.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!before) throw new NotFoundException(`No rule with id ${id}`);

    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('No fields were given to change');
    }

    // Careful: if `matchType` changes the pattern may stay the same while the
    // rule changes, so validation is always on the **final state**, not just on
    // what was submitted.
    const matchType = dto.matchType ?? before.matchType;
    const pattern = (dto.pattern ?? before.pattern).trim();
    this.assertPattern(matchType, pattern);
    await this.assertNotDuplicate(matchType, pattern, id);

    const rule = await this.prisma.appCategory.update({
      where: { id },
      data: {
        matchType,
        pattern,
        displayName: dto.displayName?.trim() ?? before.displayName,
        category: dto.category ?? before.category,
        priority: dto.priority ?? before.priority,
      },
      select: SELECT,
    });

    this.categories.invalidate();

    await this.audit.record({
      userId: actorUserId,
      action: 'change_setting',
      targetType: 'app_category',
      targetId: id,
      ipAddress: ip,
      // Both before and after; otherwise the audit would only say "someone changed something".
      meta: { op: 'update', before: ruleMeta(before), after: ruleMeta(rule) },
    });

    return rule;
  }

  async remove(
    id: number,
    actorUserId: number,
    ip: string,
  ): Promise<DeleteResult> {
    const rule = await this.prisma.appCategory.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!rule) throw new NotFoundException(`No rule with id ${id}`);

    // Count **before** deleting; afterwards every row already has null.
    const orphanedRows = await this.prisma.appUsage.count({
      where: { categoryId: id },
    });

    await this.prisma.appCategory.delete({ where: { id } });
    this.categories.invalidate();

    await this.audit.record({
      userId: actorUserId,
      action: 'change_setting',
      targetType: 'app_category',
      targetId: id,
      ipAddress: ip,
      meta: { op: 'delete', ...ruleMeta(rule), orphanedRows },
    });

    if (orphanedRows > 0) {
      this.logger.warn(
        `Deleting rule ${id} (${rule.pattern}) left ${orphanedRows} rows uncategorized — a recategorize run is needed`,
      );
    }

    return {
      deleted: rule,
      orphanedRows,
      hint:
        orphanedRows === 0
          ? 'No existing rows were using this rule'
          : `${orphanedRows} rows now have a null category — run POST /api/v1/categories/recategorize to see whether any other rule matches them`,
    };
  }

  /**
   * Apply the new rules to old rows.
   *
   * Careful: **the category is assigned at ingest, not when reading**, so after
   * a rule change old rows keep the old decision. Unless that is corrected, the
   * D07 score would follow the old rules for weeks while the list shows the new
   * rule.
   *
   * Careful: this work is **synchronous**; about a hundred thousand rows a month
   * can take several seconds. Since it is owner-only and rare, no background
   * queue was added; one would need a whole mechanism to report "when it
   * finished".
   */
  async recategorize(
    dto: RecategorizeDto,
    actorUserId: number,
    ip: string,
  ): Promise<{ scanned: number; changed: number }> {
    // Clear the cache first; otherwise the old rules would be used to apply
    // "new" ones, and the result would look successful.
    this.categories.invalidate();

    const result = await this.categories.recategorize({
      onlyUnmatched: dto.onlyUnmatched,
    });

    await this.audit.record({
      userId: actorUserId,
      action: 'change_setting',
      targetType: 'app_category',
      targetId: 'recategorize',
      ipAddress: ip,
      meta: { op: 'recategorize', onlyUnmatched: dto.onlyUnmatched ?? false, ...result },
    });

    return result;
  }

  /**
   * Validate the pattern at write time, because `compile()` **silently drops**
   * an invalid pattern. Without validation the rule would sit in the list and
   * never do anything.
   */
  private assertPattern(matchType: MatchType, pattern: string): void {
    const problem = patternProblem(matchType, pattern);
    if (problem !== null) throw new BadRequestException(problem);
  }

  /**
   * Careful: if the same (matchType, pattern) existed twice, the second would
   * never win (the matcher takes only the **first hit**). The owner would keep
   * changing the second one's category and see nothing happen. The database has
   * no unique constraint, so it is prevented here.
   */
  private async assertNotDuplicate(
    matchType: MatchType,
    pattern: string,
    exceptId: number | null,
  ): Promise<void> {
    const clash = await this.prisma.appCategory.findFirst({
      where: {
        matchType,
        pattern,
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
      select: { id: true },
    });

    if (clash) {
      throw new BadRequestException(
        `A rule of this kind for "${pattern}" already exists (id ${clash.id}) — edit that one instead`,
      );
    }
  }
}

/** What the audit records: not the whole row, just enough to understand it later. */
function ruleMeta(rule: CategoryRuleView): Record<string, string | number> {
  return {
    matchType: rule.matchType,
    pattern: rule.pattern,
    displayName: rule.displayName,
    category: rule.category,
    priority: rule.priority,
  };
}
