import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/**
 * "Seen all": acknowledge every open alert at once.
 *
 * From the owner's complaint: when G01 ("agent silent") fires repeatedly on
 * 12 PCs, 118 warnings pile up, and pressing "Seen" one by one is a pain.
 *
 * This file guards two things: bulk-ack really touches every open row, and
 * it keeps the history of rows that were already seen (who saw them first).
 */
let h: Harness;
let owner: Session;

async function seedAlert(overrides: Record<string, unknown> = {}) {
  return h.prisma.alert.create({
    data: {
      type: 'agent_down',
      severity: 'warning',
      title: 'Agent silent — TEST',
      channelsSent: ['log'],
      ...overrides,
    },
  });
}

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

const ackAll = () =>
  owner.http
    .post('/api/v1/alerts/acknowledge-all')
    .set('X-CSRF-Token', owner.csrf);

describe('POST /alerts/acknowledge-all', () => {
  /** The main claim: every open row becomes seen with one click. */
  it('all open alerts are acknowledged at once', async () => {
    await seedAlert();
    await seedAlert();
    await seedAlert();

    const res = await ackAll().expect(200);
    expect(res.body.count).toBe(3);

    const open = await h.prisma.alert.count({ where: { acknowledgedAt: null } });
    expect(open).toBe(0);
  });

  /**
   * Careful: rows already seen are not touched. Otherwise the "who saw it
   * first" history would be wiped by this one click, and the evidence for
   * hour corrections would shift too.
   */
  it('the history of previously acknowledged rows stays intact', async () => {
    // Insert a previously seen row directly, fixing who saw it and when.
    // (The controller is owner-only, so a manager cannot be used to ack.)
    const seenBy = await h.prisma.user.findFirstOrThrow({
      where: { email: MANAGER_EMAIL },
    });
    const seenAt = new Date('2026-08-01T04:00:00.000Z');
    const already = await seedAlert({
      acknowledgedById: seenBy.id,
      acknowledgedAt: seenAt,
    });

    await seedAlert(); // one still open

    const res = await ackAll().expect(200);
    // Only the one remaining is counted, not the earlier one
    expect(res.body.count).toBe(1);

    const after = await h.prisma.alert.findUniqueOrThrow({
      where: { id: already.id },
    });
    expect(after.acknowledgedById).toBe(seenBy.id); // not changed to the owner
    expect(after.acknowledgedAt?.getTime()).toBe(seenAt.getTime());
  });

  it('with nothing open, count is zero, not an error', async () => {
    const res = await ackAll().expect(200);
    expect(res.body.count).toBe(0);
  });

  /** Owner-only, not even the manager (the controller's `@Roles(owner)`) */
  it('a manager cannot', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http
      .post('/api/v1/alerts/acknowledge-all')
      .set('X-CSRF-Token', manager.csrf)
      .expect(403);
  });

  /**
   * A route-matching trap: `acknowledge-all` must not be read as the `:id` of
   * `:id/acknowledge`. If it were, this would give a 404/400 "no alert named
   * acknowledge-all found". 200 plus count means it went to the right route.
   */
  it('acknowledge-all is its own route, not read as :id', async () => {
    await seedAlert();
    const res = await ackAll().expect(200);
    expect(res.body).toHaveProperty('count');
  });
});
