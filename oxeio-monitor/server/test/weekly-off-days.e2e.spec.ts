import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  OWNER_EMAIL,
  OWNER_PASSWORD,
  createHarness,
  loginReady,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/**
 * `weeklyOffDays` through the API: a list now, validated at the door.
 * The math with several days off is in weekly-off-days.spec.ts.
 */

let h: Harness;
let owner: Session;
let policyId: number;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
  policyId = (await h.prisma.workPolicy.findFirstOrThrow()).id;
});

const patch = (body: object) =>
  owner.http
    .patch(`/api/v1/work-policies/${policyId}`)
    .set('X-CSRF-Token', owner.csrf)
    .send(body);

describe('weeklyOffDays', () => {
  it('the test policy keeps Friday, as a one-day list', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    expect(policy.weeklyOffDays).toEqual([5]);
  });

  it('Sat + Sun is saved and returned sorted', async () => {
    const res = await patch({ weeklyOffDays: [7, 6] }).expect(200);
    expect(res.body.weeklyOffDays).toEqual([6, 7]);
  });

  it('an empty list means every day is a workday', async () => {
    const res = await patch({ weeklyOffDays: [] }).expect(200);
    expect(res.body.weeklyOffDays).toEqual([]);
  });

  it.each([
    ['a day out of range', [8]],
    ['zero', [0]],
    ['a duplicate', [5, 5]],
    ['all seven days', [1, 2, 3, 4, 5, 6, 7]],
    ['a single number instead of a list', 5],
  ])('refuses %s', async (_, value) => {
    await patch({ weeklyOffDays: value }).expect(400);
  });
});
