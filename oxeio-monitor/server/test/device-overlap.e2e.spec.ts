import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DeviceOverlapCheck } from '../src/alerts/device-overlap.check';
import { workDateOf } from '../src/agent/util/work-time';
import { createHarness, resetDatabase, type Harness,
  workNoon,
  realNow,
} from './setup/harness';

/**
 * **G32** — whether the `device_overlap` alert actually fires.
 *
 * The unit test (`device-overlap.spec.ts`) guards the calculation; this file
 * guards the producer, because the original G32 bug was its absence. The
 * type, label and filter all existed; nobody just raised the alert.
 */
let h: Harness;
let check: DeviceOverlapCheck;
let employeeId: number;
let deviceA: number;
let deviceB: number;

/**
 * Two different "now"s, and that is deliberate (G140).
 *
 * - `workDate` comes from `workNoon()` — the fixture's work day, 12 hours
 *   from both boundaries, so it does not break when the day rolls over at
 *   midnight.
 * - `runOnce()` gets the real clock, because the throttle is compared with
 *   the alert's `created_at`, which comes from the database's `now()`.
 *
 * The two were once merged and noon was sent; the test caught it at once:
 * when run early in the morning, the gap between noon and the DB's
 * `created_at` exceeded the 6-hour `THROTTLE_HOURS`, so the claim "a second
 * run raises nothing" failed. A pinned instant cannot be used unless the
 * app clock and the database clock are the same — that is the only valid
 * reason for `realNow()`.
 */
const workDate = workDateOf(workNoon());

/** An instant within that work day (hour + minute on the work-zone clock) */
const at = (hour: number, minute = 0): Date =>
  new Date(workDate.getTime() + (hour - 6) * 3_600_000 + minute * 60_000);

async function makeDevice(hostname: string): Promise<number> {
  const device = await h.prisma.device.create({
    data: {
      hostname,
      windowsUsername: 'alex',
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
    },
  });
  return device.id;
}

/** An ACTIVE segment on that device */
async function segment(deviceId: number, from: Date, to: Date): Promise<void> {
  const session = await h.prisma.workSession.create({
    data: { employeeId, deviceId, workDate, startedAt: from, endedAt: to },
  });

  await h.prisma.activitySegment.create({
    data: {
      sessionId: session.id,
      employeeId,
      deviceId,
      clientUuid: randomUUID(),
      workDate,
      state: 'active',
      startedAt: from,
      endedAt: to,
      durationSec: Math.round((to.getTime() - from.getTime()) / 1000),
      countsAsWork: true,
    },
  });
}

const alerts = () =>
  h.prisma.alert.findMany({ where: { type: 'device_overlap' } });

beforeAll(async () => {
  h = await createHarness();
  check = h.app.get(DeviceOverlapCheck);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);

  const policy = await h.prisma.workPolicy.findFirstOrThrow();
  const employee = await h.prisma.employee.create({
    data: { empCode: 'OX-32', fullName: 'Alex Silva', policyId: policy.id },
  });

  employeeId = employee.id;
  deviceA = await makeDevice('PC-DESK');
  deviceB = await makeDevice('PC-LAP');
});

describe('device_overlap — producer', () => {
  it('the alert fires when both run together for half an hour', async () => {
    await segment(deviceA, at(9), at(13));
    await segment(deviceB, at(12, 30), at(15));

    expect(await check.runOnce(realNow())).toBe(1);

    const [alert] = await alerts();
    expect(alert.severity).toBe('warning');
    expect(alert.employeeId).toBe(employeeId);
    // The device is null — the event belongs to two devices, not one
    expect(alert.deviceId).toBeNull();
    expect(alert.title).toContain('Alex Silva');

    const meta = alert.meta as { overlapSec: number; deviceCount: number };
    expect(meta.overlapSec).toBe(30 * 60);
    expect(meta.deviceCount).toBe(2);
  });

  /**
   * The most important test — one device, but many segments whose
   * `duration_sec` (monotonic clock) does not exactly match the wall-clock
   * time. If the calculation were `active_sec - worked_sec`, a false alert
   * would fire here, and that is the worst kind of mistake: it questions
   * someone's honesty about their work.
   */
  it('working all day on a single device — nothing fires', async () => {
    await segment(deviceA, at(9), at(12));
    await segment(deviceA, at(12), at(15));
    await segment(deviceA, at(15), at(18));

    expect(await check.runOnce(realNow())).toBe(0);
    expect(await alerts()).toHaveLength(0);
  });

  it('two devices but at different times — nothing fires', async () => {
    await segment(deviceA, at(9), at(13));
    await segment(deviceB, at(14), at(18));

    expect(await check.runOnce(realNow())).toBe(0);
  });

  /** 5 minutes — the normal picture of taking a laptop to a meeting */
  it('stays quiet for a small overlap', async () => {
    await segment(deviceA, at(9), at(13, 5));
    await segment(deviceB, at(13), at(17));

    expect(await check.runOnce(realNow())).toBe(0);
  });

  /**
   * The check runs once an hour and rereads all of the day's segments, so
   * the risk of the same alert being raised repeatedly on one day is real.
   * `AlertsService`'s 6-hour throttle is what prevents it.
   */
  it('a second run raises nothing (throttle)', async () => {
    await segment(deviceA, at(9), at(13));
    await segment(deviceB, at(12), at(15));

    expect(await check.runOnce(realNow())).toBe(1);
    expect(await check.runOnce(realNow())).toBe(0);
    expect(await alerts()).toHaveLength(1);
  });

  /**
   * One per day, even after 6 hours (6 September 2026, G166).
   *
   * The bug this guards: the test above ran twice at the same instant, so
   * the 6-hour throttle seemed sufficient. But the check runs every hour and
   * reads the whole work day's segments each time — once the condition is
   * true, it stays true for every later tick that day. So a new alert for the
   * same event every 6 hours, 3-4 a day, each one a separate email.
   *
   * In the field `agent_down`, on the same path, did exactly this: on 22
   * August each of 13 pairs fired exactly 4 times — 00:17, 06:19, 12:20,
   * 18:20.
   *
   * Here `created_at` is set by hand and `now` is pinned too, because
   * leaving it to the DB clock would make the claim depend on what time of
   * day the test runs (G140).
   */
  it('a second alert is not raised the same day even after 6 hours', async () => {
    await segment(deviceA, at(9), at(13));
    await segment(deviceB, at(12), at(15));

    expect(await check.runOnce(realNow())).toBe(1);

    // Moved to 1 AM — 19 hours from the evening tick, well outside the 6-hour
    // window, yet the same work day
    await h.prisma.alert.updateMany({ data: { createdAt: at(1) } });

    expect(await check.runOnce(at(20))).toBe(0);
    expect(await alerts()).toHaveLength(1);
  });

  /**
   * It fires again the next day — this test pays for the fix above. Per-day
   * silence must not turn into "silent forever": a new work day means a new
   * event, and the owner needs to know.
   */
  it('yesterday\'s alert does not block today\'s', async () => {
    await segment(deviceA, at(9), at(13));
    await segment(deviceB, at(12), at(15));

    expect(await check.runOnce(realNow())).toBe(1);

    // Yesterday 11 PM — outside the 6-hour window and not in today either
    await h.prisma.alert.updateMany({ data: { createdAt: at(-1) } });

    expect(await check.runOnce(at(20))).toBe(1);
    expect(await alerts()).toHaveLength(2);
  });

  /** idle segments on two machines at once are normal — one machine is left locked */
  it('idle segments are not counted', async () => {
    await segment(deviceA, at(9), at(17));

    const session = await h.prisma.workSession.create({
      data: {
        employeeId,
        deviceId: deviceB,
        workDate,
        startedAt: at(9),
        endedAt: at(17),
      },
    });
    await h.prisma.activitySegment.create({
      data: {
        sessionId: session.id,
        employeeId,
        deviceId: deviceB,
        clientUuid: randomUUID(),
        workDate,
        state: 'idle',
        startedAt: at(9),
        endedAt: at(17),
        durationSec: 8 * 3600,
        countsAsWork: false,
      },
    });

    expect(await check.runOnce(realNow())).toBe(0);
  });
});
