import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import { DashboardService } from '../src/dashboard/dashboard.service';
import {
  createHarness,
  workNoon,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * **"How many designs were finished" on the seven-day strip.**
 *
 * The owner's request: above *"Where Today Went"* on the board, how many
 * designs get done each day over the last 7 days.
 *
 * **The number is "finished", not "opened"** — and that is the owner's own
 * earlier choice (23 August, ADR-037). `design_credits` says how many files
 * were **opened**, and that number caused confusion in the field: a manager
 * showed "16" after spending 44 minutes on 19 files. So only `completed_at` is used here.
 *
 * **The real risk is at the day boundary.** `completed_at` is a timestamptz,
 * and that table has no `work_date` column — so the bucketing must go by the
 * work day. Most tests in this file check both sides of exactly that boundary.
 */
let h: Harness;
let dashboard: DashboardService;

const HOUR_MS = 3600_000;
/** Dhaka is UTC+6 — subtract this to go from the label (`workDateOf`) to the real moment */
const WORK_OFFSET_MS = 6 * HOUR_MS;

beforeAll(async () => {
  h = await createHarness();
  dashboard = h.app.get(DashboardService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

/** Today's working day in the work zone — as a label (UTC midnight) */
const today = () => workDateOf(workNoon());

/**
 * The **real moment** of a given hour inside one work day.
 *
 * This function is the centre of the file. `dayLabel` is a **label** — the
 * work day written as UTC midnight. That day's local midnight starts **6
 * hours before the label** (for the Asia/Dhaka zone the tests run in). Getting this wrong would silently shift every
 * boundary test the wrong way, and they would stay green.
 */
function atWorkHour(dayLabel: Date, hour: number): Date {
  return new Date(dayLabel.getTime() - WORK_OFFSET_MS + hour * HOUR_MS);
}

let asinCounter = 0;
async function finishedAt(when: Date | null): Promise<void> {
  const owner = await h.prisma.user.findFirstOrThrow();
  asinCounter += 1;

  await h.prisma.designTarget.create({
    data: {
      // Exactly 10 characters, upper case — the rule in `targets.rules.ts`
      asin: `B${String(asinCounter).padStart(9, '0')}`,
      addedById: owner.id,
      status: when === null ? 'pool' : 'done',
      completedAt: when,
    },
  });
}

const daysOf = async () => (await dashboard.teamTrend()).days;

describe('seven-day strip — how many designs were finished', () => {
  it("a design finished today goes into today's slot", async () => {
    await finishedAt(atWorkHour(today(), 11));
    await finishedAt(atWorkHour(today(), 15));

    const days = await daysOf();
    const todayRow = days.at(-1)!;

    expect(todayRow.designsFinished).toBe(2);
  });

  it('each day in its own slot — they do not mix', async () => {
    const t = today();
    await finishedAt(atWorkHour(new Date(t.getTime() - 2 * 86_400_000), 12));
    await finishedAt(atWorkHour(new Date(t.getTime() - 1 * 86_400_000), 12));
    await finishedAt(atWorkHour(new Date(t.getTime() - 1 * 86_400_000), 16));

    const days = await daysOf();

    expect(days.at(-3)!.designsFinished).toBe(1);
    expect(days.at(-2)!.designsFinished).toBe(2);
    expect(days.at(-1)!.designsFinished).toBe(0);
  });

  /**
   * **The most important test of this file — both sides of local midnight.**
   *
   * 23:30 in Dhaka is **17:30 the same day** in UTC; 00:30 in Dhaka is **18:30
   * the previous day** in UTC. If someone bucketed by the UTC day, every design
   * finished between **Dhaka midnight and 6 a.m.** would fall in **the previous
   * day's slot** — work finished late at night would be added to yesterday's
   * book. The number would be wrong, but no error would be raised.
   *
   * That six-hour window sounds small, but in this office designs often finish
   *    after midnight — and exactly those rows would go to the wrong day.
   */
  it("Dhaka 11:30 p.m. goes in today's slot, 12:30 a.m. in tomorrow's", async () => {
    const t = today();
    const yesterday = new Date(t.getTime() - 86_400_000);

    // Yesterday's Dhaka 11:30 p.m. → yesterday's slot
    await finishedAt(atWorkHour(yesterday, 23.5));
    // Today's Dhaka 12:30 a.m. → today's slot
    await finishedAt(atWorkHour(t, 0.5));

    const days = await daysOf();

    expect(days.at(-2)!.designsFinished).toBe(1);
    expect(days.at(-1)!.designsFinished).toBe(1);
  });

  /**
   * Anything outside the window is not counted — otherwise the strip's first
   *    day would become an "everything else" bucket, and the number would keep growing every day.
   */
  it('a design finished outside the seven days does not appear on the strip', async () => {
    const t = today();
    await finishedAt(atWorkHour(new Date(t.getTime() - 20 * 86_400_000), 12));

    const days = await daysOf();

    expect(days).toHaveLength(7);
    expect(days.reduce((a, d) => a + d.designsFinished, 0)).toBe(0);
  });

  /**
   * **A target that is not finished is not counted** — this guards "open vs
   * finished". If someone one day drops `completedAt` and starts counting by
   * `status` or `design_credits`, this test breaks.
   */
  it('a target lying in the pool is not "finished"', async () => {
    await finishedAt(null);
    await finishedAt(null);
    await finishedAt(atWorkHour(today(), 12));

    const days = await daysOf();

    expect(days.at(-1)!.designsFinished).toBe(1);
  });

  it('every slot is 0 when nothing is finished — not `undefined`', async () => {
    const days = await daysOf();

    expect(days).toHaveLength(7);
    expect(days.every((d) => d.designsFinished === 0)).toBe(true);
  });
});
