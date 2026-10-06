import { Injectable, Logger } from '@nestjs/common';

import { workDateOf } from '../agent/util/dhaka-time';
import { PrismaService } from '../prisma/prisma.service';
import { overlapSec, unionSec, type Span } from '../summary/summary.math';
import { shouldFlagOverlap } from './alerts.rules';
import { AlertsService, type RaiseInput } from './alerts.service';

/** Needed while accumulating; `DeviceSpans.spans` is readonly, hence a separate type */
interface MutableDeviceSpans {
  deviceId: number;
  spans: Span[];
}

/**
 * **G32**: two devices of the same staff member running at the same time.
 *
 * Until now `device_overlap` existed **in name only**: it was in the type
 * union, in the web filter, in ops' labels, and "an alert will be raised" was
 * written in three places in the spec, but **no code anywhere raised it**. So
 * the filter selected a kind of alert that had never been created.
 *
 * <b>This is not an accusation against anyone</b>, and the messages in this
 * class are worded carefully to say so. Overlap has no effect on the hours:
 * `worked_sec` is a UNION anyway (§ 2.1(c)), so time is not counted twice. The
 * spec names two common causes: one PC used by two people, or a forgotten
 * machine left on. Both are management information, not judgment.
 */
@Injectable()
export class DeviceOverlapCheck {
  private readonly logger = new Logger(DeviceOverlapCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    const workDate = workDateOf(now);

    /**
     * Raw `activity_segments`, not `daily_summary`, because the summary has no
     * per-device split (its primary key is employee + date). One could compute
     * `active_sec - worked_sec` from it, but that is the wrong calculation; see
     * the doc of `overlapSec()` for why.
     *
     * Only `countsAsWork`: idle or locked segments on two machines at once are
     * perfectly normal (one machine is just sitting locked), and there is
     * nothing to tell anyone about that.
     */
    const segments = await this.prisma.activitySegment.findMany({
      where: { workDate, countsAsWork: true },
      select: {
        employeeId: true,
        deviceId: true,
        startedAt: true,
        endedAt: true,
      },
      orderBy: { startedAt: 'asc' },
    });

    if (segments.length === 0) return 0;

    // employee -> device -> segments
    //
    // Careful: the grouping happens here, not in SQL. Computing overlap with
    // `GROUP BY` would need an interval merge in window functions, which could
    // be tested only with a database, and a mistake would put an alert
    // straight onto someone's name.
    const byEmployee = new Map<number, Map<number, MutableDeviceSpans>>();

    for (const s of segments) {
      let devices = byEmployee.get(s.employeeId);
      if (!devices) {
        devices = new Map();
        byEmployee.set(s.employeeId, devices);
      }

      let device = devices.get(s.deviceId);
      if (!device) {
        device = { deviceId: s.deviceId, spans: [] };
        devices.set(s.deviceId, device);
      }

      device.spans.push({ startedAt: s.startedAt, endedAt: s.endedAt });
    }

    const flagged: Array<{ employeeId: number; overlap: number; worked: number; devices: number }> =
      [];

    for (const [employeeId, devices] of byEmployee) {
      // Only one device: the whole calculation can be skipped
      if (devices.size < 2) continue;

      const list = [...devices.values()];
      const overlap = overlapSec(list);
      const worked = unionSec(list.flatMap((d) => d.spans));

      if (
        !shouldFlagOverlap({
          deviceCount: devices.size,
          overlapSec: overlap,
          workedSec: worked,
        })
      ) {
        continue;
      }

      flagged.push({ employeeId, overlap, worked, devices: devices.size });
    }

    if (flagged.length === 0) return 0;

    // Without names nobody could act on the message
    const names = new Map(
      (
        await this.prisma.employee.findMany({
          where: { id: { in: flagged.map((f) => f.employeeId) } },
          select: { id: true, fullName: true },
        })
      ).map((e) => [e.id, e.fullName]),
    );

    const day = workDate.toISOString().slice(0, 10);

    const inputs: RaiseInput[] = flagged.map((f) => {
      const name = names.get(f.employeeId) ?? `employee ${f.employeeId}`;
      const minutes = Math.round(f.overlap / 60);

      return {
        type: 'device_overlap' as const,
        severity: 'warning' as const,
        /**
         * `deviceId` is deliberately null: the event belongs to **both**
         * devices, not one. Picking either would tie the throttle key to that
         * device, and if the other were picked in the next hour the same
         * event on the same day would raise a second alert.
         */
        deviceId: null,
        employeeId: f.employeeId,
        title: `Two devices at once — ${name}`,
        detail:
          `${name} had ${f.devices} devices sending work at the same time on ${day} ` +
          `(${minutes} min of overlap). This does not change the hours — worked time is ` +
          'a union, so nothing is counted twice. It usually means one PC is shared, or a ' +
          'machine was left running and logged in.',
        meta: {
          workDate: day,
          overlapSec: f.overlap,
          workedSec: f.worked,
          deviceCount: f.devices,
        },
      };
    });

    this.logger.log(`${inputs.length} staff had two devices running at once`);
    return this.alerts.raiseMany(inputs, now);
  }
}
