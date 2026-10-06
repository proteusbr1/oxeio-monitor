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
 * **"How many tasks were finished" on the seven-day strip.**
 *
 * The owner's request: above *"Where Today Went"* on the board, how many
 * tasks get done each day over the last 7 days.
 *
 * **The number is "finished", not "started"** — and that is the owner's own
 * earlier choice (ADR-037). `task_credits` says how many tasks were
 * **brought to the screen**, and that number caused confusion in the field:
 * someone showed "16" after glancing at 19 windows for 44 minutes. So only
 * `completed_at` is used here.
 *
 * **The real risk is at the day boundary.** `completed_at` is a timestamptz,
 * and that table has no `work_date` column — so the bucketing must go by the
 * work day. Most tests in this file check both sides of exactly that boundary.
 */
let h: Harness;
let dashboard: DashboardService;

const HOUR_MS = 3600_000;
/** The test work zone is UTC+6 — subtract this to go from the label (`workDateOf`) to the real moment */
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
 * hours before the label** (for the UTC+6 work zone the tests run in). Getting this wrong would silently shift every
 * boundary test the wrong way, and they would stay green.
 */
function atWorkHour(dayLabel: Date, hour: number): Date {
  return new Date(dayLabel.getTime() - WORK_OFFSET_MS + hour * HOUR_MS);
}

let refCounter = 0;
async function finishedAt(when: Date | null): Promise<void> {
  const owner = await h.prisma.user.findFirstOrThrow();
  refCounter += 1;

  await h.prisma.task.create({
    data: {
      reference: `REF-${refCounter}`,
      addedById: owner.id,
      status: when === null ? 'pool' : 'done',
      completedAt: when,
    },
  });
}

const daysOf = async () => (await dashboard.teamTrend()).days;

describe('seven-day strip — how many tasks were finished', () => {
  it("a task finished today goes into today's slot", async () => {
    await finishedAt(atWorkHour(today(), 11));
    await finishedAt(atWorkHour(today(), 15));

    const days = await daysOf();
    const todayRow = days.at(-1)!;

    expect(todayRow.tasksDone).toBe(2);
  });

  it('each day in its own slot — they do not mix', async () => {
    const t = today();
    await finishedAt(atWorkHour(new Date(t.getTime() - 2 * 86_400_000), 12));
    await finishedAt(atWorkHour(new Date(t.getTime() - 1 * 86_400_000), 12));
    await finishedAt(atWorkHour(new Date(t.getTime() - 1 * 86_400_000), 16));

    const days = await daysOf();

    expect(days.at(-3)!.tasksDone).toBe(1);
    expect(days.at(-2)!.tasksDone).toBe(2);
    expect(days.at(-1)!.tasksDone).toBe(0);
  });

  /**
   * **The most important test of this file — both sides of local midnight.**
   *
   * 23:30 in the work zone is **17:30 the same day** in UTC; 00:30 there is **18:30
   * the previous day** in UTC. If someone bucketed by the UTC day, every task
   * finished between **work-zone midnight and 6 a.m.** would fall in **the previous
   * day's slot** — work finished late at night would be added to yesterday's
   * book. The number would be wrong, but no error would be raised.
   *
   * That six-hour window sounds small, but in many offices tasks often finish
   *    after midnight — and exactly those rows would go to the wrong day.
   */
  it("work-zone 11:30 p.m. goes in today's slot, 12:30 a.m. in tomorrow's", async () => {
    const t = today();
    const yesterday = new Date(t.getTime() - 86_400_000);

    // Yesterday's 11:30 p.m. in the work zone → yesterday's slot
    await finishedAt(atWorkHour(yesterday, 23.5));
    // Today's 12:30 a.m. in the work zone → today's slot
    await finishedAt(atWorkHour(t, 0.5));

    const days = await daysOf();

    expect(days.at(-2)!.tasksDone).toBe(1);
    expect(days.at(-1)!.tasksDone).toBe(1);
  });

  /**
   * Anything outside the window is not counted — otherwise the strip's first
   *    day would become an "everything else" bucket, and the number would keep growing every day.
   */
  it('a task finished outside the seven days does not appear on the strip', async () => {
    const t = today();
    await finishedAt(atWorkHour(new Date(t.getTime() - 20 * 86_400_000), 12));

    const days = await daysOf();

    expect(days).toHaveLength(7);
    expect(days.reduce((a, d) => a + d.tasksDone, 0)).toBe(0);
  });

  /**
   * **A task that is not finished is not counted** — this guards "open vs
   * finished". If someone one day drops `completedAt` and starts counting by
   * `status` or `task_credits`, this test breaks.
   */
  it('a task lying in the pool is not "finished"', async () => {
    await finishedAt(null);
    await finishedAt(null);
    await finishedAt(atWorkHour(today(), 12));

    const days = await daysOf();

    expect(days.at(-1)!.tasksDone).toBe(1);
  });

  it('every slot is 0 when nothing is finished — not `undefined`', async () => {
    const days = await daysOf();

    expect(days).toHaveLength(7);
    expect(days.every((d) => d.tasksDone === 0)).toBe(true);
  });
});
