import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import { SummaryRefreshJob } from '../src/summary/summary-refresh.job';
import { SummaryService } from '../src/summary/summary.service';
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
 * Late-arriving hours are no longer lost.
 *
 * The bug this file guards: the rollup ran over only two days: today (K06,
 * every 15 minutes) and yesterday (K05, once at 00:15). A segment for any
 * other day arriving later did land in `activity_segments`, but never made it
 * into `daily_summary`, and from there `monthly_summary`, and from there the
 * salary shortfall.
 *
 * This is not rare, it is daily. When a PC is switched off in the evening,
 * the day's last segment stays in the outbox and uploads the next morning
 * after login, by which time the 00:15 day close has passed. Measured loss in
 * the field, August-September: 39 (employee, day) pairs, 17.78 hours.
 *
 * The fix: ingest marks the day in `summary_dirty`, and K06 drains the queue
 * on every tick.
 */
let h: Harness;
let device: EnrolledDevice;
let summary: SummaryService;

const HOUR_MS = 3_600_000;

function asAgent<T extends { set(field: string, val: string): T }>(
  req: T,
  token: string,
): T {
  return req
    .set('Authorization', `Bearer ${token}`)
    // The real clock: this is the agent's own time, not the fixture's (G140)
    .set('X-Client-Time', iso(realNow()));
}

beforeAll(async () => {
  h = await createHarness();
  summary = h.app.get(SummaryService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  const { code } = await createEmployeeWithCode(h.prisma);
  device = await enrollDevice(h, code);
});

/**
 * Sends one active segment of `seconds` seconds at local noon `dayOffset`
 * days ago, exactly the way the offline outbox replays later.
 */
async function upload(dayOffset: number, seconds: number): Promise<void> {
  const startedAt = workNoon(dayOffset);
  const endedAt = new Date(startedAt.getTime() + seconds * 1_000);

  await asAgent(h.http().post('/api/v1/agent/segments'), device.token)
    .send({
      segments: [
        {
          clientUuid: randomUUID(),
          state: 'active',
          startedAt: iso(startedAt),
          endedAt: iso(endedAt),
          durationSec: seconds,
        },
      ],
    })
    .expect(200);
}

const dayOf = (offset: number) => workDateOf(workNoon(offset));

const dirtyDates = async () =>
  (
    await h.prisma.summaryDirty.findMany({
      orderBy: { workDate: 'asc' },
      select: { workDate: true },
    })
  ).map((r) => r.workDate.getTime());

const workedOn = async (offset: number) =>
  (
    await h.prisma.dailySummary.findFirst({
      where: { workDate: dayOf(offset) },
      select: { workedSec: true },
    })
  )?.workedSec ?? null;

describe('late-arriving day: marking', () => {
  /**
   * The core test of this file. Work from three days ago is uploaded today;
   * before, it would never have reached `daily_summary`.
   */
  it('a segment for an old day marks the day', async () => {
    await upload(-3, 1_800);

    expect(await dirtyDates()).toEqual([dayOf(-3).getTime()]);
  });

  /**
   * Today is not marked: K06 counts it every 15 minutes anyway. Marking it
   * would do the same work twice on every heartbeat, and the queue would
   * become meaningless.
   */
  it('today is not marked', async () => {
    await upload(0, 600);

    expect(await dirtyDates()).toEqual([]);
  });

  /**
   * Yesterday is marked too: the day close touches yesterday exactly once, at
   * 00:15. A segment arriving in the morning has missed that chance, and most
   * of the field's 39 losses were exactly of this kind.
   */
  it('a late segment for yesterday is marked too', async () => {
    await upload(-1, 900);

    expect(await dirtyDates()).toEqual([dayOf(-1).getTime()]);
  });

  /** The same day arriving twice does not make two rows: the key is `work_date` */
  it('the same day arriving repeatedly still gives one marker', async () => {
    await upload(-2, 600);
    await upload(-2, 600);
    await upload(-2, 600);

    expect(await dirtyDates()).toHaveLength(1);
  });

  it('different days get different markers', async () => {
    await upload(-2, 600);
    await upload(-4, 600);

    expect(await dirtyDates()).toEqual([
      dayOf(-4).getTime(),
      dayOf(-2).getTime(),
    ]);
  });
});

describe('late-arriving day: draining', () => {
  /**
   * The whole path in one test: still no row after the upload, and the hours
   * in the ledger after the drain. The first part is the real one: without
   * it the test would not prove the bug ever existed.
   */
  it('after the drain the old day\'s hours reach the ledger', async () => {
    await upload(-3, 1_800);

    // no job touches that day, so nothing exists yet
    expect(await workedOn(-3)).toBeNull();

    const result = await summary.drainDirty(workNoon());

    expect(result.refreshed).toBe(1);
    expect(result.pending).toBe(0);
    expect(await workedOn(-3)).toBe(1_800);
    expect(await dirtyDates()).toEqual([]);
  });

  /** If the marker stayed after the drain, the same day would be counted again on every tick */
  it('the marker is removed after the drain', async () => {
    await upload(-2, 600);
    await summary.drainDirty(workNoon());

    expect(await dirtyDates()).toEqual([]);
  });

  /**
   * There is a ceiling, and the rest stays in the queue. Without a ceiling, on
   * a big backlog one tick would overrun the next, and `RunLock` would skip them one by one.
   */
  it('no more than the ceiling at a time, the rest on the next tick', async () => {
    await upload(-2, 600);
    await upload(-3, 600);
    await upload(-4, 600);

    const first = await summary.drainDirty(workNoon(), 2);
    expect(first.refreshed).toBe(2);
    expect(first.pending).toBe(1);

    const second = await summary.drainDirty(workNoon(), 2);
    expect(second.refreshed).toBe(1);
    expect(second.pending).toBe(0);
  });

  /** Oldest first: otherwise in a backlog the oldest day would wait forever */
  it('older markers are drained first', async () => {
    await upload(-5, 600);
    await upload(-2, 600);

    await summary.drainDirty(workNoon(), 1);

    // the one marked first is the one that was counted
    expect(await workedOn(-5)).toBe(600);
    expect(await workedOn(-2)).toBeNull();
  });

  /**
   * A closed month is not touched (R1): that month's paper has gone out.
   *
   * But the marker is still cleared; otherwise that row would sit at the head
   * of the queue forever and be tried in vain on every tick, so the queue
   * would be permanently stuck.
   */
  it('a closed month is not counted, but the marker is still cleared', async () => {
    await upload(-3, 1_800);

    const yearMonth = dayOf(-3).toISOString().slice(0, 7);
    await h.prisma.monthClosure.create({
      data: { yearMonth, closedBy: 'test' },
    });

    const result = await summary.drainDirty(workNoon());

    expect(result.closed).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(await workedOn(-3)).toBeNull();
    expect(await dirtyDates()).toEqual([]);
  });

  it('draining is harmless when nothing is marked', async () => {
    const result = await summary.drainDirty(workNoon());

    expect(result).toEqual({ refreshed: 0, closed: 0, pending: 0 });
  });
});

/**
 * The job really calls the drain. The most familiar sin in this repo is
 * writing the contract and not the caller (G141, G144, G146). Even with a
 * perfect `drainDirty()`, if nobody called it the hours would be lost just as before.
 */
describe('K06: draining from the job', () => {
  it('the old day is counted on the refresh tick itself', async () => {
    await upload(-3, 1_800);

    const job = h.app.get(SummaryRefreshJob);
    const result = await job.runOnce(workNoon());

    expect(result.skipped).toBe(false);
    expect(result.drained?.refreshed).toBe(1);
    expect(await workedOn(-3)).toBe(1_800);
  });

  /** Today is counted in the same tick too: the drain does not displace it */
  it('today is counted in the same tick too', async () => {
    const seconds = 600;
    const startedAt = new Date(workNoon().getTime() - HOUR_MS);
    const endedAt = new Date(startedAt.getTime() + seconds * 1_000);

    await asAgent(h.http().post('/api/v1/agent/segments'), device.token)
      .send({
        segments: [
          {
            clientUuid: randomUUID(),
            state: 'active',
            startedAt: iso(startedAt),
            endedAt: iso(endedAt),
            durationSec: seconds,
          },
        ],
      })
      .expect(200);

    const job = h.app.get(SummaryRefreshJob);
    await job.runOnce(workNoon());

    expect(await workedOn(0)).toBe(seconds);
  });
});

/**
 * When a PC changes hands, the session changes too.
 *
 * The bug this describe guards: `resolveSession()` matched sessions only by
 * (device, date), not by employee. So when a PC was given to another employee
 * mid-day, the new employee's segments went into the previous employee's session.
 *
 * The result is bad both ways: on the timeline one person's work is under
 * another's name, and `trackedFromBy()` (which reads `work_sessions`) pushed
 * the real employee's tracking start later, so their expectation window was wrong too.
 */
describe('PC changes hands: sessions match by employee too', () => {
  it('giving the device to another employee opens a new session', async () => {
    await upload(0, 600);

    const first = await h.prisma.workSession.findFirstOrThrow();

    // the same device, the same day: only the employee changed
    const other = await h.prisma.employee.create({
      data: { empCode: 'OX-SWAP', fullName: 'Notun Karmi' },
    });
    await h.prisma.device.update({
      where: { id: first.deviceId },
      data: { employeeId: other.id },
    });

    await upload(0, 600);

    const sessions = await h.prisma.workSession.findMany({
      orderBy: { id: 'asc' },
      select: { employeeId: true },
    });

    expect(sessions).toHaveLength(2);
    expect(sessions[0].employeeId).not.toBe(sessions[1].employeeId);
    expect(sessions[1].employeeId).toBe(other.id);
  });

  /** Same employee: still one session as before; the new condition must not over-split */
  it('a second upload by the same employee does not open a new session', async () => {
    await upload(0, 600);
    await upload(0, 600);

    expect(await h.prisma.workSession.count()).toBe(1);
  });
});
