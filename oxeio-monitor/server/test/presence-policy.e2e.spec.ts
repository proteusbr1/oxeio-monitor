import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SummaryService } from '../src/summary/summary.service';
import { workNoon, workTodayIso } from './setup/clock';
import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
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

const DAY_MS = 86_400_000;

/** A pay period frozen through three days ago (work zone): days up to then are stated */
async function frozenThroughThreeDaysAgo(): Promise<Date> {
  const end = new Date(
    Date.parse(`${workTodayIso()}T00:00:00.000Z`) - 3 * DAY_MS,
  );
  await h.prisma.payPeriod.create({
    data: {
      startDate: new Date(end.getTime() - 20 * DAY_MS),
      endDate: end,
      snapshotAt: workNoon(-2),
      deliveryStatus: 'sent',
    },
  });
  return end;
}

/** The days queued for recount, oldest first */
const queued = async () =>
  (await h.prisma.summaryDirty.findMany({ orderBy: { workDate: 'asc' } })).map(
    (d) => d.workDate.getTime(),
  );

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

  it('with a frozen pay period, a measure change counts again only the days after it', async () => {
    const end = await frozenThroughThreeDaysAgo();
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await patch(`/work-policies/${policy.id}`, {
      hoursMeasure: 'presence',
    }).expect(200);
    const days = await queued();
    expect(days[0]).toBe(end.getTime() + DAY_MS);
    expect(days).toHaveLength(3);
  });

  it('a save that does not touch the measure queues nothing', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await patch(`/work-policies/${policy.id}`, { name: 'Renamed' }).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBe(0);
  });

  it('a save that re-sends the current values queues nothing', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await patch(`/work-policies/${policy.id}`, {
      name: 'X',
      hoursMeasure: 'active',
      presenceGapMin: 15,
    }).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBe(0);
  });

  it('changing only the gap on an active policy queues nothing', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await patch(`/work-policies/${policy.id}`, { presenceGapMin: 30 }).expect(
      200,
    );
    expect(await h.prisma.summaryDirty.count()).toBe(0);
  });

  it('changing the gap on a presence policy queues the open months', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await h.prisma.workPolicy.update({
      where: { id: policy.id },
      data: { hoursMeasure: 'presence' },
    });
    await patch(`/work-policies/${policy.id}`, { presenceGapMin: 30 }).expect(
      200,
    );
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
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

describe('switching the measure back', () => {
  it('presence to active restores credited = active time on an open month', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    const { employeeId, code } = await createEmployeeWithCode(h.prisma);
    const { deviceId } = await enrollDevice(h, code);
    const workDate = new Date('2026-10-05T00:00:00.000Z');
    const session = await h.prisma.workSession.create({
      data: {
        employeeId,
        deviceId,
        workDate,
        startedAt: new Date('2026-10-05T02:00:00Z'),
      },
    });
    // active stretches with a 10-minute pause between the first two (joined by presence)
    const stretches: [string, string][] = [
      ['2026-10-05T02:00:00Z', '2026-10-05T03:00:00Z'],
      ['2026-10-05T03:10:00Z', '2026-10-05T04:10:00Z'],
      ['2026-10-05T05:00:00Z', '2026-10-05T06:00:00Z'],
    ];
    for (const [from, to] of stretches) {
      const startedAt = new Date(from);
      const endedAt = new Date(to);
      await h.prisma.activitySegment.create({
        data: {
          sessionId: session.id,
          employeeId,
          deviceId,
          clientUuid: crypto.randomUUID(),
          workDate,
          state: 'active',
          startedAt,
          endedAt,
          durationSec: (endedAt.getTime() - startedAt.getTime()) / 1000,
          countsAsWork: true,
        },
      });
    }
    const refresh = () =>
      h.app
        .get(SummaryService)
        .refreshDate(workDate, new Date('2026-10-05T12:00:00Z'));
    const day = () =>
      h.prisma.dailySummary.findUniqueOrThrow({
        where: { employeeId_workDate: { employeeId, workDate } },
      });

    await patch(`/work-policies/${policy.id}`, {
      hoursMeasure: 'presence',
    }).expect(200);
    await refresh();
    const asPresence = await day();
    expect(asPresence.creditedSec).toBe(2 * 3600 + 10 * 60 + 3600);
    expect(asPresence.creditedSec).not.toBe(asPresence.workedSec);

    await h.prisma.summaryDirty.deleteMany();
    await patch(`/work-policies/${policy.id}`, {
      hoursMeasure: 'active',
    }).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);

    await refresh();
    const asActive = await day();
    expect(asActive.workedSec).toBe(3 * 3600);
    expect(asActive.creditedSec).toBe(asActive.workedSec);
  });
});

describe('moving a person to another policy', () => {
  /** A second policy, copied from the seeded one, with its own measure */
  async function secondPolicy(
    hoursMeasure: 'active' | 'presence',
    presenceGapMin = 15,
  ) {
    const { id: _id, ...base } = await h.prisma.workPolicy.findFirstOrThrow({
      orderBy: { id: 'asc' },
    });
    return h.prisma.workPolicy.create({
      data: { ...base, name: 'Second', hoursMeasure, presenceGapMin },
    });
  }

  it('to a policy with another measure queues the open months', async () => {
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    const presence = await secondPolicy('presence');
    await patch(`/employees/${employeeId}`, { policyId: presence.id }).expect(
      200,
    );
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });

  it('with a frozen pay period, moving a person counts again only the days after it', async () => {
    const end = await frozenThroughThreeDaysAgo();
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    const presence = await secondPolicy('presence');
    await patch(`/employees/${employeeId}`, { policyId: presence.id }).expect(
      200,
    );
    const days = await queued();
    expect(days[0]).toBe(end.getTime() + DAY_MS);
    expect(days).toHaveLength(3);
  });

  it('between two presence policies with different gaps queues the open months', async () => {
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    await h.prisma.workPolicy.updateMany({
      data: { hoursMeasure: 'presence', presenceGapMin: 15 },
    });
    const wider = await secondPolicy('presence', 30);
    await patch(`/employees/${employeeId}`, { policyId: wider.id }).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });

  it('between two active policies queues nothing', async () => {
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    const other = await secondPolicy('active', 30);
    await patch(`/employees/${employeeId}`, { policyId: other.id }).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBe(0);
  });
});
