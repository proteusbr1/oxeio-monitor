import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AlertSeverity, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { type AlertType } from './alerts.constants';
import type { ListAlertsDto } from './alerts.dto';
import {
  dedupeKey,
  suppressFlood,
  alertFloor,
  type AlertKey,
} from './alerts.rules';

export interface RaiseInput extends AlertKey {
  severity: AlertSeverity;
  title: string;
  detail?: string;
  meta?: Prisma.InputJsonValue;
}

export interface AlertRow {
  /**
   * A string, not a number. `alerts.id` is a BIGSERIAL and Prisma returns it as
   * a `bigint`, and `JSON.stringify(1n)` throws a TypeError. app.setup.ts has
   * no global BigInt serializer, so unless it is converted by hand here every
   * request would return 500.
   */
  id: string;
  type: string;
  severity: AlertSeverity;
  title: string;
  detail: string | null;
  deviceId: number | null;
  deviceHostname: string | null;
  employeeId: number | null;
  employeeName: string | null;
  meta: Prisma.JsonValue;
  channelsSent: string[];
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  /** Closed by the server itself (the agent came back); a person did not acknowledge it */
  resolvedAt: string | null;
  createdAt: string;
}

export interface AlertPage {
  total: number;
  page: number;
  limit: number;
  /** How many are not yet acknowledged, whatever the filter */
  openCount: number;
  rows: AlertRow[];
}

const DEFAULT_LIMIT = 50;

const ROW_SELECT = {
  id: true,
  type: true,
  severity: true,
  title: true,
  detail: true,
  deviceId: true,
  employeeId: true,
  meta: true,
  channelsSent: true,
  acknowledgedAt: true,
  resolvedAt: true,
  createdAt: true,
  device: { select: { hostname: true } },
  employee: { select: { fullName: true } },
  acknowledgedBy: { select: { fullName: true } },
} satisfies Prisma.AlertSelect;

type AlertWithNames = Prisma.AlertGetPayload<{ select: typeof ROW_SELECT }>;

/**
 * Alert creation, listing and acknowledge.
 *
 * `raiseMany()` is the **only** door for inserting alerts. If every check
 * called `prisma.alert.create()` itself, the throttle would have to be written
 * separately in each one, and a mistake in one place would turn that reason
 * into hundreds of alerts overnight.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** One alert: `true` means it was really inserted, `false` means the throttle held it back */
  async raise(input: RaiseInput, now = new Date()): Promise<boolean> {
    return (await this.raiseMany([input], now)) === 1;
  }

  /**
   * The only place flood control happens.
   *
   * Careful: `clock_drift` is **not** inserted through here. src/agent/clock-drift.service.ts
   * already inserts it (with its own throttle). Inserting from two places
   * would create two alerts for one event, each needing its own acknowledge.
   * We only **send** those alerts (AlertDispatcher); we do not create them.
   */
  async raiseMany(inputs: readonly RaiseInput[], now = new Date()): Promise<number> {
    if (inputs.length === 0) return 0;

    const types = [...new Set(inputs.map((i) => i.type))];

    /**
     * **The query floor has to move back too.**
     *
     * Giving `suppressFlood()` a bigger window would not be enough: if the old
     * row is not fetched by this query it is missing from `lastRaisedByKey`,
     * and the rule would assume "there was nothing before" and insert the
     * alert. The filter would silently do nothing.
     *
     * The oldest floor is the one used; each candidate is later compared with
     * the floor for its **own** type (`isThrottledFor`).
     */
    const floor = types
      .map((type) => alertFloor(type, now))
      .reduce((a, b) => (a.getTime() < b.getTime() ? a : b));

    const recent = await this.prisma.alert.findMany({
      where: { type: { in: types }, createdAt: { gte: floor } },
      select: {
        type: true,
        deviceId: true,
        employeeId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const lastRaisedByKey = new Map<string, Date>();
    for (const row of recent) {
      const key = dedupeKey({
        type: row.type as AlertType,
        deviceId: row.deviceId,
        employeeId: row.employeeId,
      });
      // orderBy desc: the first one we meet is the latest
      if (!lastRaisedByKey.has(key)) lastRaisedByKey.set(key, row.createdAt);
    }

    const kept = suppressFlood(inputs, lastRaisedByKey, now);
    const suppressed = inputs.length - kept.length;
    if (kept.length === 0) {
      this.logger.debug(`${suppressed} alerts held back by throttle`);
      return 0;
    }

    await this.prisma.alert.createMany({
      data: kept.map((k) => ({
        type: k.type,
        severity: k.severity,
        deviceId: k.deviceId ?? null,
        employeeId: k.employeeId ?? null,
        title: k.title,
        detail: k.detail ?? null,
        meta: k.meta,
        // Empty: AlertDispatcher does the sending. Sending email here would slow
        // the checks down whenever SMTP is slow.
        channelsSent: [],
      })),
    });

    this.logger.warn(
      `${kept.length} new alerts: ${kept.map((k) => k.type).join(', ')}` +
        (suppressed > 0 ? ` (${suppressed} held back by throttle)` : ''),
    );

    return kept.length;
  }

  async list(query: ListAlertsDto): Promise<AlertPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;

    const where: Prisma.AlertWhereInput = {
      // "open" = acknowledgedAt and resolvedAt are both NULL. If rows closed by
      // the server (resolved) stayed in the open list, the count and the list would disagree.
      ...(query.status === 'all' ? {} : { acknowledgedAt: null, resolvedAt: null }),
      ...(query.type ? { type: query.type } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
    };

    const [total, openCount, rows] = await Promise.all([
      this.prisma.alert.count({ where }),
      // The only source for the badge and "N still open". Without excluding
      // resolved, alerts closed for returned agents would keep inflating the number.
      this.prisma.alert.count({ where: { acknowledgedAt: null, resolvedAt: null } }),
      this.prisma.alert.findMany({
        where,
        select: ROW_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { total, page, limit, openCount, rows: rows.map(toRow) };
  }

  /**
   * Acknowledge is idempotent, and **the first person's name stays**.
   *
   * Overwriting it with a new name on a second call would silently erase "who
   * actually responded", and that accountability is the whole point of an alert.
   */
  /**
   * **Mark every open alert as seen at once.** When the same thing keeps
   * arriving on 12 PCs, as with G01, pressing them one by one is a chore.
   *
   * Careful: only the ones **not yet acknowledged** (`acknowledgedAt: null`).
   * The `acknowledgedBy`/time of an already-seen row is not changed, otherwise
   * this one click would erase the "who saw it first" history.
   *
   * Careful: nothing is **deleted**. Acknowledge only means "read", so the
   * evidence for hour adjustments (`evidence_alert_id`) stays intact.
   */
  async acknowledgeAll(userId: number): Promise<{ count: number }> {
    const { count } = await this.prisma.alert.updateMany({
      // Only truly **open** rows: acknowledgedAt and resolvedAt both NULL.
      // Otherwise the number shown in the confirm (openCount, which excludes
      // resolved) would not match what the server touches.
      where: { acknowledgedAt: null, resolvedAt: null },
      data: { acknowledgedById: userId, acknowledgedAt: new Date() },
    });
    this.logger.log(`${count} alert(s) acknowledged in bulk by user ${userId}`);
    return { count };
  }

  /**
   * **The server closing an alert itself.** No person said "seen"; the
   * condition simply went away (the agent came back). So it uses a separate
   * `resolvedAt`, not `acknowledgedAt`: the "who saw it first" history stays
   * intact and the evidence for hour adjustments (`evidence_alert_id`) is
   * untouched. Nothing is deleted.
   *
   * Careful: idempotent. Already-closed rows are not touched again (the
   * `resolvedAt: null` condition), otherwise the reason and time would be
   * overwritten on every tick.
   */
  /** Every open alert of one type — for a check that no longer applies */
  async resolveOpenOfType(
    type: AlertType,
    reason: string,
    now = new Date(),
  ): Promise<number> {
    const open = await this.prisma.alert.findMany({
      where: { type, resolvedAt: null },
      select: { id: true },
    });
    return this.resolveMany(
      open.map((a) => a.id),
      reason,
      now,
    );
  }

  async resolveMany(
    ids: readonly bigint[],
    reason: string,
    now = new Date(),
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.prisma.alert.updateMany({
      where: { id: { in: [...ids] }, resolvedAt: null },
      data: { resolvedAt: now, resolvedReason: reason },
    });
    if (count > 0) {
      this.logger.log(`${count} alert(s) auto-resolved — ${reason}`);
    }
    return count;
  }

  async acknowledge(rawId: string, userId: number): Promise<AlertRow> {
    const id = parseAlertId(rawId);

    const existing = await this.prisma.alert.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('No such alert');

    await this.prisma.alert.updateMany({
      where: { id, acknowledgedAt: null },
      data: { acknowledgedById: userId, acknowledgedAt: new Date() },
    });

    const updated = await this.prisma.alert.findUniqueOrThrow({
      where: { id },
      select: ROW_SELECT,
    });
    return toRow(updated);
  }
}

/**
 * Careful: `ParseIntPipe` is not used. The id is a BIGINT, and `Number`
 * silently gives wrong values beyond 9,007 trillion. That many alerts will not
 * happen in practice, but code written on the assumption that "it won't
 * happen" is what produces the strangest bugs later.
 */
function parseAlertId(raw: string): bigint {
  if (!/^\d{1,19}$/.test(raw)) {
    throw new BadRequestException('Invalid alert id');
  }
  return BigInt(raw);
}

function toRow(a: AlertWithNames): AlertRow {
  return {
    id: a.id.toString(),
    type: a.type,
    severity: a.severity,
    title: a.title,
    detail: a.detail,
    deviceId: a.deviceId,
    deviceHostname: a.device?.hostname ?? null,
    employeeId: a.employeeId,
    employeeName: a.employee?.fullName ?? null,
    meta: a.meta,
    channelsSent: a.channelsSent,
    acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: a.acknowledgedBy?.fullName ?? null,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}
