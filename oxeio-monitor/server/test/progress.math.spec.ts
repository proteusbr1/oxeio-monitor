import { describe, expect, it } from 'vitest';

import { expectedSecOf, paceSecOf } from '../src/agent/progress.math';

/**
 * B05b: the tray's "ahead / behind".
 *
 * Staff see this number every day, so a wrong value would not stay silently
 * wrong: it would quietly build distrust. That is why the boundary cases
 * dominate here.
 */
const BASE = {
  creditedSec: 0,
  monthlyTargetHours: 208,
  expectedWorkdays: 26,
  workdaysElapsed: 0,
};

describe('expectedSecOf: how much should be done by today', () => {
  it('at the start of the month (no workday elapsed) the expectation is zero', () => {
    expect(expectedSecOf(BASE)).toBe(0);
  });

  it('at half the workdays, exactly half the target', () => {
    expect(expectedSecOf({ ...BASE, workdaysElapsed: 13 })).toBe(
      (208 * 3600) / 2,
    );
  });

  /**
   * The most important case: on the last workday of the month the expectation
   * lands exactly on the target, no more and no less. Otherwise an employee
   * who worked perfectly all month would still show "behind" on the last day.
   */
  it('on the last workday of the month the expectation = the full target', () => {
    expect(expectedSecOf({ ...BASE, workdaysElapsed: 26 })).toBe(208 * 3600);
  });

  it('with more holidays the daily expectation rises, the total target does not', () => {
    const eid = { ...BASE, expectedWorkdays: 20, workdaysElapsed: 20 };
    expect(expectedSecOf(eid)).toBe(208 * 3600);
    // 208 hours in 20 days is 10.4 hours a day
    expect(expectedSecOf({ ...eid, workdaysElapsed: 1 })).toBe(
      Math.round((208 * 3600) / 20),
    );
  });

  /**
   * Declaring the whole month a holiday gives `expectedWorkdays === 0`. If the
   * division were not guarded, `NaN` would go on the wire, and the agent's STJ
   * does not understand `NaN`: then the entire heartbeat response (including
   * the revoke command) could not be read.
   */
  it('with zero workdays it gives 0, not NaN', () => {
    const out = expectedSecOf({ ...BASE, expectedWorkdays: 0 });
    expect(Number.isNaN(out)).toBe(false);
    expect(out).toBe(0);
  });

  it('a target of 0 or negative does not throw, it gives 0', () => {
    expect(expectedSecOf({ ...BASE, monthlyTargetHours: 0 })).toBe(0);
    expect(expectedSecOf({ ...BASE, monthlyTargetHours: -8 })).toBe(0);
  });

  it('even with more elapsed days than workdays the expectation does not exceed the target', () => {
    expect(expectedSecOf({ ...BASE, workdaysElapsed: 99 })).toBe(208 * 3600);
  });

  it('always an integer: fractions of a second do not go on the wire', () => {
    const out = expectedSecOf({
      ...BASE,
      monthlyTargetHours: 208,
      expectedWorkdays: 23,
      workdaysElapsed: 7,
    });
    expect(Number.isInteger(out)).toBe(true);
  });
});

describe('paceSecOf: ahead or behind', () => {
  it('working exactly as expected gives a pace of exactly 0', () => {
    const input = { ...BASE, workdaysElapsed: 13 };
    expect(paceSecOf({ ...input, creditedSec: expectedSecOf(input) })).toBe(0);
  });

  it('more work = positive (ahead)', () => {
    const input = { ...BASE, workdaysElapsed: 10, creditedSec: 90 * 3600 };
    expect(paceSecOf(input)).toBeGreaterThan(0);
  });

  it('less work = negative (behind)', () => {
    const input = { ...BASE, workdaysElapsed: 10, creditedSec: 10 * 3600 };
    expect(paceSecOf(input)).toBeLessThan(0);
  });

  /**
   * Section 2.1(e) (G35): the owner's adjustment must be counted in the pace.
   * Otherwise, after giving back hours a staff member lost through a server
   * fault, the tray would still say "behind" all month while the dashboard
   * said ahead.
   */
  it('when adjustment hours are added, the pace moves ahead', () => {
    const input = { ...BASE, workdaysElapsed: 10 };
    const without = paceSecOf({ ...input, creditedSec: 60 * 3600 });
    const withAdj = paceSecOf({ ...input, creditedSec: 60 * 3600 + 7200 });
    expect(withAdj - without).toBe(7200);
  });

  /**
   * If a large deduction pushed `credited` negative, the tray would show
   * "312 hours behind", which means nothing to anyone.
   */
  it('a negative credited is treated as 0, so the pace does not plunge', () => {
    const input = { ...BASE, workdaysElapsed: 10, creditedSec: -500 * 3600 };
    expect(paceSecOf(input)).toBe(-expectedSecOf(input));
  });

  it('doing nothing at the start of the month still gives pace 0: not "behind" on day one', () => {
    expect(paceSecOf({ ...BASE, workdaysElapsed: 0, creditedSec: 0 })).toBe(0);
  });

  it('with the whole month a holiday, any work is ahead, and never NaN', () => {
    const out = paceSecOf({
      ...BASE,
      expectedWorkdays: 0,
      workdaysElapsed: 0,
      creditedSec: 3600,
    });
    expect(out).toBe(3600);
  });
});
