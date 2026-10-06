import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppCategoryService } from '../src/activity/app-category.service';
import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  iso,
  minutesAgo,
  resetDatabase,
  todayWindow,
  type EnrolledDevice,
  type Harness,
  workNoon,
  realNow,
} from './setup/harness';

let h: Harness;
let code: string;
let device: EnrolledDevice;

const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

/** What every agent request always carries: the token plus its own clock time */
function asAgent<T extends { set(field: string, val: string): T }>(
  req: T,
  token: string,
): T {
  return req
    .set('Authorization', `Bearer ${token}`)
    .set('X-Client-Time', iso(realNow()));
}

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  ({ code } = await createEmployeeWithCode(h.prisma));
  device = await enrollDevice(h, code);
});

describe('enrollment (H05)', () => {
  it('401 on a wrong code', async () => {
    await h
      .http()
      .post('/api/v1/agent/enroll')
      .send({
        enrollmentCode: 'WRONGCODE',
        hostname: 'PC-08',
        windowsUsername: 'x',
        machineGuid: 'guid-x',
      })
      .expect(401);
  });

  it('a correct code gives a token and config', async () => {
    expect(device.token.length).toBeGreaterThan(20);
    expect(device.configVersion).toBeTruthy();
  });

  it('a code can be used only once', async () => {
    await h
      .http()
      .post('/api/v1/agent/enroll')
      .send({
        enrollmentCode: code,
        hostname: 'PC-07',
        windowsUsername: 'alex',
        machineGuid: 'guid-test-001',
      })
      .expect(401);
  });

  it('the token is not stored as plaintext (I02)', async () => {
    const row = await h.prisma.device.findFirstOrThrow({
      where: { id: device.deviceId },
    });
    expect(row.tokenHash).not.toBe(device.token);
    expect(row.tokenHash).toHaveLength(64); // sha256 hex
  });
});

describe('device auth', () => {
  it('401 without a token', async () => {
    await h.http().get('/api/v1/agent/config').expect(401);
  });

  it('401 with a wrong token', async () => {
    await h
      .http()
      .get('/api/v1/agent/config')
      .set('Authorization', 'Bearer garbage')
      .expect(401);
  });

  it('a correct token gives the config, including the capture window', async () => {
    const res = await asAgent(
      h.http().get('/api/v1/agent/config'),
      device.token,
    ).expect(200);

    expect(res.body.config.screenshotFrom).toBe('07:00');
    expect(res.body.config.screenshotTo).toBe('23:00');
    expect(res.body.config.idleThresholdSec).toBe(60);
  });

  it('carries the work-day zone and its fixed offset', async () => {
    const res = await asAgent(
      h.http().get('/api/v1/agent/config'),
      device.token,
    ).expect(200);

    expect(res.body.config.timezone).toBe('Etc/GMT-6');
    expect(res.body.config.utcOffsetMinutes).toBe(360);
  });

  it('a revoked device gets 403 (H06)', async () => {
    await h.prisma.device.update({
      where: { id: device.deviceId },
      data: { status: 'revoked' },
    });

    const res = await asAgent(
      h.http().get('/api/v1/agent/config'),
      device.token,
    ).expect(403);
    expect(res.body.command).toBe('revoke');
  });
});

describe('heartbeat', () => {
  it('no command when the config version matches', async () => {
    const res = await asAgent(
      h.http().post('/api/v1/agent/heartbeat'),
      device.token,
    )
      .send({
        state: 'active',
        activeSecToday: 1200,
        queueDepth: 0,
        configVersion: device.configVersion,
      })
      .expect(200);

    expect(res.body.commands).toEqual([]);
  });

  /**
   * The agent does not know the month's totals itself: after a reboot its
   * counter starts from zero. If the server did not supply the number, the
   * tray would show "0h / 208h" and staff would think their month's work was
   * wiped.
   */
  it('monthly progress comes back in the heartbeat', async () => {
    const worked = todayWindow(600);

    await asAgent(h.http().post('/api/v1/agent/segments'), device.token)
      .send({
        segments: [
          {
            clientUuid: randomUUID(),
            state: 'active',
            startedAt: iso(worked.startedAt),
            endedAt: iso(worked.endedAt),
            durationSec: worked.durationSec,
          },
        ],
      })
      .expect(200);

    const res = await asAgent(
      h.http().post('/api/v1/agent/heartbeat'),
      device.token,
    )
      .send({
        state: 'active',
        activeSecToday: worked.durationSec,
        queueDepth: 0,
      })
      .expect(200);

    expect(res.body.progress).toBeTruthy();
    expect(res.body.progress.todayActiveSec).toBe(worked.durationSec);
    expect(res.body.progress.monthActiveSec).toBe(worked.durationSec);
    // G37: working days x 8, so it varies by month (ADR-025). The claim is about the rule.
    const target = res.body.progress.monthlyTargetHours as number;
    expect(target % 8).toBe(0);
    expect(target).toBeGreaterThanOrEqual(20 * 8);
    expect(target).toBeLessThanOrEqual(27 * 8);

    // ── Today's and the 7-day target, for the tray's three bars ──────────────

    const { dailyTargetSec, week7ActiveSec, week7TargetSec } = res.body.progress;

    /**
     * Specific numbers are not matched: how many working days the month has
     * depends on the date the test runs, and pinning that would make the test
     * break by itself once a month (a time bomb like G62).
     * So the relationships are checked, not the values.
     */
    expect(typeof dailyTargetSec).toBe('number');

    // 0 on a holiday, otherwise one working day's share; never more than 24 hours
    expect(dailyTargetSec).toBeGreaterThanOrEqual(0);
    expect(dailyTargetSec).toBeLessThanOrEqual(86_400);

    // 7 days of work cannot be less than today's work (today is within those 7 days)
    expect(week7ActiveSec).toBeGreaterThanOrEqual(worked.durationSec);

    /**
     * At most 7 working days in 7 days, so the target is no more than that.
     *
     * Careful: only on a working day, and this was a sleeping time bomb (it
     * went off on Friday 21 August 2026). On a holiday `dailyTargetSec` is 0
     * (correct, see `progress.service.ts`), yet with 6 working days in the
     * last 7, `week7TargetSec` = 48 hours. The claim then became
     * `172800 <= 0`, so the test would break every Friday though the code had
     * no bug.
     *
     * The claim below (not larger than the monthly target) also holds on a
     * holiday, and it catches the real risk: dividing by the wrong
     * denominator.
     */
    if (dailyTargetSec > 0) {
      expect(week7TargetSec).toBeLessThanOrEqual(dailyTargetSec * 7);
    }

    // It cannot be larger than the month's target: if it is, the daily share
    // is being divided by the wrong denominator, and the tray's 7-day bar would always look full
    expect(week7TargetSec).toBeLessThanOrEqual(target * 3600);
  });

  /**
   * On a holiday the daily target is 0, and that is different from "the
   * server did not say" (null). If the two were merged, the tray would nag
   * "8 hours left" even on a holiday, though the rule is that work on a
   * holiday counts but is not required (section 4).
   */
  it('on a holiday the daily target is zero, not null', async () => {
    /**
     * Careful: the work-zone date, not UTC's. This repeats G62 exactly.
     *
     * Today's date used to be built here with `getUTCFullYear/Month/Date`. In
     * the daytime the two agree, so the test passed. But between work-zone
     * (UTC+6) midnight and 06:00, UTC is still on the previous day, so the holiday
     * landed on yesterday's slot, the server saw today as a working day, and
     * the target came out 28,800 instead of 0. Caught at exactly 00:22.
     */
    const workDate = workNoon();
    workDate.setUTCHours(0, 0, 0, 0);

    await h.prisma.holiday.create({
      data: { holidayDate: workDate, name: 'Test holiday' },
    });

    const res = await asAgent(
      h.http().post('/api/v1/agent/heartbeat'),
      device.token,
    )
      .send({ state: 'active', activeSecToday: 0, queueDepth: 0 })
      .expect(200);

    expect(res.body.progress.dailyTargetSec).toBe(0);
  });

  /**
   * The version was set once at enroll and never updated after. This is not
   * only a dashboard number: the heartbeat decides whether to offer an update
   * by looking at this value, so if stale, an agent that had already updated
   * would be offered the same update again and again (G59).
   */
  it('a new version sent in the heartbeat is stored on the device', async () => {
    await asAgent(h.http().post('/api/v1/agent/heartbeat'), device.token)
      .send({ state: 'active', activeSecToday: 10, agentVersion: '9.9.9' })
      .expect(200);

    const row = await h.prisma.device.findUniqueOrThrow({
      where: { id: device.deviceId },
    });
    expect(row.agentVersion).toBe('9.9.9');
  });

  /**
   * The only proof that the rollout advances by itself is recorded here.
   *
   * Careful: if `agent_version_since` were not set, `RolloutAdvanceJob` would
   * never get any evidence, and the rollout would stay stuck in canary
   * forever, i.e. the very problem being fixed would come back, only more
   * quietly. Adding the column and filling the column: this project has had
   * more than ten bugs between the two.
   */
  it('when a new version is set, "since when" is set too', async () => {
    /**
     * Careful: `realNow()`, not `workNoon()`, and this is not an exception
     * to G140 but a legitimate use of it. The time is written by the server,
     * with its own clock, so the comparison must be against the real clock
     * too. A pinned noon would give a wrong result twice a day.
     */
    const before = realNow();

    await asAgent(h.http().post('/api/v1/agent/heartbeat'), device.token)
      .send({ state: 'active', activeSecToday: 10, agentVersion: '9.9.9' })
      .expect(200);

    const row = await h.prisma.device.findUniqueOrThrow({
      where: { id: device.deviceId },
    });

    expect(row.agentVersionSince).not.toBeNull();
    expect(row.agentVersionSince!.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  });

  /**
   * The time is set only when the version changes, not on every heartbeat.
   *
   * Careful: this is the line in this feature easiest to get wrong. If set
   * every time, the clock would restart from zero every 30 seconds, and the
   * condition "has survived six hours" would never become true. The failure
   * would be silent: no error, the rollout would simply never advance.
   */
  it('a second heartbeat on the same version: the clock does not move', async () => {
    await asAgent(h.http().post('/api/v1/agent/heartbeat'), device.token)
      .send({ state: 'active', activeSecToday: 10, agentVersion: '9.9.9' })
      .expect(200);

    const first = (
      await h.prisma.device.findUniqueOrThrow({ where: { id: device.deviceId } })
    ).agentVersionSince;

    await asAgent(h.http().post('/api/v1/agent/heartbeat'), device.token)
      .send({ state: 'idle', activeSecToday: 20, agentVersion: '9.9.9' })
      .expect(200);

    const second = (
      await h.prisma.device.findUniqueOrThrow({ where: { id: device.deviceId } })
    ).agentVersionSince;

    expect(second).toEqual(first);
  });

  it('when no version is sent, the earlier one stays and is not erased', async () => {
    await asAgent(h.http().post('/api/v1/agent/heartbeat'), device.token)
      .send({ state: 'active', activeSecToday: 10, agentVersion: '1.2.3' })
      .expect(200);

    // When an old agent (which does not know the field at all) sends a
    // heartbeat, the version must not become null: that would stop update offers.
    await asAgent(h.http().post('/api/v1/agent/heartbeat'), device.token)
      .send({ state: 'active', activeSecToday: 20 })
      .expect(200);

    const row = await h.prisma.device.findUniqueOrThrow({
      where: { id: device.deviceId },
    });
    expect(row.agentVersion).toBe('1.2.3');
  });

  it('reload_config when the version does not match', async () => {
    const res = await asAgent(
      h.http().post('/api/v1/agent/heartbeat'),
      device.token,
    )
      .send({ state: 'active', activeSecToday: 1, configVersion: 'stale' })
      .expect(200);

    expect(res.body.commands).toContain('reload_config');
  });

  it('last_seen_at is updated (the basis of G01)', async () => {
    const before = await h.prisma.device.findFirstOrThrow({
      where: { id: device.deviceId },
    });
    await new Promise((r) => setTimeout(r, 20));

    await asAgent(h.http().post('/api/v1/agent/heartbeat'), device.token)
      .send({ state: 'active', activeSecToday: 5 })
      .expect(200);

    const after = await h.prisma.device.findFirstOrThrow({
      where: { id: device.deviceId },
    });
    expect(after.lastSeenAt!.getTime()).toBeGreaterThan(
      before.lastSeenAt!.getTime(),
    );
  });

  /**
   * The Live Board's colour stands on these two columns. `state` used to be
   * accepted but never written anywhere, so the board guessed from the last
   * `activity_segments` row, and since the agent sends segments in batches
   * that guess was several minutes old. That is meaningless for a board that
   * refreshes every 30 seconds.
   */
  it('the heartbeat\'s state is stored on the device', async () => {
    await asAgent(h.http().post('/api/v1/agent/heartbeat'), device.token)
      .send({ state: 'idle', activeSecToday: 30 })
      .expect(200);

    const row = await h.prisma.device.findUniqueOrThrow({
      where: { id: device.deviceId },
    });
    expect(row.lastState).toBe('idle');
    expect(row.lastStateAt).not.toBeNull();
  });

  /**
   * If `lastStateAt` were not also set just because `lastState` did not
   * change, the worst bug would return: an agent that kept saying `active`
   * and then died would not have its time stuck at the moment of death; it
   * would be stuck at the moment it first said active. The board would then
   * throw away a healthy, active employee's fresh report as stale.
   */
  it('lastStateAt advances every time even when state does not change', async () => {
    await asAgent(h.http().post('/api/v1/agent/heartbeat'), device.token)
      .send({ state: 'active', activeSecToday: 10 })
      .expect(200);
    const first = await h.prisma.device.findUniqueOrThrow({
      where: { id: device.deviceId },
    });

    await new Promise((r) => setTimeout(r, 20));

    await asAgent(h.http().post('/api/v1/agent/heartbeat'), device.token)
      .send({ state: 'active', activeSecToday: 20 })
      .expect(200);
    const second = await h.prisma.device.findUniqueOrThrow({
      where: { id: device.deviceId },
    });

    expect(second.lastState).toBe('active');
    expect(second.lastStateAt!.getTime()).toBeGreaterThan(
      first.lastStateAt!.getTime(),
    );
  });
});

describe('segments: dedupe and validation (section 2.1d)', () => {
  /**
   * Timestamps must always stay inside today's work day.
   *
   * This used to be `minutesAgo(30)`. Running the test just after midnight
   * put it on the previous date, the server split the segment at midnight
   * (section 2.1a), and `accepted` came out 3 instead of 2. The test passed
   * by day and failed after 12 at night: the most irritating kind of flaky.
   */
  const dayWindow = () => {
    const w = todayWindow(900);
    const half = Math.floor(w.durationSec / 2);
    return { start: w.startedAt, half, total: w.durationSec, end: w.endedAt };
  };

  const segment = (over: Record<string, unknown> = {}) => {
    const w = dayWindow();
    const mid = new Date(w.start.getTime() + w.half * 1_000);

    return {
      clientUuid: randomUUID(),
      state: 'active',
      startedAt: iso(w.start),
      endedAt: iso(mid),
      durationSec: w.half,
      ...over,
    };
  };

  it('422 when client_uuid is missing', async () => {
    const { clientUuid, ...withoutUuid } = segment();
    void clientUuid;

    await asAgent(h.http().post('/api/v1/agent/segments'), device.token)
      .send({ segments: [withoutUuid] })
      .expect(422);
  });

  it('sending the same batch twice makes everything a duplicate the second time', async () => {
    const batch = {
      segments: [
        segment({ inputScore: 72 }),
        (() => {
          // The part right after the first: within the same day, with no overlap
          const w = dayWindow();
          const mid = new Date(w.start.getTime() + w.half * 1_000);
          return segment({
            state: 'idle',
            startedAt: iso(mid),
            endedAt: iso(w.end),
            durationSec: w.total - w.half,
          });
        })(),
      ],
    };

    const first = await asAgent(
      h.http().post('/api/v1/agent/segments'),
      device.token,
    )
      .send(batch)
      .expect(200);
    expect(first.body).toMatchObject({ accepted: 2, duplicates: 0 });

    const second = await asAgent(
      h.http().post('/api/v1/agent/segments'),
      device.token,
    )
      .send(batch)
      .expect(200);
    expect(second.body).toMatchObject({ accepted: 0, duplicates: 2 });
  });

  it('counts_as_work is true only for active', async () => {
    /**
     * Careful: all three segments are inside today's work day and arranged
     * one after another.
     *
     * `idle`/`locked` used to have `minutesAgo(15/10/9)`, which is exactly
     * the trap already fixed once in this file's `segment()` default (see the
     * note above): running after midnight put them on the previous date, the
     * server split the segment, and under `orderBy startedAt` active no
     * longer came first: `[idle, locked, active]` instead of
     * `[active, idle, locked]`. CI ran at exactly midnight and exposed this
     * (section 3b).
     *
     * Now idle comes right after active's window, then locked, all within
     * today, so the order is always fixed.
     */
    const w = dayWindow();
    const mid = w.start.getTime() + w.half * 1_000;
    const gap = Math.max(1, Math.floor(w.half / 2));

    await asAgent(h.http().post('/api/v1/agent/segments'), device.token)
      .send({
        segments: [
          segment(), // active — [w.start, mid]
          segment({
            state: 'idle',
            startedAt: iso(new Date(mid)),
            endedAt: iso(new Date(mid + gap * 1_000)),
            durationSec: gap,
          }),
          segment({
            state: 'locked',
            startedAt: iso(new Date(mid + gap * 1_000)),
            endedAt: iso(new Date(mid + 2 * gap * 1_000)),
            durationSec: gap,
          }),
        ],
      })
      .expect(200);

    const rows = await h.prisma.activitySegment.findMany({
      orderBy: { startedAt: 'asc' },
    });
    expect(rows.map((r) => [r.state, r.countsAsWork])).toEqual([
      ['active', true],
      ['idle', false],
      ['locked', false],
    ]);
  });

  it('400 for more than 500 records', async () => {
    const segments = Array.from({ length: 501 }, () => segment());
    await asAgent(h.http().post('/api/v1/agent/segments'), device.token)
      .send({ segments })
      .expect(400);
  });
});

describe('split at midnight (section 2.1a)', () => {
  it('23:50 to 00:10: one segment is split across two dates', async () => {
    const res = await asAgent(
      h.http().post('/api/v1/agent/segments'),
      device.token,
    )
      .send({
        segments: [
          {
            clientUuid: randomUUID(),
            state: 'active',
            // 17:50Z = 23:50 in the work zone (UTC+6), 18:10Z = 00:10 the next day
            startedAt: '2026-08-08T17:50:00.000Z',
            endedAt: '2026-08-08T18:10:00.000Z',
            durationSec: 1200,
          },
        ],
      })
      .expect(200);

    expect(res.body).toMatchObject({ accepted: 2, split: 1 });

    const rows = await h.prisma.activitySegment.findMany({
      orderBy: { startedAt: 'asc' },
    });
    expect(rows.map((r) => r.workDate.toISOString().slice(0, 10))).toEqual([
      '2026-08-08',
      '2026-08-09',
    ]);
    // Even when split, the total time stays intact
    expect(rows[0].durationSec + rows[1].durationSec).toBe(1200);
    // The two pieces have different client_uuid, or they would hit the UNIQUE constraint
    expect(rows[0].clientUuid).not.toBe(rows[1].clientUuid);

    const split = await h.prisma.event.findFirst({
      where: { type: 'segment_split' },
    });
    expect(split).not.toBeNull();
  });

  it('re-sending a split record does not make a duplicate', async () => {
    const batch = {
      segments: [
        {
          clientUuid: randomUUID(),
          state: 'active',
          startedAt: '2026-08-08T17:50:00.000Z',
          endedAt: '2026-08-08T18:10:00.000Z',
          durationSec: 1200,
        },
      ],
    };

    await asAgent(h.http().post('/api/v1/agent/segments'), device.token)
      .send(batch)
      .expect(200);
    const again = await asAgent(
      h.http().post('/api/v1/agent/segments'),
      device.token,
    )
      .send(batch)
      .expect(200);

    expect(again.body).toMatchObject({ accepted: 0, duplicates: 2 });
    expect(await h.prisma.activitySegment.count()).toBe(2);
  });
});

describe('clock drift (section 2)', () => {
  it('when the agent\'s clock is behind, the server corrects the time', async () => {
    const clientNow = minutesAgo(10); // the PC's clock is 10 minutes behind

    // After correction the segment must stay within today: crossing midnight
    // would split it in two, and the findFirstOrThrow below would give the first part (ending 00:00)
    const { durationSec } = todayWindow(300);
    const clientStart = new Date(clientNow.getTime() - durationSec * 1_000);

    await h
      .http()
      .post('/api/v1/agent/segments')
      .set('Authorization', `Bearer ${device.token}`)
      .set('X-Client-Time', iso(clientNow))
      .send({
        segments: [
          {
            clientUuid: randomUUID(),
            state: 'active',
            startedAt: iso(clientStart),
            endedAt: iso(clientNow),
            durationSec,
          },
        ],
      })
      .expect(200);

    const row = await h.prisma.activitySegment.findFirstOrThrow();
    // After correction the end time should be close to "now", not 10 minutes ago
    const gapSec = Math.abs((realNow().getTime() - row.endedAt.getTime()) / 1000);
    expect(gapSec).toBeLessThan(60);

    const dev = await h.prisma.device.findFirstOrThrow({
      where: { id: device.deviceId },
    });
    expect(dev.lastDriftSec).toBeGreaterThan(500);
  });

  it('drift over 5 minutes creates only one alert', async () => {
    const clientNow = minutesAgo(30);

    for (let i = 0; i < 3; i++) {
      await h
        .http()
        .post('/api/v1/agent/heartbeat')
        .set('Authorization', `Bearer ${device.token}`)
        .set('X-Client-Time', iso(clientNow))
        .send({ state: 'active', activeSecToday: 10 })
        .expect(200);
    }

    // Even sent 3 times, one in 6 hours: otherwise there would be about a thousand alerts a day
    const alerts = await h.prisma.alert.findMany({
      where: { type: 'clock_drift' },
    });
    expect(alerts).toHaveLength(1);
  });
});

describe('work session', () => {
  it('logoff closes the session', async () => {
    const worked = todayWindow(600);

    await asAgent(h.http().post('/api/v1/agent/segments'), device.token)
      .send({
        segments: [
          {
            clientUuid: randomUUID(),
            state: 'active',
            startedAt: iso(worked.startedAt),
            endedAt: iso(worked.endedAt),
            durationSec: worked.durationSec,
          },
        ],
      })
      .expect(200);

    await asAgent(h.http().post('/api/v1/agent/events'), device.token)
      .send({
        events: [
          { clientUuid: randomUUID(), type: 'logoff', occurredAt: iso(realNow()) },
        ],
      })
      .expect(200);

    const session = await h.prisma.workSession.findFirstOrThrow();
    expect(session.endedAt).not.toBeNull();
    expect(session.endReason).toBe('logoff');
  });

  /**
   * G43: when an offline queue is replayed, old batches arrive after new
   * ones. This used to close the current session at a past time, giving
   * ended_at < started_at.
   */
  it('the session\'s bounds do not break even when order is reversed', async () => {
    await asAgent(h.http().post('/api/v1/agent/segments'), device.token)
      .send({
        segments: [
          {
            clientUuid: randomUUID(),
            state: 'active',
            startedAt: iso(minutesAgo(30)),
            endedAt: iso(minutesAgo(20)),
            durationSec: 600,
          },
        ],
      })
      .expect(200);

    // Now a much older (yesterday's) batch arrives
    await asAgent(h.http().post('/api/v1/agent/segments'), device.token)
      .send({
        segments: [
          {
            clientUuid: randomUUID(),
            state: 'active',
            startedAt: '2026-08-08T17:50:00.000Z',
            endedAt: '2026-08-08T18:10:00.000Z',
            durationSec: 1200,
          },
        ],
      })
      .expect(200);

    await asAgent(h.http().post('/api/v1/agent/events'), device.token)
      .send({
        events: [
          { clientUuid: randomUUID(), type: 'logoff', occurredAt: iso(realNow()) },
        ],
      })
      .expect(200);

    const sessions = await h.prisma.workSession.findMany();
    for (const s of sessions) {
      expect(s.endedAt).not.toBeNull();
      expect(s.endedAt!.getTime()).toBeGreaterThan(s.startedAt.getTime());
    }

    // Every segment must be inside its session's bounds
    const segments = await h.prisma.activitySegment.findMany();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const seg of segments) {
      const s = byId.get(seg.sessionId)!;
      expect(seg.startedAt.getTime()).toBeGreaterThanOrEqual(
        s.startedAt.getTime(),
      );
      expect(seg.endedAt.getTime()).toBeLessThanOrEqual(s.endedAt!.getTime());
    }

    // Yesterday's session closes at its own midnight, not by today's logoff
    const yesterday = sessions.find(
      (s) => s.workDate.toISOString().slice(0, 10) === '2026-08-08',
    )!;
    expect(yesterday.endReason).toBe('day_rollover');
    expect(yesterday.endedAt!.toISOString()).toBe('2026-08-08T18:00:00.000Z');
  });
});

describe('app usage and events', () => {
  it('app usage is stored, with the domain', async () => {
    const used = todayWindow(300);

    const res = await asAgent(
      h.http().post('/api/v1/agent/app-usage'),
      device.token,
    )
      .send({
        items: [
          {
            clientUuid: randomUUID(),
            startedAt: iso(used.startedAt),
            endedAt: iso(used.endedAt),
            durationSec: used.durationSec,
            processName: 'chrome.exe',
            appName: 'Google Chrome',
            windowTitle: 'GitHub',
            domain: 'github.com',
            isBrowser: true,
          },
        ],
      })
      .expect(200);

    expect(res.body.accepted).toBe(1);
    const row = await h.prisma.appUsage.findFirstOrThrow();
    expect(row.domain).toBe('github.com');
    // No rule is set: staying unknown is right (null is not neutral)
    expect(row.categoryId).toBeNull();
  });

  /**
   * D05: this test proves the category is really being set. The matcher has
   * its own unit tests; this shows the ingest path is wired up.
   */
  it('the category is set by the browser\'s site, not by the browser', async () => {
    const used = todayWindow(300);

    await h.prisma.appCategory.createMany({
      data: [
        {
          matchType: 'process',
          pattern: 'chrome.exe',
          displayName: 'Google Chrome',
          category: 'neutral',
          priority: 200,
        },
        {
          matchType: 'domain',
          pattern: 'youtube.com',
          displayName: 'YouTube',
          category: 'unproductive',
          priority: 100,
        },
      ],
    });
    h.app.get(AppCategoryService).invalidate();

    await asAgent(h.http().post('/api/v1/agent/app-usage'), device.token)
      .send({
        items: [
          {
            clientUuid: randomUUID(),
            startedAt: iso(used.startedAt),
            endedAt: iso(used.endedAt),
            durationSec: used.durationSec,
            processName: 'chrome.exe',
            windowTitle: 'Something — YouTube',
            domain: 'music.youtube.com',
            isBrowser: true,
          },
        ],
      })
      .expect(200);

    const row = await h.prisma.appUsage.findFirstOrThrow({
      include: { category: true },
    });

    // The domain rule applies to subdomains too, and it beats chrome.exe
    expect(row.category?.category).toBe('unproductive');
    expect(row.category?.displayName).toBe('YouTube');
  });

  /**
   * When a rule is deleted its id stays in the cache, and the insert breaks
   * the foreign key. Instead of giving 500 and sitting there for five
   * minutes (the TTL), it clears the cache once and tries again.
   */
  it('the batch still goes in even if a rule was deleted', async () => {
    const used = todayWindow(300);

    const rule = await h.prisma.appCategory.create({
      data: {
        matchType: 'process',
        pattern: 'excel.exe',
        displayName: 'Excel',
        category: 'productive',
        priority: 100,
      },
    });
    h.app.get(AppCategoryService).invalidate();

    // Loaded into the cache, then the rule vanishes: the cache knows nothing
    await h.app.get(AppCategoryService).rules();
    await h.prisma.appCategory.delete({ where: { id: rule.id } });

    const res = await asAgent(
      h.http().post('/api/v1/agent/app-usage'),
      device.token,
    )
      .send({
        items: [
          {
            clientUuid: randomUUID(),
            startedAt: iso(used.startedAt),
            endedAt: iso(used.endedAt),
            durationSec: used.durationSec,
            processName: 'excel.exe',
          },
        ],
      })
      .expect(200);

    expect(res.body.accepted).toBe(1);
    const row = await h.prisma.appUsage.findFirstOrThrow();
    expect(row.categoryId).toBeNull();
  });

  it('an event is stored', async () => {
    const res = await asAgent(
      h.http().post('/api/v1/agent/events'),
      device.token,
    )
      .send({
        events: [
          {
            clientUuid: randomUUID(),
            type: 'lock',
            occurredAt: iso(minutesAgo(3)),
          },
        ],
      })
      .expect(200);

    expect(res.body.accepted).toBe(1);
  });
});

describe('screenshots', () => {
  const meta = (over: Record<string, unknown> = {}) => ({
    clientUuid: randomUUID(),
    slotStart: iso(minutesAgo(5)),
    capturedAt: iso(minutesAgo(4)),
    monitorIndex: 0,
    width: 1920,
    height: 1080,
    activeApp: 'code.exe',
    activeTitle: 'main.ts',
    ...over,
  });

  it('a format other than webp gives 400 (ADR-007)', async () => {
    await asAgent(h.http().post('/api/v1/agent/screenshots'), device.token)
      .field('meta', JSON.stringify(meta()))
      .attach('file', WEBP, { filename: 'shot.png', contentType: 'image/png' })
      .expect(400);
  });

  it('accepts webp and stores it under a date-based path', async () => {
    const res = await asAgent(
      h.http().post('/api/v1/agent/screenshots'),
      device.token,
    )
      .field('meta', JSON.stringify(meta()))
      .attach('file', WEBP, { filename: 'shot.webp', contentType: 'image/webp' })
      .expect(201);

    expect(res.body.accepted).toBe(1);
    // So the retention job can delete by folder alone (ADR-006)
    expect(res.body.path).toMatch(
      /^screenshots\/\d{4}\/\d{2}\/\d{2}\/emp-\d{3}\/\d{6}_m0\.webp$/,
    );
  });

  it('a screenshot for the same slot and monitor arriving twice is a duplicate', async () => {
    const m = JSON.stringify(meta());

    await asAgent(h.http().post('/api/v1/agent/screenshots'), device.token)
      .field('meta', m)
      .attach('file', WEBP, { filename: 'shot.webp', contentType: 'image/webp' })
      .expect(201);

    const res = await asAgent(
      h.http().post('/api/v1/agent/screenshots'),
      device.token,
    )
      .field('meta', m)
      .attach('file', WEBP, { filename: 'shot.webp', contentType: 'image/webp' })
      .expect(201);

    expect(res.body).toMatchObject({ accepted: 0, duplicate: true });
    expect(await h.prisma.screenshot.count()).toBe(1);
  });
});

describe('auto-update (G34)', () => {
  it('204 when there is no new version', async () => {
    await asAgent(
      h.http().get('/api/v1/agent/update?current=1.0.0'),
      device.token,
    ).expect(204);
  });

  it('when there is a new version, it gives info with the hash', async () => {
    await h.prisma.agentVersion.create({
      data: {
        version: '1.2.0',
        msiPath: 'agent/oXeioAgent-1.2.0.msi',
        sha256: 'a'.repeat(64),
        rolloutStage: 'all',
      },
    });

    const res = await asAgent(
      h.http().get('/api/v1/agent/update?current=1.0.0'),
      device.token,
    ).expect(200);

    expect(res.body).toMatchObject({ version: '1.2.0', mandatory: false });
    expect(res.body.sha256).toHaveLength(64);
  });

  it('gives nothing when the rollout is halted', async () => {
    await h.prisma.agentVersion.create({
      data: {
        version: '1.3.0',
        msiPath: 'agent/bad.msi',
        sha256: 'b'.repeat(64),
        rolloutStage: 'halted',
      },
    });

    await asAgent(
      h.http().get('/api/v1/agent/update?current=1.0.0'),
      device.token,
    ).expect(204);
  });

  it('1.10.0 counts as newer than 1.9.0 (not a string comparison)', async () => {
    await h.prisma.agentVersion.create({
      data: {
        version: '1.10.0',
        msiPath: 'agent/x.msi',
        sha256: 'c'.repeat(64),
        rolloutStage: 'all',
      },
    });

    const res = await asAgent(
      h.http().get('/api/v1/agent/update?current=1.9.0'),
      device.token,
    ).expect(200);
    expect(res.body.version).toBe('1.10.0');
  });

  /**
   * "First to", and why it never worked (5 September).
   *
   * Careful: the `pilotDeviceId` field was added to `offerFor()` on 1
   * September, and the heartbeat caller sent `device.id`, but this endpoint
   * did not. So `isPilot` here was always `false`.
   *
   * Careful: the failure was especially confusing because it half worked: the
   * heartbeat sent the chosen PC an `update_agent` command (the agent knew an
   * update existed), then it came here and got a 204. No error, no log, just
   * an update that never downloaded.
   *
   * The feature was written for OX-05 (bucket 86), and that very machine
   * never got it. A familiar pattern in this project: the contract is
   * written, the caller is not.
   */
  it('a pilot PC outside the bucket still gets the offer', async () => {
    await h.prisma.agentVersion.create({
      data: {
        version: '9.9.9',
        msiPath: 'agent/pilot.msi',
        sha256: 'd'.repeat(64),
        // canary is 7%: we do not rely on whether the device below falls in it;
        // the pilot overrides the bucket, and that is the claim.
        rolloutStage: 'canary',
        pilotDeviceId: device.deviceId,
      },
    });

    const res = await asAgent(
      h.http().get('/api/v1/agent/update?current=1.0.0'),
      device.token,
    ).expect(200);

    expect(res.body.version).toBe('9.9.9');
  });

  /**
   * The emergency brake applies to the pilot too. `halted` means the build
   * broke something in the field, and then it is worst for it to keep going
   * to exactly that machine, since that is where we are watching most. The
   * order decides this (the `percent <= 0` check in `isOfferedTo` comes
   * before the pilot).
   */
  it('when `halted`, the pilot gets nothing either', async () => {
    await h.prisma.agentVersion.create({
      data: {
        version: '9.9.9',
        msiPath: 'agent/pilot.msi',
        sha256: 'd'.repeat(64),
        rolloutStage: 'halted',
        pilotDeviceId: device.deviceId,
      },
    });

    await asAgent(
      h.http().get('/api/v1/agent/update?current=1.0.0'),
      device.token,
    ).expect(204);
  });
});
