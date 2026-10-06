import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/** § 2 - the three steps in 02-Workflow. */
export const DRIFT_IGNORE_SEC = 5;
export const DRIFT_ALERT_SEC = 300;

/**
 * Namespace for the advisory lock (G169): any constant will do, as long as it
 * does not collide with another lock. The second key is `deviceId`, so two
 * **different** PCs never block each other.
 */
const CLOCK_DRIFT_LOCK = 8_413_001;

export interface Drift {
  /** server_time - client_time; positive = the PC's clock is behind. */
  seconds: number;
  level: 'none' | 'corrected' | 'alert';
}

@Injectable()
export class ClockDriftService {
  private readonly logger = new Logger(ClockDriftService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The difference between the agent's clock and the server's clock.
   * If `X-Client-Time` is absent, drift is taken as 0 (old agents).
   */
  measure(clientTime: Date | null, serverTime = new Date()): Drift {
    if (!clientTime || Number.isNaN(clientTime.getTime())) {
      return { seconds: 0, level: 'none' };
    }

    const seconds = Math.round(
      (serverTime.getTime() - clientTime.getTime()) / 1000,
    );
    const abs = Math.abs(seconds);

    if (abs <= DRIFT_IGNORE_SEC) return { seconds: 0, level: 'none' };
    if (abs <= DRIFT_ALERT_SEC) return { seconds, level: 'corrected' };
    return { seconds, level: 'alert' };
  }

  /**
   * Converts a time measured on the agent's clock to server time.
   * Careful: this does not change a segment's **length**, which comes from the
   * agent's monotonic clock and so survives clock changes (§ 3.2).
   */
  correct(t: Date, drift: Drift): Date {
    return drift.seconds === 0 ? t : new Date(t.getTime() + drift.seconds * 1000);
  }

  /** Record drift on the device, and raise an alert if it is large. */
  async record(
    deviceId: number,
    employeeId: number | null,
    drift: Drift,
  ): Promise<void> {
    if (drift.level === 'none') return;

    const abs = Math.abs(drift.seconds);

    /**
     * Careful: **`last_drift_sec` is no longer written here** (G170). It is
     * written with the `last_seen_at` UPDATE in `DeviceAuthGuard`, because this
     * method returns early on `level === 'none'`, so once the clock was
     * **corrected** the number never went back to zero.
     *
     * Only `max_drift_sec` is kept here: "how bad it ever got", which by
     * definition never decreases.
     *
     * Careful: the condition `max_drift_sec < abs` avoids a pointless write on
     * every request.
     */
    await this.prisma.$executeRaw`
      UPDATE devices
         SET max_drift_sec = ${abs}
       WHERE id = ${deviceId} AND max_drift_sec < ${abs}`;

    if (drift.level !== 'alert') return;

    /**
     * Careful: the agent sends data every minute; alerting every time would let
     * one PC with a wrong clock create about a thousand alerts a day.
     * So only one per 6 hours, and none until that one is acknowledged.
     *
     * **But "check, then insert" is a race** (G169).
     *
     * Careful: this method is called from `DeviceAuthGuard`, i.e. on **every
     * request**, not just the heartbeat. At startup the agent sends several
     * calls at once (segments, events, app usage, screenshots), and two calls
     * running `findFirst` at the same time would **both see "nothing there"**
     * and create two alerts.
     *
     * Seen in the field (OX-13): two identical "PC clock is wrong" alerts
     * **9 milliseconds apart** (09:17:00.180 and .189) with the same `driftSec`.
     * The owner saw them and said he did not want that.
     *
     * **An advisory lock, not a new column or index.** A partial unique index
     * would also work, but Prisma does not recognise it (an index with WHERE
     * cannot be expressed in its schema), so every later `migrate` would report
     * drift.
     * Careful: `pg_advisory_xact_lock` is released **by itself** when the
     * transaction ends, so it cannot be left held by mistake.
     */
    const created = await this.prisma.$transaction(async (tx) => {
      /**
       * Careful: **three details, and all three are required:**
       * - `$queryRaw`, not `$executeRaw`: this is a `SELECT`, not DML that
       *   returns a count;
       * - the `::int` cast, or Postgres cannot decide the bind-parameter type;
       * - `::text`: the function returns `void`, and Prisma cannot read a `void`
       *   column (*"Failed to deserialize column of type 'void'"*).
       */
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${CLOCK_DRIFT_LOCK}::int, ${deviceId}::int)::text AS locked`;

      const recent = await tx.alert.findFirst({
        where: {
          type: 'clock_drift',
          deviceId,
          acknowledgedAt: null,
          // Careful: "still open" = unacked **and** unresolved. If the previous one
          // is closed, a new drift really is new information and must not be suppressed.
          resolvedAt: null,
          createdAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
        },
        select: { id: true },
      });
      if (recent) return false;

      await tx.alert.create({
        data: {
          type: 'clock_drift',
          severity: 'warning',
          deviceId,
          employeeId,
          title: 'PC clock is wrong',
          detail:
            `${Math.round(abs / 60)} minutes off from the server. ` +
            'Turn on Windows time sync (w32time) on that PC.',
          meta: { driftSec: drift.seconds },
          channelsSent: [],
        },
      });

      return true;
    });

    if (created) {
      this.logger.warn(
        `device ${deviceId} clock is off by ${drift.seconds}s — raising an alert`,
      );
    }
  }
}
