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

  it('a part that degrades raises one alert, however many heartbeats repeat it', async () => {
    const broken = { ...HEALTHY, browserDomain: 'degraded' };
    await heartbeat(broken).expect(200);
    await heartbeat(broken).expect(200);
    await heartbeat({ ...broken, screenActivity: 'failed' }).expect(200);

    const rows = await alerts();
    expect(rows).toHaveLength(1);
    // the open alert follows what is broken now
    expect(rows[0].detail).toBe(
      'Website domains degraded · Jiggler check failed',
    );
    expect(rows[0].resolvedAt).toBeNull();
  });

  it('back to healthy resolves the alert', async () => {
    await heartbeat({ ...HEALTHY, sync: 'failed' }).expect(200);
    await heartbeat(HEALTHY).expect(200);

    const [row] = await alerts();
    expect(row.resolvedAt).not.toBeNull();
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
