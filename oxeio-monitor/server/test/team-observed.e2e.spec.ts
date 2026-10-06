import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { SummaryService } from '../src/summary/summary.service';
import {
  createHarness,
  workNoon,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * **G111 — how many people the Live Board's team total really covers.**
 *
 * The card's pace is `Σ credited − Σ expected`, and both sums come from
 * `monthly_summary`. Anyone who has not yet had a single **finished** working
 * day seen has `expected_sec` 0 — so their **whole target is silently dropped
 * from the denominator**. The error therefore always leans the same way: **the
 * board shows the team less behind than it is**. It happens exactly when
 * someone new joins or someone's agent is installed late, and that is when
 * nobody notices.
 *
 * Their targets were not put into the sum — the board would then claim a
 * shortfall nobody actually incurred, curing one lie with the opposite lie.
 * **The number is not left out, it is disclosed.**
 *
 * An e2e is needed because the risk is not in the arithmetic —
 * `isObserved()` itself is tested in `tracking-start.spec.ts`. The risk is **at
 * the join**: whether the query pulls the `workdays_elapsed` column at all,
 * and if it does, whether it reaches the card. This project has had more than
 * ten bugs of exactly this shape ("the contract is written, the caller was not").
 *
 * **No pinned date in this file** (G140): `teamTrend()` picks the current
 * month itself, so all fixtures are relative to "today". The window stops
 * **yesterday**, and yesterday may be a Friday or Eid — so to prove "was
 * seen", sessions are placed over the last 20 days, not one. Relying on one
 * day would turn the test red one day a week, with nobody able to find the cause.
 */
let h: Harness;
let summary: SummaryService;
let dashboard: DashboardService;

const HOUR = 3600;
const MS_PER_DAY = 86_400_000;

beforeAll(async () => {
  h = await createHarness();
  summary = h.app.get(SummaryService);
  dashboard = h.app.get(DashboardService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

/** Today's working day in Dhaka — all fixtures are relative to it */
const today = () => workDateOf(workNoon());

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

/**
 * Sessions over the last 20 days — i.e. "we have been watching them for a long time".
 *
 * Careful: this goes back before the 1st of the month, deliberately: tracking
 *    start is not filtered by month, otherwise everyone would become "unseen" again on the 1st of each month.
 */
async function seeSessions(employeeId: number): Promise<void> {
  const device = await h.prisma.device.create({
    data: {
      hostname: `PC-${employeeId}`,
      windowsUsername: `user${employeeId}`,
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
    },
  });

  const base = today().getTime();
  await h.prisma.workSession.createMany({
    data: Array.from({ length: 20 }, (_, i) => {
      const workDate = new Date(base - (i + 1) * MS_PER_DAY);
      return {
        employeeId,
        deviceId: device.id,
        workDate,
        startedAt: new Date(workDate.getTime() + 4 * HOUR * 1000),
      };
    }),
  });
}

const rollup = () => summary.refreshDate(today(), workNoon());

describe("G111 — the board's card says how many people the total covers", () => {
  it('everyone has been seen — nobody is outside', async () => {
    const id = await makeEmployee('OBS-ALL');
    await seeSessions(id);
    await rollup();

    const { month } = await dashboard.teamTrend();

    expect(month.observedStaff).toBe(1);
    expect(month.notObservedStaff).toBe(0);
  });

  it('the agent never sent anything — they are outside the total, and that is stated', async () => {
    await makeEmployee('OBS-NONE');
    await rollup();

    const { month } = await dashboard.teamTrend();

    expect(month.observedStaff).toBe(0);
    expect(month.notObservedStaff).toBe(1);
  });

  /**
   * **The most important test in this file — the silent subtraction shows up here.**
   *
   * Both have the same target, but **only one** is in the expected sum. So the
   * card's denominator is halved, and pace looks better in the same proportion.
   * The number is not wrong — it is incomplete, and not saying so would amount to a lie.
   */
  it('an unseen person has a target but no expectation — the total itself is incomplete', async () => {
    const seen = await makeEmployee('OBS-SEEN');
    await seeSessions(seen);
    await makeEmployee('OBS-UNSEEN');
    await rollup();

    const rows = await h.prisma.monthlySummary.findMany({
      select: { targetSec: true, expectedSec: true, workdaysElapsed: true },
    });
    expect(rows).toHaveLength(2);

    const withExpectation = rows.filter((r) => r.expectedSec > 0);
    expect(withExpectation).toHaveLength(1);

    // Yet both have targets — the window does not touch targets
    expect(rows.every((r) => r.targetSec > 0)).toBe(true);

    const { month } = await dashboard.teamTrend();
    expect(month.notObservedStaff).toBe(1);
    expect(month.observedStaff).toBe(1);
  });

  /**
   * The total always covers everyone — nobody should get lost between two boxes.
   *
   * If someone ever turns `observedStaff` into "those who have hours", a person
   *    who was seen but has zero hours would fall into neither box — and the
   *    card would say "counted for 11 people" when there are 12 staff.
   */
  it('seen + unseen = everyone', async () => {
    const a = await makeEmployee('OBS-A');
    await seeSessions(a);
    await makeEmployee('OBS-B');
    await makeEmployee('OBS-C');
    await rollup();

    const { month } = await dashboard.teamTrend();

    expect(month.observedStaff + month.notObservedStaff).toBe(3);
  });
});

/**
 * **G130 (R2) — "on leave" on the card.**
 *
 * `LiveCard.todayIsWorkday` says whether the day is a working day in the
 * **office** calendar — Fridays and public holidays. **Personal leave is not
 * in it**, so an employee on leave showed "0h / 8h" and an empty meter on the
 * card: exactly like someone skipping work. Yet their target and pace had
 * long since excused them.
 *
 * The screen's rule is in `dayDuty()` in `web/src/pages/live/roster.ts`, with
 * tests. Here we check only whether **the truth reaches the card**.
 */
describe('G130 — the card says they are on leave today', () => {
  const cardFor = async (empCode: string) => {
    const board = await dashboard.live(workNoon());
    return board.cards.find((c) => c.empCode === empCode)!;
  };

  it('when leave is recorded, a flag appears on the card', async () => {
    const id = await makeEmployee('G130-CARD');
    await h.prisma.leave.create({
      data: { employeeId: id, leaveDate: today(), createdBy: 'test@oxeio' },
    });

    expect((await cardFor('G130-CARD')).onLeaveToday).toBe(true);
  });

  it('without leave, it does not appear', async () => {
    await makeEmployee('G130-NOCARD');
    expect((await cardFor('G130-NOCARD')).onLeaveToday).toBe(false);
  });

  /**
   * **Another day's leave must not show on today's card** — otherwise once
   * someone took leave the badge would hang there all month, and people would stop reading it.
   */
  it("yesterday's leave does not show on today's card", async () => {
    const id = await makeEmployee('G130-YDAY');
    await h.prisma.leave.create({
      data: {
        employeeId: id,
        leaveDate: new Date(today().getTime() - MS_PER_DAY),
        createdBy: 'test@oxeio',
      },
    });

    expect((await cardFor('G130-YDAY')).onLeaveToday).toBe(false);
  });

  /**
   * **The leave flag and the target — from the same set.**
   *
   * If the badge came from a separate query, one day the card would say "on
   * leave" while the monthly target was not reduced — the card contradicting itself.
   */
  it("taking leave also lowers the card's monthly target", async () => {
    const withLeave = await makeEmployee('G130-T-YES');
    await makeEmployee('G130-T-NO');

    // A bunch of days, so that at least a few fall on working days — relying on
    //    whether yesterday was a Friday would turn the test red one day a week (G140)
    const base = today().getTime();
    await h.prisma.leave.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        employeeId: withLeave,
        leaveDate: new Date(base + i * MS_PER_DAY),
        createdBy: 'test@oxeio',
      })),
    });

    const a = await cardFor('G130-T-YES');
    const b = await cardFor('G130-T-NO');

    expect(a.onLeaveToday).toBe(true);
    expect(a.monthTargetSec).toBeLessThan(b.monthTargetSec);
  });
});
