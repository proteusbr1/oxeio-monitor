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
 * The heartbeat's capability report: stored when it changes, one alert per
 * device while something is broken, resolved when it is fixed — and never a
 * 400, because a refused heartbeat also loses its commands.
 */

let h: Harness;
let device: EnrolledDevice;

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

const heartbeat = (capabilities?: unknown) =>
  h
    .http()
    .post('/api/v1/agent/heartbeat')
    .set('Authorization', `Bearer ${device.token}`)
    .set('X-Client-Time', iso(realNow()))
    .send({
      state: 'active',
      activeSecToday: 60,
      ...(capabilities === undefined ? {} : { capabilities }),
    });

const HEALTHY = {
  idleProbe: 'ok',
  appTracking: 'ok',
  browserDomain: 'ok',
  screenCapture: 'ok',
  screenActivity: 'ok',
  sync: 'ok',
};

const alerts = () =>
  h.prisma.alert.findMany({ where: { type: 'agent_capability' } });

const stored = async () =>
  (await h.prisma.device.findUniqueOrThrow({ where: { id: device.deviceId } }))
    .capabilities;

describe('capability report in the heartbeat', () => {
  it('an agent without the field: nothing stored, nothing raised', async () => {
    await heartbeat().expect(200);

    expect(await stored()).toBeNull();
    expect(await alerts()).toHaveLength(0);
  });

  it('a healthy report is stored and raises nothing', async () => {
    await heartbeat(HEALTHY).expect(200);

    expect(await stored()).toEqual(HEALTHY);
    expect(await alerts()).toHaveLength(0);
  });

  it('degraded is stored for the device list but raises no alert', async () => {
    await heartbeat({
      ...HEALTHY,
      browserDomain: 'degraded',
      sync: 'degraded',
    }).expect(200);

    expect(await stored()).toMatchObject({ browserDomain: 'degraded' });
    expect(await alerts()).toHaveLength(0);
  });

  it('a part that fails raises one alert, however many heartbeats repeat it', async () => {
    const broken = { ...HEALTHY, screenActivity: 'failed' };
    await heartbeat(broken).expect(200);
    await heartbeat(broken).expect(200);
    await heartbeat({ ...broken, browserDomain: 'failed' }).expect(200);

    const rows = await alerts();
    expect(rows).toHaveLength(1);
    // the open alert follows what is down now
    expect(rows[0].detail).toBe('Not working: Website domains, Jiggler check');
    expect(rows[0].resolvedAt).toBeNull();
  });

  it('back to healthy resolves the alert', async () => {
    await heartbeat({ ...HEALTHY, sync: 'failed' }).expect(200);
    await heartbeat(HEALTHY).expect(200);

    const [row] = await alerts();
    expect(row.resolvedAt).not.toBeNull();
  });

  it('flapping reopens the same alert instead of sending a new one', async () => {
    for (let i = 0; i < 3; i++) {
      await heartbeat({ ...HEALTHY, sync: 'failed' }).expect(200);
      await heartbeat(HEALTHY).expect(200);
    }
    await heartbeat({ ...HEALTHY, sync: 'failed' }).expect(200);

    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).toBeNull();
  });

  it('after the throttle window a new failure is a new alert', async () => {
    await heartbeat({ ...HEALTHY, sync: 'failed' }).expect(200);
    await heartbeat(HEALTHY).expect(200);
    // pretend that alert is from yesterday
    await h.prisma.alert.updateMany({
      where: { type: 'agent_capability' },
      data: { createdAt: new Date(realNow().getTime() - 24 * 3_600_000) },
    });

    await heartbeat({ ...HEALTHY, sync: 'failed' }).expect(200);

    expect(await alerts()).toHaveLength(2);
  });

  it('screenshots off by policy are not a fault', async () => {
    await heartbeat({ ...HEALTHY, screenCapture: 'disabled_by_policy' }).expect(
      200,
    );

    expect(await alerts()).toHaveLength(0);
  });

  it.each([
    ['a string', 'broken'],
    ['a list', ['ok']],
    ['unknown parts', { x: 1 }],
  ])('garbage (%s) is ignored, never a 400', async (_, raw) => {
    const res = await heartbeat(raw).expect(200);
    expect(res.body.commands).toBeDefined();
  });
});
