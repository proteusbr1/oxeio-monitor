import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ProgressService } from '../src/agent/progress.service';
import { workDateOf } from '../src/agent/util/dhaka-time';
import { SummaryService } from '../src/summary/summary.service';
import {
  createHarness,
  dhakaNoon,
  OWNER_EMAIL,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * **G112 — whether the tray's "how many hours" and the dashboard's "how many hours" agree.**
 *
 * **The gap this file closes:** the tray (`progress.service.ts`) counted hours
 * with `Σ activity_segments.duration_sec` — the **raw sum of the agent's
 * monotonic clock**. But `daily_summary.worked_sec` comes from the **UNION**
 * of wall-clock `started_at`–`ended_at` (`summarizeDay`). The two are
 * deliberately different yardsticks, and `summary.math.ts` itself says they do
 * not match exactly.
 *
 * **The difference is biggest for an employee with two devices:** work on
 * two machines at once is counted **twice** in the raw sum and once in the
 * UNION. So their own tray showed them **more hours** than the dashboard did —
 * and it would never be caught unless someone put the two side by side. G32's
 * `device_overlap` alert measures exactly that difference, so the system
 * itself knew the number; only the tray did not.
 *
 * Both sides of pace: the **expectation** side already moved to one
 * definition (`elapsedWindow`), the **work** side moves in this batch. Before
 * that, "the tray and the dashboard agree" was only half true.
 *
 * **No pinned date in this file** (G140) — all fixtures are relative to
 * "today", because the tray always speaks about the current month and today.
 */
let h: Harness;
let progress: ProgressService;
let summary: SummaryService;

const HOUR = 3600;
const MS_PER_DAY = 86_400_000;

beforeAll(async () => {
  h = await createHarness();
  progress = h.app.get(ProgressService);
  summary = h.app.get(SummaryService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

const today = () => workDateOf(dhakaNoon());

async function makeEmployee(empCode: string): Promise<number> {
  const policy = await h.prisma.workPolicy.findFirst();
  const e = await h.prisma.employee.create({
    data: {
      empCode,
      fullName: `Test ${empCode}`,
      designation: 'Developer',
      status: 'active',
      monthlySalary: 20000,
      policyId: policy?.id ?? null,
    },
  });
  return e.id;
}

async function makeDevice(employeeId: number, tag: string): Promise<number> {
  const d = await h.prisma.device.create({
    data: {
      hostname: `PC-${tag}`,
      windowsUsername: `user-${tag}`,
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
    },
  });
  return d.id;
}

/**
 * Adds one active segment — `hours` hours starting at `hour` of that working day.
 *
 * `durationSec` is kept **equal to the wall-clock length**, because this
 *    file's claim is not about monotonic vs wall-clock — it is about **sum vs
 *    UNION**. Moving both at once would make it impossible to tell which one changed the number.
 *
 * Each segment has its own `work_sessions` row — `sessionId` is mandatory
 *    in the schema, and that table is the source of "since when we have been watching" (G120).
 */
async function addSegment(opts: {
  employeeId: number;
  deviceId: number;
  workDate: Date;
  hour: number;
  hours: number;
}): Promise<void> {
  const startedAt = new Date(opts.workDate.getTime() + opts.hour * HOUR * 1000);
  const endedAt = new Date(startedAt.getTime() + opts.hours * HOUR * 1000);

  const session = await h.prisma.workSession.create({
    data: {
      employeeId: opts.employeeId,
      deviceId: opts.deviceId,
      workDate: opts.workDate,
      startedAt,
      endedAt,
    },
  });

  await h.prisma.activitySegment.create({
    data: {
      sessionId: session.id,
      employeeId: opts.employeeId,
      deviceId: opts.deviceId,
      clientUuid: randomUUID(),
      workDate: opts.workDate,
      startedAt,
      endedAt,
      state: 'active',
      countsAsWork: true,
      durationSec: opts.hours * HOUR,
    },
  });
}

const trayOf = (employeeId: number) =>
  progress.forEmployee(employeeId, dhakaNoon());

describe('G112 — work on two devices at the same time is counted once', () => {
  /**
   * **The most important test of this file.**
   *
   * Two devices, **exactly the same four hours**. The raw sum said 8 hours,
   * the wall-clock UNION says 4 — and the person really did sit four hours.
   */
  it('today the same 4 hours on two PCs — the tray says 4, not 8', async () => {
    const id = await makeEmployee('G112-OVERLAP');
    const a = await makeDevice(id, 'a');
    const b = await makeDevice(id, 'b');
    const day = today();

    await addSegment({ employeeId: id, deviceId: a, workDate: day, hour: 10, hours: 4 });
    await addSegment({ employeeId: id, deviceId: b, workDate: day, hour: 10, hours: 4 });

    const tray = await trayOf(id);

    expect(tray.todayActiveSec).toBe(4 * HOUR);
    expect(tray.monthActiveSec).toBe(4 * HOUR);
  });

  it('with no overlap nothing changes — the sum and the UNION are the same then', async () => {
    // This is the safety net: the numbers of an employee with a single PC did not move at all.
    const id = await makeEmployee('G112-SINGLE');
    const a = await makeDevice(id, 'solo');
    const day = today();

    await addSegment({ employeeId: id, deviceId: a, workDate: day, hour: 9, hours: 3 });
    await addSegment({ employeeId: id, deviceId: a, workDate: day, hour: 14, hours: 2 });

    expect((await trayOf(id)).todayActiveSec).toBe(5 * HOUR);
  });
});

describe('G112 — finished days come from the rollup', () => {
  /**
   * **Equality is the real guard.** Just comparing two constants would stay
   * green even if the two numbers drifted apart again in future — so here
   * **the tray's number and the dashboard's row are compared directly**.
   */
  it("the tray's monthly hours = Σ daily_summary.worked_sec", async () => {
    const id = await makeEmployee('G112-PAST');
    const a = await makeDevice(id, 'past');

    // Yesterday and the day before — today is deliberately empty, so the claim
    //    stands only on "finished days"
    const yesterday = new Date(today().getTime() - MS_PER_DAY);
    const before = new Date(today().getTime() - 2 * MS_PER_DAY);

    await addSegment({ employeeId: id, deviceId: a, workDate: before, hour: 10, hours: 6 });
    await addSegment({ employeeId: id, deviceId: a, workDate: yesterday, hour: 10, hours: 5 });

    await summary.refreshDate(before, dhakaNoon());
    await summary.refreshDate(yesterday, dhakaNoon());

    const rows = await h.prisma.dailySummary.findMany({
      where: { employeeId: id, workDate: { lt: today() } },
      select: { workedSec: true },
    });
    const fromRollup = rows.reduce((a2, r) => a2 + r.workedSec, 0);

    const tray = await trayOf(id);

    expect(fromRollup).toBe(11 * HOUR);
    expect(tray.monthActiveSec).toBe(fromRollup);
    expect(tray.todayActiveSec).toBe(0);
  });

  /**
   * **Both sides of the boundary — and the single character of `lt` vs `lte`.**
   *
   * If today came from both the rollup **and** the live segments, the morning's
   * work would be counted twice. Today's `daily_summary` row is deliberately
   * written here too, so that the mistake is caught if it occurs.
   */
  it('today is not counted twice — even if the rollup has run', async () => {
    const id = await makeEmployee('G112-BOUNDARY');
    const a = await makeDevice(id, 'edge');
    const day = today();

    await addSegment({
        employeeId: id,
        deviceId: a,
        workDate: day,
        hour: 9,
        hours: 3,
      });

    // the rollup wrote today's row too
    await summary.refreshDate(day, dhakaNoon());

    const tray = await trayOf(id);

    expect(tray.todayActiveSec).toBe(3 * HOUR);
    // not 6 — just once
    expect(tray.monthActiveSec).toBe(3 * HOUR);
  });

  it('yesterday + today — the two sources join up, none is lost', async () => {
    const id = await makeEmployee('G112-BOTH');
    const a = await makeDevice(id, 'both');
    const day = today();
    const yesterday = new Date(day.getTime() - MS_PER_DAY);

    await addSegment({ employeeId: id, deviceId: a, workDate: yesterday, hour: 10, hours: 7 });
    await addSegment({ employeeId: id, deviceId: a, workDate: day, hour: 10, hours: 2 });
    await summary.refreshDate(yesterday, dhakaNoon());

    const tray = await trayOf(id);

    expect(tray.todayActiveSec).toBe(2 * HOUR);
    expect(tray.monthActiveSec).toBe(9 * HOUR);
  });

  /**
   * The rollup has not yet written that day — then the number is lower, **not higher**.
   *
   * This is a deliberate price, and the price is paid on this side: a missing
   *    row says "zero hours", not "unknown". Going back to raw segments to fill
   *    the gap would bring the two definitions back — i.e. G112 itself would return.
   */
  it("if yesterday's rollup has not run the number is lower — but the dashboard is lower then too", async () => {
    const id = await makeEmployee('G112-NOROLLUP');
    const a = await makeDevice(id, 'stale');
    const yesterday = new Date(today().getTime() - MS_PER_DAY);

    await addSegment({
        employeeId: id,
        deviceId: a,
        workDate: yesterday,
        hour: 10,
        hours: 5,
      });
    // refreshDate was deliberately not run

    const rows = await h.prisma.dailySummary.findMany({ where: { employeeId: id } });
    expect(rows).toHaveLength(0);

    expect((await trayOf(id)).monthActiveSec).toBe(0);
  });
});


/**
 * **G162 — one month, one number.**
 *
 * **The bug this block guards:** in the lower row of the My data page the
 * *"This month so far"* figure was **added up in the browser** — from the
 * `creditedSec` of the list rows. The *"This month"* tile above came from the
 * server's `monthActiveSec`. Two numbers on one screen, and for three
 * separate reasons they did not match:
 *
 * 1. **Window** — the list is a rolling 30 days, so on the 31st of the month
 *    the 1st was never fetched. Seven days a year, silently, almost a working day short.
 * 2. **Quantity** — the lower one is `credited` (with adjustments), the upper
 *    one `worked`. With even one adjustment the difference is exactly the adjustment.
 * 3. **Definition** — the lower one added raw `duration_sec`, the upper one
 *    the UNION. Working on two PCs at once, the lower one counted the time
 *    twice (the same gap as G112, only on another page).
 *
 * So the number is no longer built in the browser — what the server uses to
 * work out `paceSec` goes out as `monthCreditedSec`, and the screen shows exactly that.
 */
describe("G162 — the month's credited number comes from the server", () => {
  /** The owner's user id — needed to write the adjustment rows */
  const ownerId = async () =>
    (await h.prisma.user.findFirstOrThrow({ where: { email: OWNER_EMAIL } })).id;

  async function adjust(employeeId: number, workDate: Date, deltaSec: number) {
    await h.prisma.timeAdjustment.create({
      data: {
        employeeId,
        workDate,
        deltaSec,
        cause: 'agent_down',
        reason: 'G162 test',
        createdById: await ownerId(),
      },
    });
  }

  /**
   * **The main test of this block** — an adjustment goes into
   * `monthCreditedSec`, not into `monthActiveSec`.
   *
   * Both are needed, and they stay separate: the tile and the tray show
   *    **how much work was done**, and the sum below shows **how much was
   *    counted**. The earlier bug was putting one in place of the other, not having both.
   */
  it('an adjustment goes into credited, not into worked', async () => {
    const id = await makeEmployee('G162-ADJ');
    const a = await makeDevice(id, 'adj');
    const day = today();

    await addSegment({ employeeId: id, deviceId: a, workDate: day, hour: 10, hours: 5 });
    await adjust(id, day, 2 * HOUR);

    const tray = await trayOf(id);

    expect(tray.monthActiveSec).toBe(5 * HOUR);
    expect(tray.monthCreditedSec).toBe(7 * HOUR);
  });

  /** A revoked adjustment gives no hours back — the same rule as `/me/days` */
  it('a revoked adjustment is not counted', async () => {
    const id = await makeEmployee('G162-REVOKED');
    const a = await makeDevice(id, 'rev');
    const day = today();

    await addSegment({ employeeId: id, deviceId: a, workDate: day, hour: 10, hours: 4 });
    await adjust(id, day, 3 * HOUR);
    await h.prisma.timeAdjustment.updateMany({
      data: { revokedAt: dhakaNoon(), revokeReason: 'G162 test' },
    });

    expect((await trayOf(id)).monthCreditedSec).toBe(4 * HOUR);
  });

  /**
   * **With no adjustments the two numbers are exactly the same** — in the
   * field today that is exactly the state (`time_adjustments` is empty), which
   * is why the bug stayed **unseen** so long.
   * This test writes that silence down: the agreement is not a coincidence.
   */
  it('with no adjustments credited and worked are the same', async () => {
    const id = await makeEmployee('G162-NOADJ');
    const a = await makeDevice(id, 'plain');

    await addSegment({
      employeeId: id,
      deviceId: a,
      workDate: today(),
      hour: 9,
      hours: 6,
    });

    const tray = await trayOf(id);

    expect(tray.monthCreditedSec).toBe(tray.monthActiveSec);
    expect(tray.monthCreditedSec).toBe(6 * HOUR);
  });

  /**
   * **An overlap between two PCs counts once in credited too.** The old
   * browser sum added raw `duration_sec`, so this employee's lower number
   * showed **double** the tile above — both on the same screen.
   */
  it('the same 4 hours on two PCs — credited is 4 too, not 8', async () => {
    const id = await makeEmployee('G162-OVERLAP');
    const a = await makeDevice(id, 'ov-a');
    const b = await makeDevice(id, 'ov-b');
    const day = today();

    await addSegment({ employeeId: id, deviceId: a, workDate: day, hour: 10, hours: 4 });
    await addSegment({ employeeId: id, deviceId: b, workDate: day, hour: 10, hours: 4 });

    expect((await trayOf(id)).monthCreditedSec).toBe(4 * HOUR);
  });

  /**
   * **The 1st of the month is caught too.** Under the old rule the list came
   * from `today − 29`, so on the 31st the 1st was in no row — though it
   * should be in the month's sum.
   *
   * The 31st is not pinned here (G140): hours are placed on the **first** day
   * of the month and we check whether they are in the sum — however small the window.
   */
  it("hours on the month's first day are in the sum too", async () => {
    const id = await makeEmployee('G162-FIRSTDAY');
    const a = await makeDevice(id, 'first');
    const day = today();
    const firstOfMonth = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1),
    );

    if (firstOfMonth.getTime() === day.getTime()) {
      // If today is the 1st there is no "previous day" — then today's alone is enough
      await addSegment({ employeeId: id, deviceId: a, workDate: day, hour: 10, hours: 3 });
      expect((await trayOf(id)).monthCreditedSec).toBe(3 * HOUR);
      return;
    }

    await addSegment({
      employeeId: id,
      deviceId: a,
      workDate: firstOfMonth,
      hour: 10,
      hours: 3,
    });
    await summary.refreshDate(firstOfMonth, dhakaNoon());
    await addSegment({ employeeId: id, deviceId: a, workDate: day, hour: 10, hours: 1 });

    expect((await trayOf(id)).monthCreditedSec).toBe(4 * HOUR);
  });
});
