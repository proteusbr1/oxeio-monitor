import { describe, expect, it } from 'vitest';

import {
  spreadIntoHourBuckets,
  spreadTeamIntoHourBuckets,
} from '../src/dashboard/dashboard.math';

/**
 * **E01 — the team's rhythm over the day** (`GET /live/pulse`).
 *
 * A pure function, so all of it can be tested without a DB. And there are
 * two things worth measuring: **no seconds are lost**, and **how many people** is truthful.
 */

/**
 * The working day is in Prisma's `@db.Date` shape — a UTC-midnight `Date`.
 *
 * But Dhaka's **local** midnight is six hours **before** that
 * (`dayStartUtcMs = workDate − 6h`). I first forgot this subtraction when
 * writing the helper, and six tests failed at once — all the work had
 * shifted by exactly six hours.
 *
 * This is the first real job of this test file: **catching timezone mistakes**.
 */
const WORK_OFFSET_MS = 6 * 3_600_000;
const DAY = new Date('2026-08-13T00:00:00.000Z');
const DAY_START_MS = DAY.getTime() - WORK_OFFSET_MS;

/** Starts at `hour` in the work zone, lasting `mins` minutes */
function seg(employeeId: number, hour: number, mins: number, atMin = 0) {
  const startMs = DAY_START_MS + hour * 3_600_000 + atMin * 60_000;
  return {
    employeeId,
    startedAt: new Date(startMs),
    endedAt: new Date(startMs + mins * 60_000),
    durationSec: mins * 60,
  };
}

describe('spreadTeamIntoHourBuckets · seconds arithmetic', () => {
  it('always 24 buckets, empty hours stay with zero', () => {
    const hours = spreadTeamIntoHourBuckets([], DAY);

    expect(hours).toHaveLength(24);
    expect(hours.map((h) => h.hour)).toEqual([...Array(24).keys()]);
    expect(hours.every((h) => h.activeSec === 0 && h.people === 0)).toBe(true);
  });

  it("two people's work in the same hour adds up", () => {
    const hours = spreadTeamIntoHourBuckets(
      [seg(1, 10, 60), seg(2, 10, 30)],
      DAY,
    );

    expect(hours[10].activeSec).toBe(90 * 60);
  });

  /**
   * This test is the real guard. Piling all segments into one bucket would
   * still give the right total, so the total cannot catch the bug — **how many people** does.
   */
  it('work crossing an hour boundary is split proportionally, and the total stays intact', () => {
    // 10:45 for 90 minutes → 15 min at 10, 60 min at 11, 15 min at 12
    const hours = spreadTeamIntoHourBuckets([seg(1, 10, 90, 45)], DAY);

    expect(hours[10].activeSec).toBe(15 * 60);
    expect(hours[11].activeSec).toBe(60 * 60);
    expect(hours[12].activeSec).toBe(15 * 60);

    const total = hours.reduce((a, h) => a + h.activeSec, 0);
    expect(total).toBe(90 * 60);
  });

  /**
   * One person's `/hourly` chart and the team's rhythm come from the **same
   * function**, so they can never tell different stories. If the rule were
   * duplicated, one day one would change and not the other — this test prevents that.
   */
  it("one person's figures match `spreadIntoHourBuckets` exactly", () => {
    const rows = [seg(7, 9, 50, 20), seg(7, 14, 130, 10), seg(7, 22, 45, 40)];

    const team = spreadTeamIntoHourBuckets(rows, DAY);
    const solo = spreadIntoHourBuckets(rows, DAY);

    expect(team.map((h) => h.activeSec)).toEqual(solo);
  });
});

describe('spreadTeamIntoHourBuckets · how many people', () => {
  /**
   * Without both of these tests together `people` would be meaningless — one
   * measures "the same person is not counted twice", the other "different people are counted separately".
   */
  it('if one employee has two segments in an hour, they count as one person', () => {
    const hours = spreadTeamIntoHourBuckets(
      [seg(1, 10, 20), seg(1, 10, 20, 30)],
      DAY,
    );

    expect(hours[10].people).toBe(1);
    expect(hours[10].activeSec).toBe(40 * 60);
  });

  it('different employees are counted separately', () => {
    const hours = spreadTeamIntoHourBuckets(
      [seg(1, 10, 20), seg(2, 10, 20), seg(3, 10, 20)],
      DAY,
    );

    expect(hours[10].people).toBe(3);
  });

  /**
   * `> 0` with no threshold — if even one second falls in that hour, the person "was there".
   * A threshold would be a silent opinion, and nobody would know why one early-morning person vanished.
   */
  it('even a small amount of time at the edge of an hour counts the person', () => {
    // 09:59:30 → 10:00:30, i.e. 30 seconds in each of two hour cells.
    // Exact second boundaries are needed, so not `seg()` — its step is a minute.
    const start = DAY_START_MS + 9 * 3_600_000 + 59 * 60_000 + 30_000;
    const hours = spreadTeamIntoHourBuckets(
      [
        {
          employeeId: 4,
          startedAt: new Date(start),
          endedAt: new Date(start + 60_000),
          durationSec: 60,
        },
      ],
      DAY,
    );

    expect(hours[9].activeSec).toBe(30);
    expect(hours[10].activeSec).toBe(30);
    expect(hours[9].people).toBe(1);
    expect(hours[10].people).toBe(1);
  });

  it('in an hour when nobody was there, zero — and that is a valid answer', () => {
    const hours = spreadTeamIntoHourBuckets([seg(1, 10, 30)], DAY);

    expect(hours[3].people).toBe(0);
    expect(hours[3].activeSec).toBe(0);
  });

  /**
   * `peakPeople` (counted in the service) rests on exactly this number — the
   * limit of the chart's y-axis. So we measure whether the maximum really is the maximum.
   */
  it("the most people at once — that is the chart's axis limit", () => {
    const hours = spreadTeamIntoHourBuckets(
      [seg(1, 9, 60), seg(1, 14, 60), seg(2, 14, 60), seg(3, 14, 60)],
      DAY,
    );

    expect(Math.max(...hours.map((h) => h.people))).toBe(3);
    expect(hours[9].people).toBe(1);
    expect(hours[14].people).toBe(3);
  });
});
