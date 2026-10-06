import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { AuditLogQueryDto } from './audit-log.dto';

const DEFAULT_PAGE_SIZE = 50;

export interface AuditLogRow {
  /**
   * Careful: **a string, not a number.** `audit_log.id` is a `BigInt` in the
   * schema, and `app.setup.ts` has **no** JSON serializer for BigInt (this was
   * verified). Sending a raw BigInt in the response would make `JSON.stringify`
   * throw at runtime: "Do not know how to serialize a BigInt", so the whole
   * endpoint would return 500, while typecheck would pass silently because
   * there is no mistake at the type level.
   *
   * Careful: `Number(id)` would not work either: beyond 9 quadrillion JS
   * numbers silently start going wrong.
   */
  id: string;
  occurredAt: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ipAddress: string | null;
  meta: Prisma.JsonValue;
  user: {
    id: number;
    email: string;
    fullName: string;
    role: string;
  } | null;
}

export interface AuditLogPage {
  rows: AuditLogRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/**
 * E11: audit log viewer, **owner-only**.
 *
 * Read-only. There is no path to write, delete or edit: a log that can be
 * changed is no longer evidence.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditLogQueryDto): Promise<AuditLogPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to) {
      // Careful: with a reversed range Postgres would silently return zero rows,
      // and the user would think nothing really happened in that period
      throw new BadRequestException('`from` must be before `to`');
    }

    const where: Prisma.AuditLogWhereInput = {
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.targetType === undefined
        ? {}
        : { targetType: query.targetType }),
      ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
      ...(from || to
        ? {
            occurredAt: {
              ...(from ? { gte: from } : {}),
              // Careful: `lte`, inclusive. So that nobody writing
              // `?to=2026-08-10T23:59:59Z` loses the last second.
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        // `occurredAt` alone is not enough: two rows can land in the same
        // millisecond (login + change_setting together), and then their order
        // is undefined. Page 1 and page 2 are separate queries, so if the order
        // shifted one row would show twice and another never. Adding `id` makes
        // the order total.
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          occurredAt: true,
          action: true,
          targetType: true,
          targetId: true,
          ipAddress: true,
          meta: true,
          // Careful: writing `include: { user: true }` would also send
          // `password_hash` in the response. So always an explicit select.
          user: {
            select: { id: true, email: true, fullName: true, role: true },
          },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      rows: rows.map((r) => ({
        id: String(r.id),
        occurredAt: r.occurredAt.toISOString(),
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        ipAddress: r.ipAddress,
        meta: r.meta ?? null,
        user: r.user,
      })),
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
    };
  }
}
