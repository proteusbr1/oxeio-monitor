import { randomUUID } from 'node:crypto';

import { UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  hashPassword,
  iso,
  realNow,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * **M1 — staff could forge back-dated hours.**
 *
 * The attack, end to end: a staff member enrols an invented PC with their own
 * login (`/agent/enroll-login`), gets a device token, and posts `active`
 * segments for days they never worked. Nothing stopped it; the hours went
 * straight into the month.
 *
 * Careful: these tests use the **real** clock (`realNow()`): the bounds are
 * measured against the server's live `new Date()` and the device's real
 * `enrolled_at`, so pinned instants would make them lie. The test config
 * widens only the future allowance (to a day, for work-noon fixtures), so
 * "the future" here is two days ahead.
 */
let h: Harness;
let token: string;
let deviceId: number;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STAFF_EMAIL = 'alex@test.local';
const STAFF_PASSWORD = 'staff-password-123';

const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function asAgent<T extends { set(field: string, val: string): T }>(req: T): T {
  return req
    .set('Authorization', `Bearer ${token}`)
    .set('X-Client-Time', iso(realNow()));
}

const segment = (startedAt: Date, minutes: number) => ({
  clientUuid: randomUUID(),
  state: 'active',
  startedAt: iso(startedAt),
  endedAt: iso(new Date(startedAt.getTime() + minutes * 60_000)),
  durationSec: minutes * 60,
});

const postSegments = (segments: unknown[]) =>
  asAgent(h.http().post('/api/v1/agent/segments')).send({ segments }).expect(200);

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);

  const policy = await h.prisma.workPolicy.findFirstOrThrow();
  const employee = await h.prisma.employee.create({
    data: { empCode: 'OX-001', fullName: 'Alex Silva', policyId: policy.id },
  });
  await h.prisma.user.create({
    data: {
      email: STAFF_EMAIL,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      fullName: 'Alex Silva',
      role: UserRole.employee,
      employeeId: employee.id,
      mustChangePw: false,
    },
  });

  // exactly what the attacker does: their own login, a made-up machine
  const res = await h
    .http()
    .post('/api/v1/agent/enroll-login')
    .send({
      hostname: 'NOT-A-REAL-PC',
      windowsUsername: 'whoever',
      machineGuid: randomUUID(),
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
    })
    .expect(200);
  token = res.body.deviceToken;
  deviceId = res.body.deviceId;
});

describe('M1: a fresh device cannot claim time before it existed', () => {
  it('back-dated active segments are dropped, acked with a 200, and counted', async () => {
    const threeDaysAgo = new Date(realNow().getTime() - 3 * DAY);

    const res = await postSegments([
      segment(threeDaysAgo, 240),
      segment(new Date(threeDaysAgo.getTime() + DAY), 240),
    ]);

    // a 200, so the agent acks and never retries; the count says what happened
    expect(res.body).toMatchObject({ accepted: 0, duplicates: 0, rejected: 2 });
    expect(await h.prisma.activitySegment.count()).toBe(0);
    expect(await h.prisma.workSession.count()).toBe(0);
  });

  it('a mixed batch keeps the honest rows and drops only the forged ones', async () => {
    const now = realNow();
    const res = await postSegments([
      segment(new Date(now.getTime() - 2 * DAY), 480), // before enrolment
      segment(new Date(now.getTime() + 2 * DAY), 60), // in the future
      segment(new Date(now.getTime() - 2 * 60_000), 1), // just closed: honest
    ]);

    expect(res.body).toMatchObject({ accepted: 1, rejected: 2 });
    expect(await h.prisma.activitySegment.count()).toBe(1);
  });

  it('dropping raises one ingest_rejected alert for the device, not one per batch', async () => {
    const old = new Date(realNow().getTime() - 5 * DAY);
    await postSegments([segment(old, 60)]);
    await postSegments([segment(new Date(old.getTime() + HOUR), 60)]);

    const alerts = await h.prisma.alert.findMany({ where: { type: 'ingest_rejected' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ deviceId, severity: 'warning' });
    expect(alerts[0].meta).toMatchObject({
      kind: 'segments',
      count: 1,
      byReason: { before_enrolment: 1 },
    });
  });

  it('nothing dropped, no alert', async () => {
    await postSegments([segment(new Date(realNow().getTime() - 2 * 60_000), 1)]);
    expect(await h.prisma.alert.count({ where: { type: 'ingest_rejected' } })).toBe(0);
  });

  it('app usage and events get the same window', async () => {
    const old = new Date(realNow().getTime() - 3 * DAY);

    const usage = await asAgent(h.http().post('/api/v1/agent/app-usage'))
      .send({
        items: [
          {
            clientUuid: randomUUID(),
            startedAt: iso(old),
            endedAt: iso(new Date(old.getTime() + HOUR)),
            durationSec: 3600,
            processName: 'excel.exe',
          },
        ],
      })
      .expect(200);
    expect(usage.body).toMatchObject({ accepted: 0, rejected: 1 });

    const events = await asAgent(h.http().post('/api/v1/agent/events'))
      .send({ events: [{ clientUuid: randomUUID(), type: 'logoff', occurredAt: iso(old) }] })
      .expect(200);
    expect(events.body).toMatchObject({ accepted: 0, rejected: 1 });
  });

  it('a back-dated screenshot is acked (201) but not stored', async () => {
    const old = new Date(realNow().getTime() - 3 * DAY);

    const res = await asAgent(h.http().post('/api/v1/agent/screenshots'))
      .field(
        'meta',
        JSON.stringify({
          clientUuid: randomUUID(),
          slotStart: iso(old),
          capturedAt: iso(new Date(old.getTime() + 60_000)),
          monitorIndex: 0,
        }),
      )
      .attach('file', WEBP, { filename: 'shot.webp', contentType: 'image/webp' })
      .expect(201);

    expect(res.body).toMatchObject({ accepted: 0, duplicate: false });
    expect(await h.prisma.screenshot.count()).toBe(0);
  });
});

describe('M1: an honest PC that was offline keeps its queue', () => {
  /**
   * Enrolled long ago, offline for three weeks: everything in the queue is
   * after enrolment and inside the 32-day limit, so all of it is credited.
   */
  it('three-week-old segments from a long-enrolled device are stored', async () => {
    await h.prisma.device.update({
      where: { id: deviceId },
      data: { enrolledAt: new Date(realNow().getTime() - 120 * DAY) },
    });

    const res = await postSegments([
      segment(new Date(realNow().getTime() - 21 * DAY), 120),
    ]);

    expect(res.body).toMatchObject({ accepted: 1, rejected: 0 });
  });

  it('past the 32-day limit it is dropped, even on an old device', async () => {
    await h.prisma.device.update({
      where: { id: deviceId },
      data: { enrolledAt: new Date(realNow().getTime() - 120 * DAY) },
    });

    const res = await postSegments([
      segment(new Date(realNow().getTime() - 40 * DAY), 120),
    ]);

    expect(res.body).toMatchObject({ accepted: 0, rejected: 1 });
  });
});
