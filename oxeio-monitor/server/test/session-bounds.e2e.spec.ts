import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import {
  createEmployeeWithCode,
  createHarness,
  workNoon,
  enrollDevice,
  iso,
  realNow,
  resetDatabase,
  type EnrolledDevice,
  type Harness,
} from './setup/harness';

/**
 * A session's envelope holds its own segments (G164, G165).
 *
 * G164, the bug this file guards: `ingestSegments()` looked the session up
 * once per date (a memo), which was right, but it looked it up using the time
 * of the batch's first chunk. The other chunks went straight into that
 * session on a memo hit, and `widen()` never saw them. So the session's bounds
 * stayed outside the segments inside it.
 *
 * Measured in the field: 7 of 226 sessions were broken: 52 segments, 24.47
 * hours outside their own session. The agent drops every closed segment into a
 * fire-and-forget queue, so the order is a race: a short idle row can beat a
 * long lock row.
 *
 * G165: a late-arriving departure event could close a session before its own
 * start (`ended_at < started_at`). On 24 August it slipped by 3 minutes 30
 * seconds.
 *
 * No report reads `work_sessions` times today, so no hours are lost. But the
 * rows are permanent, and the first feature to read these columns (a
 * session-based timeline, "when did they first arrive today") would get broken data.
 */
let h: Harness;
let device: EnrolledDevice;

const MINUTE_MS = 60_000;
const HOUR_MS = 3600_000;
const WORK_OFFSET_MS = 6 * HOUR_MS;

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

function asAgent<T extends { set(field: string, val: string): T }>(
  req: T,
  token: string,
): T {
  return req
    .set('Authorization', `Bearer ${token}`)
    .set('X-Client-Time', iso(realNow()));
}

const today = () => workDateOf(workNoon());

/** The real moment of that hour in Dhaka, not the label */
const atWorkHour = (dayLabel: Date, hour: number): Date =>
  new Date(dayLabel.getTime() - WORK_OFFSET_MS + hour * HOUR_MS);

const span = (from: Date, minutes: number, state = 'active') => ({
  clientUuid: randomUUID(),
  state,
  startedAt: iso(from),
  endedAt: iso(new Date(from.getTime() + minutes * MINUTE_MS)),
  durationSec: minutes * 60,
});

const send = (segments: unknown[]) =>
  asAgent(h.http().post('/api/v1/agent/segments'), device.token)
    .send({ segments })
    .expect(200);

const sessions = () =>
  h.prisma.workSession.findMany({ orderBy: { startedAt: 'asc' } });

/** A `shutdown` event, to close the session */
const closeAt = (when: Date) =>
  asAgent(h.http().post('/api/v1/agent/events'), device.token)
    .send({
      events: [
        { clientUuid: randomUUID(), type: 'shutdown', occurredAt: iso(when) },
      ],
    })
    .expect(200);

describe('G164: every segment of one batch fits in the session envelope', () => {
  /**
   * The core test of this file: the last segment of the batch ends latest,
   * and the session's end must be after it.
   *
   * With the old rule the session was created from the first segment's time
   * and the rest slipped in silently on a memo hit.
   */
  it('later segments also stretch the session bounds', async () => {
    const day = today();

    /**
     * The session is closed first, on purpose. `widen()` does not touch an
     * open session's `endedAt` (that is the job of logoff or the day close),
     * so testing with the session left open would make the claim empty: the
     * test would stay green even with the bug present.
     */
    await send([span(atWorkHour(day, 9), 10)]);
    await closeAt(atWorkHour(day, 9.5));

    // now three in one batch: the first is short, the last is much later
    await send([
      span(atWorkHour(day, 10), 5),
      span(atWorkHour(day, 11), 30),
      span(atWorkHour(day, 17), 45),
    ]);

    const [s] = await sessions();
    const last = new Date(atWorkHour(day, 17).getTime() + 45 * MINUTE_MS);

    expect(s.endedAt).not.toBeNull();
    expect(s.endedAt!.getTime()).toBeGreaterThanOrEqual(last.getTime());
    expect(s.startedAt.getTime()).toBeLessThanOrEqual(
      atWorkHour(day, 9).getTime(),
    );
  });

  /**
   * Even when they arrive in reverse order, the session start moves back.
   *
   * This is the shape of the field's sessions 32/93: in one batch the short
   * morning idle row went in first, then the long lock row running from
   * midnight. The session had started 8 hours 34 minutes after its own first
   * segment.
   */
  it('a late segment arriving first still leaves the start at the real first segment', async () => {
    const day = today();
    const early = atWorkHour(day, 0);

    await send([
      span(atWorkHour(day, 8), 2),
      span(early, 8 * 60 + 34, 'locked'),
    ]);

    const [s] = await sessions();
    expect(s.startedAt.toISOString()).toBe(early.toISOString());
  });

  /**
   * Every segment inside its own session: this is the real rule, and the two
   * above are its two sides. The field's query is written right here.
   */
  it('not a single segment falls outside its own session', async () => {
    const day = today();

    // the session is closed, otherwise the `endedAt` claim below would be empty
    await send([span(atWorkHour(day, 8), 10)]);
    await closeAt(atWorkHour(day, 8.5));

    await send([
      span(atWorkHour(day, 9), 15),
      span(atWorkHour(day, 9.5), 90, 'idle'),
      span(atWorkHour(day, 13), 10),
      span(atWorkHour(day, 18), 120, 'locked'),
      span(atWorkHour(day, 11), 25),
    ]);

    const rows = await h.prisma.activitySegment.findMany({
      select: {
        startedAt: true,
        endedAt: true,
        session: { select: { startedAt: true, endedAt: true } },
      },
    });

    expect(rows).not.toHaveLength(0);

    for (const r of rows) {
      expect(r.startedAt.getTime()).toBeGreaterThanOrEqual(
        r.session.startedAt.getTime(),
      );
      // `not.toBeNull()` separately: otherwise with an open session the claim
      // below would be skipped silently, and the test would guard nothing
      expect(r.session.endedAt).not.toBeNull();
      expect(r.endedAt.getTime()).toBeLessThanOrEqual(
        r.session.endedAt!.getTime(),
      );
    }
  });

  /**
   * A segment crossing midnight is split across two dates, and each day has
   * its own session: neither envelope takes the other's time.
   */
  it('crossing midnight gives two sessions for two days, each within its own bounds', async () => {
    const day = today();
    const yesterday = new Date(day.getTime() - 24 * HOUR_MS);

    // from 11pm yesterday for 3 hours: ends at 2am today
    await send([span(atWorkHour(yesterday, 23), 180, 'locked')]);

    const rows = await sessions();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.workDate.getTime()).sort()).toEqual(
      [yesterday.getTime(), day.getTime()].sort(),
    );
  });
});

describe('G165: a session is not closed before its own start', () => {
  /**
   * The core test of this block: a shutdown event held back across a reboot
   * arrives after the segment, and its time is before the session's start.
   */
  it('an old shutdown event arriving late does not close the session', async () => {
    const day = today();
    const startedAt = atWorkHour(day, 10);

    await send([span(startedAt, 60)]);
    await closeAt(atWorkHour(day, 9)); // an hour before the session starts

    const [s] = await sessions();

    expect(s.endedAt).toBeNull();
    expect(s.endReason).toBeNull();
  });

  /** In the normal case it is as before: this is the safety net */
  it('a normal shutdown closes the session as before', async () => {
    const day = today();
    const startedAt = atWorkHour(day, 10);
    const stopAt = atWorkHour(day, 18);

    await send([span(startedAt, 60)]);
    await closeAt(stopAt);

    const [s] = await sessions();

    expect(s.endedAt?.toISOString()).toBe(stopAt.toISOString());
    expect(s.endReason).toBe('shutdown');
  });

  /**
   * Dropped, not clamped: no zero-length session and no false `end_reason` is
   * set. The session simply stays open, and the 00:15 day close will close it
   * at its own midnight.
   */
  it('an event exactly at the start closes it, the one before does not', async () => {
    const day = today();
    const startedAt = atWorkHour(day, 10);

    await send([span(startedAt, 60)]);
    await closeAt(new Date(startedAt.getTime() - 1));

    expect((await sessions())[0].endedAt).toBeNull();

    await closeAt(startedAt);
    expect((await sessions())[0].endedAt?.toISOString()).toBe(
      startedAt.toISOString(),
    );
  });

  /** No session may have `ended_at < started_at` */
  it('no negative-length session is ever created', async () => {
    const day = today();

    await send([span(atWorkHour(day, 10), 60)]);
    await closeAt(atWorkHour(day, 7));
    await send([span(atWorkHour(day, 12), 30)]);
    await closeAt(atWorkHour(day, 8));

    for (const s of await sessions()) {
      if (s.endedAt === null) continue;
      expect(s.endedAt.getTime()).toBeGreaterThanOrEqual(s.startedAt.getTime());
    }
  });
});
