import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  iso,
  realNow,
  resetDatabase,
  type EnrolledDevice,
  type Harness,
} from './setup/harness';

/**
 * Clock drift: one alert, and the number never goes stale
 * (G169, G170).
 *
 * G169, the bug this file guards: `ClockDriftService.record()` is called from
 * `DeviceAuthGuard`, i.e. on every request. At startup the agent sends
 * several calls at once (segments, events, app usage, screenshots), and
 * "check first, then insert" had no lock, so two calls would both see
 * "nothing there" and create two alerts.
 *
 * Caught in the field (OX-13): two identical "PC clock is wrong" alerts, 9
 * milliseconds apart, with the same `driftSec`. The owner saw them and said
 * he did not want this.
 *
 * G170: `last_drift_sec` was written only by `record()`, which returns early
 * when `level === 'none'`. So after the clock was corrected, the old large
 * number stayed forever. In the field OX-13's clock was fixed within a few
 * minutes, yet the fleet list kept showing 54,223 seconds.
 */
let h: Harness;
let device: EnrolledDevice;

/** `DRIFT_ALERT_SEC` is 300, so go well above it to get an alert */
const BIG_DRIFT_SEC = 15 * 3600;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  const { code } = await createEmployeeWithCode(h.prisma);
  device = await enrollDevice(h, code);
});

/**
 * A cheap authenticated call. The important part is the header, because
 * drift is measured and written in the guard, not in the controller.
 */
const ping = (driftSec: number) =>
  h
    .http()
    .get('/api/v1/agent/config')
    .set('Authorization', `Bearer ${device.token}`)
    // The clock is behind: server minus client is positive, like the real case
    .set('X-Client-Time', iso(new Date(realNow().getTime() - driftSec * 1000)));

const driftAlerts = () =>
  h.prisma.alert.findMany({ where: { type: 'clock_drift' } });

const deviceRow = () =>
  h.prisma.device.findUniqueOrThrow({ where: { id: device.deviceId } });

describe('G169: simultaneous calls together make one alert', () => {
  /**
   * The main test of this file: twelve calls at once, exactly as the agent
   * sends them at startup.
   *
   * Removing the lock turns this red: more than one alert gets created.
   */
  it('twelve parallel calls still give one alert', async () => {
    await Promise.all(
      Array.from({ length: 12 }, () => ping(BIG_DRIFT_SEC).expect(200)),
    );

    expect(await driftAlerts()).toHaveLength(1);
  });

  /** Back-to-back calls give one too: the 6-hour throttle works as before */
  it('back-to-back calls give one as well', async () => {
    await ping(BIG_DRIFT_SEC).expect(200);
    await ping(BIG_DRIFT_SEC).expect(200);
    await ping(BIG_DRIFT_SEC).expect(200);

    expect(await driftAlerts()).toHaveLength(1);
  });

  /**
   * Careful: two PCs do not block each other. The lock is per `deviceId`, so
   * both must get their own alert. If the lock were on the whole table, the
   * second PC's news would be silently suppressed.
   */
  it('two different PCs get two different alerts', async () => {
    const { code } = await createEmployeeWithCode(h.prisma, 'OX-CD2');
    const other = await enrollDevice(h, code, {
      hostname: 'PC-CD2',
      windowsUsername: 'cd2',
      machineGuid: 'guid-test-cd2',
    });

    const stale = iso(new Date(realNow().getTime() - BIG_DRIFT_SEC * 1000));

    await Promise.all([
      ping(BIG_DRIFT_SEC).expect(200),
      h
        .http()
        .get('/api/v1/agent/config')
        .set('Authorization', `Bearer ${other.token}`)
        .set('X-Client-Time', stale)
        .expect(200),
    ]);

    expect(await driftAlerts()).toHaveLength(2);
  });

  /** With a correct clock there is no alert at all: a safety net */
  it('no alert when the clock is right', async () => {
    await ping(0).expect(200);

    expect(await driftAlerts()).toHaveLength(0);
  });
});

describe('G170: when the clock is fixed, the number is fixed too', () => {
  /**
   * The main test of this block. Before, once `last_drift_sec` was set it
   * never went down, because `record()` returns early when
   * `level === 'none'`.
   */
  it('last_drift_sec returns to zero once the clock matches', async () => {
    await ping(BIG_DRIFT_SEC).expect(200);
    expect((await deviceRow()).lastDriftSec).toBe(BIG_DRIFT_SEC);

    // Now the Windows clock has been synced
    await ping(0).expect(200);

    expect((await deviceRow()).lastDriftSec).toBe(0);
  });

  /**
   * Careful: `max_drift_sec` does not go down. It answers a different
   * question: "how bad did it ever get". The history must not be erased once
   * the clock is right; otherwise a PC whose clock keeps wandering would look
   * innocent forever.
   */
  it('but max_drift_sec keeps the history', async () => {
    await ping(BIG_DRIFT_SEC).expect(200);
    await ping(0).expect(200);

    const row = await deviceRow();
    expect(row.lastDriftSec).toBe(0);
    expect(row.maxDriftSec).toBe(BIG_DRIFT_SEC);
  });

  /**
   * A small drift (under 5 s) is deliberately ignored: network delay alone
   * causes that much. So it is stored as 0.
   */
  it('a drift under five seconds stays zero', async () => {
    await ping(3).expect(200);

    const row = await deviceRow();
    expect(row.lastDriftSec).toBe(0);
    expect(row.maxDriftSec).toBe(0);
  });
});
