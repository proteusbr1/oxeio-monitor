import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Device } from '@prisma/client';

import { AlertsService } from '../alerts/alerts.service';
import {
  DEFAULT_INGEST_LIMITS,
  MAX_BACKFILL_DAYS,
  partitionByBounds,
  type IngestLimits,
  type Rejections,
} from './ingest-bounds';

/** Which upload the dropped rows came from, for the log and the alert */
export type IngestKind = 'segments' | 'app usage' | 'events' | 'screenshot';

/**
 * Applies `ingest-bounds.ts` to every upload and **says so** when rows are dropped.
 *
 * Careful: a drop is never silent. Rows dropped without a trace would show up
 * only as "their hours are low" at month end, and the suspicion would fall on
 * the staff member instead of on the agent (the same rule the agent follows
 * for its own outbox trims). So every drop is logged, and raises one
 * `ingest_rejected` alert per device per throttle window (`AlertsService`).
 */
@Injectable()
export class IngestBoundsService {
  private readonly logger = new Logger(IngestBoundsService.name);
  private readonly limits: IngestLimits;

  constructor(
    private readonly alerts: AlertsService,
    config: ConfigService,
  ) {
    /**
     * Careful: only the future allowance can be changed, and only for the
     * tests. Their fixtures sit at today's work-noon (`test/setup/clock.ts`),
     * which in the morning is hours ahead of the real clock. Production has no
     * reason to set it, and the other two bounds are not configurable at all:
     * they are what closes the hole.
     */
    const futureSec = Number(config.get<string>('INGEST_FUTURE_SKEW_SEC'));
    this.limits = {
      ...DEFAULT_INGEST_LIMITS,
      ...(Number.isFinite(futureSec) && futureSec > 0
        ? { futureSkewMs: futureSec * 1000 }
        : {}),
    };
  }

  partition<T>(
    device: Device,
    items: readonly T[],
    spanOf: (item: T) => { startedAt: Date; endedAt: Date },
    now = new Date(),
  ): { kept: T[]; rejected: Rejections } {
    return partitionByBounds(items, spanOf, device.enrolledAt, now, this.limits);
  }

  /** Log and alert; does nothing when nothing was dropped */
  async report(device: Device, kind: IngestKind, rejected: Rejections): Promise<void> {
    if (rejected.total === 0) return;

    const reasons = Object.entries(rejected.byReason)
      .map(([reason, n]) => `${n} ${reason.replace('_', ' ')}`)
      .join(', ');
    const range =
      rejected.earliest && rejected.latest
        ? `${rejected.earliest.toISOString()} → ${rejected.latest.toISOString()}`
        : 'unknown range';

    this.logger.warn(
      `device ${device.id}: ${rejected.total} ${kind} record(s) outside the allowed window dropped ` +
        `(${reasons}; ${range}; enrolled ${device.enrolledAt.toISOString()})`,
    );

    /**
     * Careful: an alert failing must not fail the upload. The rows are already
     * dropped and the agent is about to be told "ok"; a 500 here would make it
     * send the whole batch again, kept rows included.
     */
    try {
      await this.alerts.raise({
        type: 'ingest_rejected',
        severity: 'warning',
        deviceId: device.id,
        employeeId: device.employeeId,
        title: 'Agent data outside the allowed time window was dropped',
        detail:
          `${rejected.total} ${kind} record(s) were not stored (${reasons}). ` +
          'Hours in them were not credited. Expected after a PC was offline for more than ' +
          `${MAX_BACKFILL_DAYS} days, or re-enrolled with an old queue; otherwise this device may ` +
          'be sending invented times — check when it was added (Settings → Devices).',
        meta: {
          kind,
          count: rejected.total,
          byReason: rejected.byReason,
          earliest: rejected.earliest?.toISOString() ?? null,
          latest: rejected.latest?.toISOString() ?? null,
          enrolledAt: device.enrolledAt.toISOString(),
        },
      });
    } catch (error) {
      this.logger.error(`Could not raise the ingest_rejected alert: ${String(error)}`);
    }
  }
}
