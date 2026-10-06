import { Injectable, Logger } from '@nestjs/common';

import { workDateOf } from '../agent/util/dhaka-time';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService, type RaiseInput } from './alerts.service';
import {
  findSyntheticInput,
  DEFAULT_SYNTHETIC_LIMITS,
  type ActiveSegment,
  type WindowSpan,
} from './synthetic-input.rules';

/**
 * **G46**: flag suspected synthetic input (mouse jiggler).
 *
 * Why this runs on the server, not in the agent: the agent runs on the staff
 * member's own machine. Any guard placed there can be stopped, altered or
 * bypassed by them, and worst of all **silently**. Instead, this looks at the
 * **shape** of the data that reaches the server, which cannot be hidden: to
 * claim hours the data must be sent, and once it is sent the shape shows.
 *
 * There are three ways to cheat, and each one is caught somewhere:
 *
 *   1. **Running a jiggler**: this rule catches it
 *   2. **Stopping the agent**: hours stop too, and `agent_down` is raised
 *   3. **Tampering with the agent**: `agent_tamper` is raised
 *
 * So evading the guard costs **lost hours**, and that is the real deterrent,
 * not any single technique.
 *
 * Careful: this is **a request to take a look, not an accusation**, and the
 * message is worded that way.
 */
@Injectable()
export class SyntheticInputCheck {
  private readonly logger = new Logger(SyntheticInputCheck.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
  ) {}

  async runOnce(now = new Date()): Promise<number> {
    const workDate = workDateOf(now);

    /**
     * Only `active`. Idle or locked segments are needed to **break** a
     * stretch, and that happens by itself: because they are not in the list a
     * gap in time appears, and `mergeActive` cuts the stretch there.
     */
    const segments = await this.prisma.activitySegment.findMany({
      where: { workDate, state: 'active' },
      select: {
        employeeId: true,
        deviceId: true,
        startedAt: true,
        endedAt: true,
        inputScore: true,
      },
      orderBy: { startedAt: 'asc' },
    });

    if (segments.length === 0) return 0;

    const usage = await this.prisma.appUsage.findMany({
      where: { workDate },
      select: {
        employeeId: true,
        deviceId: true,
        startedAt: true,
        endedAt: true,
        processName: true,
        windowTitle: true,
      },
    });

    /**
     * **Grouped by device, not by employee.** If someone's two PCs run at the
     * same time (G32), their segments would merge into one long "unbroken"
     * stretch, and an honest employee working on two machines would fall under suspicion.
     */
    const byDevice = new Map<
      string,
      { employeeId: number; deviceId: number; segments: ActiveSegment[]; usage: WindowSpan[] }
    >();

    const bucket = (employeeId: number, deviceId: number) => {
      const key = `${employeeId}:${deviceId}`;
      let found = byDevice.get(key);
      if (!found) {
        found = { employeeId, deviceId, segments: [], usage: [] };
        byDevice.set(key, found);
      }
      return found;
    };

    for (const s of segments) {
      bucket(s.employeeId, s.deviceId).segments.push({
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        inputScore: s.inputScore,
      });
    }

    for (const u of usage) {
      bucket(u.employeeId, u.deviceId).usage.push({
        startedAt: u.startedAt,
        endedAt: u.endedAt,
        /**
         * The process **and** the title. With the process alone, switching
         * tabs in the same browser would look like "no change", and someone
         * who works in the browser all day would fall under suspicion.
         *
         * Careful: the title is **not accumulated here and not written
         * anywhere**. It only builds a key for counting, and only the count
         * goes into the alert's `meta`. This alert does not reveal who opened which document.
         */
        key: `${u.processName}|${u.windowTitle ?? ''}`,
      });
    }

    const names = new Map(
      (
        await this.prisma.employee.findMany({
          where: { id: { in: [...new Set(segments.map((s) => s.employeeId))] } },
          select: { id: true, fullName: true },
        })
      ).map((e) => [e.id, e.fullName]),
    );

    const day = workDate.toISOString().slice(0, 10);
    const inputs: RaiseInput[] = [];

    for (const row of byDevice.values()) {
      for (const f of findSyntheticInput(row.segments, row.usage)) {
        const name = names.get(row.employeeId) ?? `employee ${row.employeeId}`;
        const hours = (f.durationSec / 3600).toFixed(1);

        inputs.push({
          type: 'synthetic_input' as const,
          /**
           * `warning`, not `critical`. This is suspicion, not proof, and the
           * damage a wrong "critical" does to a person cannot be undone.
           */
          severity: 'warning' as const,
          deviceId: row.deviceId,
          employeeId: row.employeeId,
          title: `Unbroken activity — ${name}`,
          detail:
            `${name} shows ${hours} hours of continuous activity on ${day} with no pause ` +
            `longer than a minute, only ${f.windows} foreground window the whole time, and an ` +
            `almost flat input pattern. People normally pause and switch windows, so this ` +
            `shape usually comes from a tool that keeps the machine awake. ` +
            `⚠️ It is not proof — check the screenshots for that stretch before saying anything.`,
          meta: {
            workDate: day,
            startedAt: f.startedAt.toISOString(),
            endedAt: f.endedAt.toISOString(),
            durationSec: f.durationSec,
            windows: f.windows,
            scoreSpread: f.scoreSpread,
            /**
             * The limits applied are recorded too, so after a limit changes
             * nobody has to guess why older alerts were raised.
             *
             * Careful: written field by field, not as a whole object. Prisma's
             * `InputJsonValue` does not accept an interface without an index signature.
             */
            minStretchSec: DEFAULT_SYNTHETIC_LIMITS.minStretchSec,
            maxWindows: DEFAULT_SYNTHETIC_LIMITS.maxWindows,
            maxScoreSpread: DEFAULT_SYNTHETIC_LIMITS.maxScoreSpread,
          },
        });
      }
    }

    if (inputs.length > 0) {
      this.logger.warn(`${inputs.length} unbroken-activity stretch(es) flagged for review`);
    }
    return this.alerts.raiseMany(inputs, now);
  }
}
