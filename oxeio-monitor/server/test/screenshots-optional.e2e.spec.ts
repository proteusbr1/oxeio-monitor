import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  OWNER_EMAIL,
  OWNER_PASSWORD,
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  iso,
  loginReady,
  realNow,
  resetDatabase,
  type EnrolledDevice,
  type Harness,
} from './setup/harness';

/**
 * Screenshots can be turned off per work policy.
 *
 * Default on, so an existing deployment keeps taking screenshots after the
 * migration. Off reaches the agent as `screenshot.enabled = false`; the agent
 * then skips the screenshot but keeps sampling the screen for the jiggler
 * check (G46), which is why the hours do not change.
 */

let h: Harness;
let device: EnrolledDevice;
let employeeId: number;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  const created = await createEmployeeWithCode(h.prisma);
  employeeId = created.employeeId;
  const code = created.code;
  device = await enrollDevice(h, code);
});

const agentConfig = async () =>
  (
    await h
      .http()
      .get('/api/v1/agent/config')
      .set('Authorization', `Bearer ${device.token}`)
      .set('X-Client-Time', iso(realNow()))
      .expect(200)
  ).body as { version: string; config: { screenshot: { enabled: boolean } } };

describe('screenshot.enabled', () => {
  it('is on by default — nothing changes for an existing deployment', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    expect(policy.screenshotsEnabled).toBe(true);

    const { config } = await agentConfig();
    expect(config.screenshot.enabled).toBe(true);
  });

  it('the owner turns it off and the agent is told, with a new config version', async () => {
    const before = await agentConfig();
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await owner.http
      .patch(`/api/v1/work-policies/${policy.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ screenshotsEnabled: false })
      .expect(200);
    expect(res.body.screenshotsEnabled).toBe(false);

    const after = await agentConfig();
    expect(after.config.screenshot.enabled).toBe(false);
    // a new version is what makes the agent fetch the config again
    expect(after.version).not.toBe(before.version);
  });

  it('refuses anything but a boolean', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    await owner.http
      .patch(`/api/v1/work-policies/${policy.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ screenshotsEnabled: 'no' })
      .expect(400);
  });

  it('the gallery says why a day is empty when the policy takes no screenshots', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const gallery = () =>
      owner.http
        .get(`/api/v1/screenshots?employeeId=${employeeId}`)
        .expect(200);

    expect((await gallery()).body.screenshotsOff).toBe(false);

    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await owner.http
      .patch(`/api/v1/work-policies/${policy.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ screenshotsEnabled: false })
      .expect(200);

    expect((await gallery()).body.screenshotsOff).toBe(true);
  });
});
