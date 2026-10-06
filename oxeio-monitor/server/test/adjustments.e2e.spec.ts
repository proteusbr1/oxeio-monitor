import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import {
  createEmployeeWithCode,
  createHarness,
  hashPassword,
  enrollDevice,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  todayWindow,
  dhakaNoon,
  dhakaTodayIso,
  realNow,
  type Harness,
} from './setup/harness';

/**
 * B14, G35, ADR-011e: the owner gives back hours lost through the system's fault.
 *
 * The read side was complete for months (`progress.service`,
 * `summary.service`, `payroll.math`, `reports`); only the write path was
 * missing, so the sum stayed 0 forever and nothing showed a mistake. These
 * tests guard that path.
 */
let h: Harness;
let employeeId: number;

/** Today's date in Dhaka: not UTC (G62, section 3d), and taken from the harness (G140) */
const todayDhaka = (): string => dhakaTodayIso();

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);

  const policy = await h.prisma.workPolicy.create({
    data: { name: 'test', monthlyTargetHours: 208, isActive: true },
  });

  const employee = await h.prisma.employee.create({
    data: { empCode: 'OX-77', fullName: 'Adjust Test', policyId: policy.id },
  });

  employeeId = employee.id;
});

const body = (over: Record<string, unknown> = {}) => ({
  workDate: todayDhaka(),
  deltaSec: 7200,
  cause: 'agent_down',
  reason: 'Agent was down all morning after the power cut',
  ...over,
});

describe('giving hours back', () => {
  it('the owner can post an adjustment', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body());

    expect(res.status).toBe(201);
    expect(res.body.deltaSec).toBe(7200);
    expect(res.body.active).toBe(true);
    // The BigInt must come back as a string, or JSON.stringify would give a 500
    expect(typeof res.body.id).toBe('string');
  });

  /**
   * This is the real reason for the module: an adjustment does not touch raw
   * segments, but adds to the tray's numbers at once (`progress.service`
   * reads `time_adjustments` directly).
   */
  it('adds to the heartbeat pace immediately', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    /**
     * Careful: the employee needs a tracking baseline, or the test does not
     * measure what it means to.
     *
     * The test claims that the adjustment's `deltaSec` is added directly to
     * the pace, so the delta is exactly 3600. But `trackingStartedOn` comes
     * from the employee's first `daily_summary` row (`progress.service`,
     * `firstSeen`). Without a baseline, when the adjustment is POSTed
     * `AdjustmentsService.refresh()` creates the first row for today, and
     * then the elapsed window starts today and becomes empty: expected drops
     * from 460800 to 0. So the delta would carry the whole month's
     * expectation instead of 3600 (measured: before=-460800, after=3600). The
     * number grew every day, so CI would go red every day too.
     *
     * Putting a `daily_summary` at the start of the month keeps `firstSeen`
     * fixed (today's new row does not change the min), so the only thing that
     * changes is `creditedSec`: exactly 3600. This is the real picture too: a
     * real employee always has earlier days of tracking.
     */
    const dhakaNow = dhakaNoon();
    const monthStart = new Date(
      Date.UTC(dhakaNow.getUTCFullYear(), dhakaNow.getUTCMonth(), 1),
    );
    await h.prisma.dailySummary.create({
      data: { employeeId, workDate: monthStart, workedSec: 0 },
    });

    const before = await h.app
      .get<{ forEmployee: (id: number) => Promise<{ paceSec: number }> }>(
        (await import('../src/agent/progress.service')).ProgressService,
      )
      .forEmployee(employeeId);

    await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body({ deltaSec: 3600 }))
      .expect(201);

    const after = await h.app
      .get<{ forEmployee: (id: number) => Promise<{ paceSec: number }> }>(
        (await import('../src/agent/progress.service')).ProgressService,
      )
      .forEmployee(employeeId);

    expect(after.paceSec - before.paceSec).toBe(3600);
  });

  it('raw segments stay intact', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const before = await h.prisma.activitySegment.count();

    await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body())
      .expect(201);

    expect(await h.prisma.activitySegment.count()).toBe(before);
  });

  it('a negative adjustment is posted too (a deduction)', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body({ deltaSec: -1800, cause: 'other' }));

    expect(res.status).toBe(201);
    expect(res.body.deltaSec).toBe(-1800);
  });
});

describe('what is not accepted', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['zero delta', { deltaSec: 0 }],
    ['more than 24 hours', { deltaSec: 86_401 }],
    ['more than -24 hours', { deltaSec: -86_401 }],
    ['no reason', { reason: '' }],
    ['a very short reason', { reason: 'ok' }],
    ['unknown cause', { cause: 'because' }],
    ['wrong date', { workDate: '12-08-2026' }],
  ];

  for (const [name, over] of bad) {
    it(`${name} gives 400`, async () => {
      const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

      const res = await s.http
        .post(`/api/v1/employees/${employeeId}/time-adjustments`)
        .set('X-CSRF-Token', s.csrf)
        .send(body(over));

      expect(res.status).toBe(400);
    });
  }

  /**
   * `deltaSec` is an `Int`. If someone put milliseconds in place of seconds
   * (7,200,000) it would go in silently and add 2,000 hours to the month.
   */
  it('catches milliseconds being entered', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body({ deltaSec: 7_200_000 }));

    expect(res.status).toBe(400);
  });

  it('a future day gives 400', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const later = dhakaNoon(3).toISOString().slice(0, 10);

    const res = await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body({ workDate: later }));

    expect(res.status).toBe(400);
  });

  it('an unknown employee gives 404', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http
      .post('/api/v1/employees/999999/time-adjustments')
      .set('X-CSRF-Token', s.csrf)
      .send(body());

    expect(res.status).toBe(404);
  });
});

describe('revoking', () => {
  it('revoke stops it being counted, and the row stays', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const created = await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body())
      .expect(201);

    const res = await s.http
      .post(`/api/v1/time-adjustments/${created.body.id}/revoke`)
      .set('X-CSRF-Token', s.csrf)
      .send({ reason: 'Counted twice by mistake' });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.revokeReason).toBe('Counted twice by mistake');

    // Not a delete: the row stays, or the history would be lost
    expect(await h.prisma.timeAdjustment.count()).toBe(1);
  });

  it('cannot be revoked twice', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const created = await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body())
      .expect(201);

    await s.http
      .post(`/api/v1/time-adjustments/${created.body.id}/revoke`)
      .set('X-CSRF-Token', s.csrf)
      .send({ reason: 'first' })
      .expect(200);

    const again = await s.http
      .post(`/api/v1/time-adjustments/${created.body.id}/revoke`)
      .set('X-CSRF-Token', s.csrf)
      .send({ reason: 'second' });

    expect(again.status).toBe(400);
  });
});

describe('who can see (J08)', () => {
  it('a manager can see but cannot post', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await owner.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', owner.csrf)
      .send(body())
      .expect(201);

    const m = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    const read = await m.http.get(
      `/api/v1/employees/${employeeId}/time-adjustments`,
    );
    expect(read.status).toBe(200);
    expect(read.body).toHaveLength(1);

    const write = await m.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', m.csrf)
      .send(body());
    expect(write.status).toBe(403);
  });

  /**
   * A researcher cannot see someone else's pay adjustments.
   *
   * Careful: this is the most valuable test today, and the reason is
   * frightening. `assertCanSee` had `if (role !== employee) return;`, i.e.
   * "if not staff, let them see everything". The moment `researcher` was
   * added to `UserRole`, the new role would fall into that very branch, skip
   * the guard entirely, and anyone's bonus-and-deduction figures would be
   * open.
   *
   * There would be no compile error and no red test. This controller
   * deliberately has no class-level `@Roles` (scoping is the service's job),
   * so nothing above would stop it either.
   *
   * The condition is now an allow-list (`owner || manager`), and this test
   * guards it: the next new value added to the enum must not slip in by
   * itself.
   */
  it('a researcher cannot see others\' adjustments', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await owner.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', owner.csrf)
      .send(body())
      .expect(201);

    // The researcher has their own separate staff row, and the role `researcher`
    const them = await h.prisma.employee.create({
      data: { empCode: 'OX-78', fullName: 'Researcher', staffType: 'researcher' },
    });
    await h.prisma.user.create({
      data: {
        email: 'r-adj@test.local',
        fullName: 'Researcher',
        passwordHash: await hashPassword('staff-password-123'),
        role: 'researcher',
        employeeId: them.id,
        mustChangePw: false,
      },
    });

    const session = await loginReady(h, 'r-adj@test.local', 'staff-password-123');

    const read = await session.http.get(
      `/api/v1/employees/${employeeId}/time-adjustments`,
    );
    expect(read.status).toBe(403);

    // They can see their own: the guard is not "everything closed" but "only your own"
    const mine = await session.http.get(
      `/api/v1/employees/${them.id}/time-adjustments`,
    );
    expect(mine.status).toBe(200);
  });

  it('closed without login', async () => {
    const res = await h
      .http()
      .get(`/api/v1/employees/${employeeId}/time-adjustments`);

    expect(res.status).toBe(401);
  });
});

describe('audit', () => {
  it('posting and revoking each land under a separate action', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const created = await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body())
      .expect(201);

    await s.http
      .post(`/api/v1/time-adjustments/${created.body.id}/revoke`)
      .set('X-CSRF-Token', s.csrf)
      .send({ reason: 'wrong day' })
      .expect(200);

    const rows = await h.prisma.auditLog.findMany({
      where: { targetId: String(employeeId) },
    });

    const actions = rows.map((r) => r.action);
    expect(actions).toContain('time_adjustment');
    expect(actions).toContain('time_adjustment_revoke');

    // The reason must be in the audit log too: even if the row is revoked, why it happened remains
    expect(JSON.stringify(rows)).toContain('power cut');
  });
});

/**
 * An inactive employee's adjustment also reaches the ledger (6 September).
 *
 * The bug this describe guards: the rollup (`refreshDate`) runs only over
 * active employees. So when an adjustment was posted for someone who had
 * left, the row went into `time_adjustments` and showed on screen, but never
 * reached `daily_summary`, and so never the monthly row or the final
 * settlement. No error, just an adjustment that changed nothing.
 *
 * Correcting a departed employee's last month is a legitimate job (before
 * settling dues), so the path was not closed; only that one person is added
 * to that run.
 */
describe('adjustment for an inactive employee', () => {
  const creditedOf = async (id: number) =>
    (
      await h.prisma.dailySummary.findFirst({
        where: { employeeId: id },
        select: { creditedSec: true },
      })
    )?.creditedSec ?? null;

  /** The main test of this describe */
  it('the adjustment of an employee who left also reaches `daily_summary`', async () => {
    await h.prisma.employee.update({
      where: { id: employeeId },
      // Not `new Date()`: a fixture's instant always comes from the harness clock (G140)
      data: { status: 'inactive', leftOn: dhakaNoon() },
    });

    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body({ deltaSec: 3600 }))
      .expect(201);

    expect(await creditedOf(employeeId)).toBe(3600);
  });

  /**
   * An active employee's behaviour has not changed: the new condition must
   * not break the old path.
   */
  it('an active employee behaves as before', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await s.http
      .post(`/api/v1/employees/${employeeId}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body({ deltaSec: 1800 }))
      .expect(201);

    expect(await creditedOf(employeeId)).toBe(1800);
  });
});

describe('reconciling with segments', () => {
  /**
   * `credited = worked + adjustment`: payroll and pace both stand on this sum
   * (section 2.1e, G35).
   *
   * The segment is inserted through the real ingest path, not by putting a
   * row in by hand: both `sessionId` and `deviceId` are mandatory on
   * `activity_segments`, and inserting by hand would skip the session
   * boundary rules (section 2.1a).
   */
  it('adds to worked time, does not replace it', async () => {
    const { employeeId: withDevice, code } = await createEmployeeWithCode(
      h.prisma,
      'OX-78',
    );
    const device = await enrollDevice(h, code);
    const worked = todayWindow(1800);

    await h
      .http()
      .post('/api/v1/agent/segments')
      .set('Authorization', `Bearer ${device.token}`)
      .set('X-Client-Time', realNow().toISOString())
      .send({
        segments: [
          {
            clientUuid: randomUUID(),
            state: 'active',
            startedAt: worked.startedAt.toISOString(),
            endedAt: worked.endedAt.toISOString(),
            durationSec: worked.durationSec,
          },
        ],
      })
      .expect(200);

    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    await s.http
      .post(`/api/v1/employees/${withDevice}/time-adjustments`)
      .set('X-CSRF-Token', s.csrf)
      .send(body({ deltaSec: 1800 }))
      .expect(201);

    const summary = await h.prisma.dailySummary.findFirst({
      where: { employeeId: withDevice },
    });

    // Both must be present: the raw work and the adjustment, neither changes the other
    //
    // Careful: `worked.durationSec`, not a hard-coded `1800`. Near midnight
    // `todayWindow()` clamps the window to today in Dhaka, so at 00:01 it
    // gives at most 58 s, not 1800 s (see the note in the harness). Matching
    // exactly what was sent avoids the test going red every night in a window
    // of about 2 minutes (CI ran at exactly that time: section 3b).
    expect(summary?.activeSec).toBe(worked.durationSec);
    expect(summary?.adjustmentSec).toBe(1800);
  });
});
