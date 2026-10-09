import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

let h: Harness;
let owner: Session;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

const patch = (path: string, body: object) =>
  owner.http.patch(`/api/v1${path}`).set('X-CSRF-Token', owner.csrf).send(body);

describe('the measure on the policy', () => {
  it('defaults to active, 15 minutes', async () => {
    const res = await owner.http.get('/api/v1/work-policies').expect(200);
    expect(res.body.rows[0]).toMatchObject({
      hoursMeasure: 'active',
      presenceGapMin: 15,
    });
  });

  it('switching to presence queues the open months for recount', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await patch(`/work-policies/${policy.id}`, {
      hoursMeasure: 'presence',
      presenceGapMin: 20,
    }).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });

  it('a save that does not touch the measure queues nothing', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await patch(`/work-policies/${policy.id}`, { name: 'Renamed' }).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBe(0);
  });

  it('the gap must be 1–120 minutes', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await patch(`/work-policies/${policy.id}`, { presenceGapMin: 0 }).expect(
      400,
    );
    await patch(`/work-policies/${policy.id}`, { presenceGapMin: 121 }).expect(
      400,
    );
  });
});
