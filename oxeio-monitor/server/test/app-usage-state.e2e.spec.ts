import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import { ActivityService } from '../src/activity/activity.service';
import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  iso,
  resetDatabase,
  todayWindow,
  type EnrolledDevice,
  type Harness,
  workNoon,
} from './setup/harness';

/**
 * R22a: the state a segment was seen in, on app_usage.
 *
 * From a problem measured in the field: the agent stopped watching apps the
 * moment it left ACTIVE, so an idle segment contained no rows at all, and
 * there was no way to recognise a meeting (sitting in Zoom).
 *
 * This file guards two things, both important in different ways:
 * 1. Old agents (which do not send the field) must not get a 400. A 400
 *    means Permanent to them, i.e. the data is deleted (G49).
 * 2. Idle rows must be stored but must not enter any calculation.
 */
let h: Harness;
let device: EnrolledDevice;

const usageItem = (over: Record<string, unknown> = {}) => {
  const w = todayWindow(600);
  return {
    clientUuid: randomUUID(),
    startedAt: iso(w.startedAt),
    endedAt: iso(w.endedAt),
    durationSec: w.durationSec,
    processName: 'zoom.exe',
    appName: 'Zoom',
    ...over,
  };
};

const post = (items: unknown[]) =>
  h
    .http()
    .post('/api/v1/agent/app-usage')
    .set('Authorization', `Bearer ${device.token}`)
    .send({ items });

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

describe('POST /agent/app-usage: segment state', () => {
  /**
   * The most important test. Everyone in the fleet is still on old agents,
   * and they do not send the `state` field. Making the field mandatory would
   * give every batch of theirs a 400, and the agent treats 400 as Permanent
   * and deletes the data (G49).
   */
  it('an old agent that sends no state still works, and is taken as active', async () => {
    await post([usageItem()]).expect(200);

    const row = await h.prisma.appUsage.findFirstOrThrow();
    expect(row.segmentState).toBe('active');
  });

  it('a segment in idle state is stored as idle', async () => {
    await post([usageItem({ state: 'idle' })]).expect(200);

    const row = await h.prisma.appUsage.findFirstOrThrow();
    expect(row.segmentState).toBe('idle');
  });

  it('an unknown state gives 400', async () => {
    await post([usageItem({ state: 'meeting' })]).expect(400);
  });

  /**
   * The core promise of R22a: being recorded and being counted are two
   * different things. A segment seen while idle stays in the database (for
   * R22b), but adds not a single second to the app totals (D07/D08).
   *
   * This is the rule that used to be protected by "do not record at all while
   * idle", and is now protected by a filter. If it broke, "left Excel open
   * and went to lunch" would count as usage.
   */
  it('an idle segment does not add to the app totals', async () => {
    const active = todayWindow(600);
    const idle = todayWindow(1200);

    await post([
      usageItem({
        state: 'active',
        startedAt: iso(active.startedAt),
        endedAt: iso(active.endedAt),
        durationSec: active.durationSec,
      }),
      usageItem({
        state: 'idle',
        startedAt: iso(idle.startedAt),
        endedAt: iso(idle.endedAt),
        durationSec: idle.durationSec,
      }),
    ]).expect(200);

    // Both are in the database
    expect(await h.prisma.appUsage.count()).toBe(2);

    /**
     * Careful: the Dhaka date, not UTC's. This repeats G62 exactly, and was
     * another sleeping time bomb (it went off at 00:03 on 22 August).
     *
     * `new Date().toISOString()` gives UTC, and Dhaka is UTC+6, so between
     * midnight and 06:00 the UTC date is the previous day. The query then went
     * to the wrong day, the `zoom` row was not found, and the test broke
     * though the code had no bug. Ingest itself picks the day with
     * `workDateOf()`, so the test should use the same.
     */
    const day = workDateOf(workNoon()).toISOString().slice(0, 10);
    const top = await h.app
      .get(ActivityService)
      .top({ from: day, to: day, limit: 10 });

    const zoom = top.apps.rows.find((r) => r.key === 'zoom.exe');
    // Only the ACTIVE segment: the 1200 idle seconds were not added
    expect(zoom?.seconds).toBe(active.durationSec);
  });
});
