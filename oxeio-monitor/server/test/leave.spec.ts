import { describe, expect, it } from 'vitest';

import { expectedSecOf as trayExpectedSec } from '../src/agent/progress.math';
import { prorate } from '../src/summary/proration';
import {
  countLeaveWorkdays,
  elapsedWorkdays,
  proratedExpectedSec,
  rollupMonth,
} from '../src/summary/summary.math';

const HOUR = 3600;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/**
 * R2 — leave: four screens, one number.
 *
 * Leave enters in exactly four places, and three of them are parts of one fraction:
 *
 * ```
 *   targetSec  = (d − leave) × daily               ← prorate()
 *   expected   = targetSec × (elapsed − leave)     ← elapsedWorkdays()  [numerator]
 *                            ─────────────────
 *                              (d − leave)         ← proratedExpectedSec() [denominator]
 * ```
 *
 * Removing leave on one side and not the other is the only bug here that
 * silently gives a wrong number — it throws nothing, no test goes red, and
 * the person on leave simply shows "behind" all month. So the tests in this
 * file do not match numbers, they match invariant relationships.
 */

/** September 2026 — the fixture's weekly day off is Friday, 26 work days */
const SEPT = {
  monthStart: day('2026-09-01'),
  monthEnd: day('2026-09-30'),
  joinedOn: null,
  leftOn: null,
  weeklyOffDays: [5],
  holidays: new Set<number>(),
  monthlyTargetSec: 208 * HOUR,
  policyWorkdays: 26,
};

describe('countLeaveWorkdays — counts work days only', () => {
  const from = day('2026-09-01');
  const to = day('2026-09-30');

  it('leave on a work day is counted', () => {
    const leave = new Set([day('2026-09-01').getTime(), day('2026-09-02').getTime()]);
    expect(countLeaveWorkdays(leave, from, to, [5], new Set())).toBe(2);
  });

  it('a Friday (4 September) is not counted', () => {
    const leave = new Set([day('2026-09-04').getTime()]);
    expect(countLeaveWorkdays(leave, from, to, [5], new Set())).toBe(0);
  });

  it('a public holiday is not counted', () => {
    const leave = new Set([day('2026-09-07').getTime()]);
    const holidays = new Set([day('2026-09-07').getTime()]);
    expect(countLeaveWorkdays(leave, from, to, [5], holidays)).toBe(0);
  });

  it('a date outside the window is not counted', () => {
    const leave = new Set([day('2026-08-31').getTime(), day('2026-10-01').getTime()]);
    expect(countLeaveWorkdays(leave, from, to, [5], new Set())).toBe(0);
  });

  it('zero for an empty or missing set', () => {
    expect(countLeaveWorkdays(undefined, from, to, [5], new Set())).toBe(0);
    expect(countLeaveWorkdays(new Set(), from, to, [5], new Set())).toBe(0);
  });
});

describe('rollupMonth — leave', () => {
  /**
   * This was a real crash, not a hypothetical one.
   *
   * The old guard was `targetSec === 0 && expectedWorkdays > 0` -> throw.
   * For a staff member on leave the whole month both are true: the target is
   * 0 (leave reduces the target) and d is intact (leave is paid). And
   * `refreshMonth()` writes everyone's row in one loop — so one person's
   * leave would stop the monthly rows being written for the whole team.
   */
  it('does not throw even when the whole month is leave', () => {
    expect(() =>
      rollupMonth({
        workedSec: 0,
        adjustmentSec: 0,
        targetSec: 0,
        expectedWorkdays: 26,
        monthWorkdays: 26,
        leaveWorkdays: 26,
        workdaysElapsed: 0,
        observedWorkdays: 0,
        daysWithWork: 0,
      }),
    ).not.toThrow();
  });

  /** What the guard was there to catch is still caught */
  it('the target cannot be 0 if work days remain after removing leave', () => {
    expect(() =>
      rollupMonth({
        workedSec: 0,
        adjustmentSec: 0,
        targetSec: 0,
        expectedWorkdays: 26,
        monthWorkdays: 26,
        leaveWorkdays: 5,
        workdaysElapsed: 0,
        observedWorkdays: 0,
        daysWithWork: 0,
      }),
    ).toThrow(RangeError);
  });

  it('with the whole month on leave the expectation is 0 — so no shortfall either', () => {
    const m = rollupMonth({
      workedSec: 0,
      adjustmentSec: 0,
      targetSec: 0,
      expectedWorkdays: 26,
      monthWorkdays: 26,
      leaveWorkdays: 26,
      workdaysElapsed: 0,
      observedWorkdays: 0,
      daysWithWork: 0,
    });

    expect(m.expectedSec).toBe(0);
    expect(m.paceSec).toBe(0);
    expect(m.shortfallSec).toBe(0);
    // Yet d and D are intact — pay is in full
    expect(m.expectedWorkdays).toBe(26);
    expect(m.monthWorkdays).toBe(26);
    expect(m.leaveWorkdays).toBe(26);
  });
});

/**
 * This describe is the reason for this file.
 *
 * Leave is removed from both numerator and denominator, so the rate for one
 * billable day stays unchanged. That is, after taking leave the expectation
 * drops by exactly the days they did not work — not a second more or less.
 */
describe('expectation — leave in both numerator and denominator', () => {
  const DAILY = 8 * HOUR;

  it('the "expectation per elapsed day" is the same before and after leave', () => {
    // No leave: a 26-day target, 10 days elapsed
    const plain = proratedExpectedSec({
      targetSec: 26 * DAILY,
      expectedWorkdays: 26,
      workdaysElapsed: 10,
    });

    // 4 days of leave, 2 of which have already passed
    const withLeave = proratedExpectedSec({
      targetSec: 22 * DAILY,
      expectedWorkdays: 26,
      leaveWorkdays: 4,
      workdaysElapsed: 8,
    });

    expect(plain).toBe(10 * DAILY);
    expect(withLeave).toBe(8 * DAILY);
    // Both are exactly 8 hours per work day — the rate has not changed
    expect(withLeave / 8).toBe(plain / 10);
  });

  /**
   * If someone later forgets to remove leave from the denominator (or the
   * numerator), this test is the only thing that will catch it — because the
   * number will still look reasonable, just wrong.
   */
  it('removing it only from the numerator would drop the rate — that must not happen', () => {
    const correct = proratedExpectedSec({
      targetSec: 22 * DAILY,
      expectedWorkdays: 26,
      leaveWorkdays: 4,
      workdaysElapsed: 8,
    });
    const buggy = proratedExpectedSec({
      targetSec: 22 * DAILY,
      expectedWorkdays: 26, // if leave were forgotten in the denominator
      workdaysElapsed: 8,
    });

    expect(correct).toBe(8 * DAILY);
    expect(buggy).toBeLessThan(correct);
  });

  it('when every day of the month is leave the denominator is 0 — expectation 0 too, no division', () => {
    const p = proratedExpectedSec({
      targetSec: 0,
      expectedWorkdays: 26,
      leaveWorkdays: 26,
      workdaysElapsed: 0,
    });
    expect(p).toBe(0);
    expect(Number.isFinite(p)).toBe(true);
  });

  /**
   * The tray and the monthly row say the same number — the core rule of G88.
   *
   * The tray calls a different function (`progress.math.ts`) because it does
   * not throw. If leave did not reach it separately, staff would see
   * "behind" on their own screen while the owner saw "fine" on the Live
   * Board — and the tray is the screen they look at all day.
   */
  it('the tray\'s expectation matches the monthly row exactly', () => {
    const shared = {
      expectedWorkdays: 26,
      leaveWorkdays: 4,
      workdaysElapsed: 8,
      observedWorkdays: 8,
    };

    const monthly = proratedExpectedSec({ targetSec: 22 * DAILY, ...shared });
    const tray = trayExpectedSec({
      creditedSec: 0,
      monthlyTargetHours: (22 * DAILY) / HOUR,
      ...shared,
    });

    expect(tray).toBe(monthly);
  });
});

describe('elapsedWorkdays — leave', () => {
  const BASE = {
    periodStart: day('2026-09-01'),
    periodEnd: day('2026-09-30'),
    today: day('2026-09-15'),
    joinedOn: null,
    leftOn: null,
    trackingStartedOn: null,
    weeklyOffDays: [5],
    holidays: new Set<number>(),
  };

  it('leave inside the window is removed', () => {
    const plain = elapsedWorkdays(BASE);
    const leave = new Set([day('2026-09-01').getTime(), day('2026-09-02').getTime()]);
    expect(elapsedWorkdays(BASE, leave)).toBe(plain - 2);
  });

  /** Today is outside the window (today is not over) — so today's leave is outside too */
  it('today\'s leave is not removed, because today itself is not counted yet', () => {
    const plain = elapsedWorkdays(BASE);
    const leave = new Set([day('2026-09-15').getTime()]);
    expect(elapsedWorkdays(BASE, leave)).toBe(plain);
  });

  it('is never negative', () => {
    const all = new Set<number>();
    for (let n = 1; n <= 30; n++) all.add(day(`2026-09-${String(n).padStart(2, '0')}`).getTime());
    expect(elapsedWorkdays(BASE, all)).toBe(0);
  });
});

/**
 * The last guard is for the whole chain: `prorate()` -> `elapsedWorkdays()` ->
 * `proratedExpectedSec()`, in exactly the order `summary.service.ts` calls them.
 */
describe('the whole chain — no shortfall arises even after leave', () => {
  it('someone back from leave does not show "behind"', () => {
    // Leave from 1 to 3 September (all three are work days)
    const leaveDates = new Set([
      day('2026-09-01').getTime(),
      day('2026-09-02').getTime(),
      day('2026-09-03').getTime(),
    ]);

    const p = prorate({ ...SEPT, leaveDates });

    const elapsed = elapsedWorkdays(
      {
        periodStart: SEPT.monthStart,
        periodEnd: SEPT.monthEnd,
        today: day('2026-09-15'),
        joinedOn: null,
        leftOn: null,
        trackingStartedOn: null,
        weeklyOffDays: [5],
        holidays: SEPT.holidays,
      },
      leaveDates,
    );

    const expected = proratedExpectedSec({
      targetSec: p.targetSec,
      expectedWorkdays: p.employeeWorkdays,
      leaveWorkdays: p.leaveWorkdays,
      workdaysElapsed: elapsed,
    });

    // Returning after leave and working exactly those work days gives pace exactly 0
    const credited = elapsed * 8 * HOUR;
    expect(credited - expected).toBe(0);
  });
});
