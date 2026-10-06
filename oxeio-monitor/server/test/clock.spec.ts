import { describe, expect, it } from 'vitest';

import { workNoon, workTodayIso } from './setup/clock';
import { workDateOf } from '../src/agent/util/work-time';

/**
 * Guards the helper that every fixture now stands on.
 *
 * If `workNoon()` were wrong, nothing would throw; fixtures would just drift
 * back near a day boundary and tests would break silently a few times a year.
 * That exact failure happened three times (G62, adjustments, agent-recovery),
 * and each time it was caught only by coincidence, because CI happened to run
 * at that hour.
 *
 * These tests remove the coincidence: the assertions do not depend on the
 * time, so they give the same answer whenever they run.
 */
describe('workNoon — a safe instant for fixtures', () => {
  it('Dhaka noon is 06:00 UTC', () => {
    expect(workNoon().toISOString().slice(11)).toBe('06:00:00.000Z');
  });

  it('falls on the current work day, same as the server "today"', () => {
    expect(workDateOf(workNoon()).getTime()).toBe(
      workDateOf(new Date()).getTime(),
    );
  });

  /**
   * The most important assertion in this file. The whole point of noon is
   * that it is far from both day boundaries; if someone changed
   * `+ 6 * 3_600_000` to `+ 1 * 3_600_000`, every other test would stay green
   * and the time-of-day flakiness would come back.
   */
  it('at least 11 hours away from both local midnights', () => {
    const noon = workNoon();
    /**
     * Careful: `workDateOf()` returns the work day as a UTC-midnight label
     * (`2026-09-05T00:00:00Z` = the work day of 5 September). The real local
     * midnight instant is six hours earlier. Treating label and instant as the
     * same thing broke this test once; `todayWindow()` subtracts
     * `6 * 3_600_000` for the same reason.
     */
    const midnight = workDateOf(noon).getTime() - 6 * 3_600_000;
    const sinceMidnight = noon.getTime() - midnight;
    const untilNextMidnight = midnight + 86_400_000 - noon.getTime();

    expect(sinceMidnight).toBeGreaterThan(11 * 3_600_000);
    expect(untilNextMidnight).toBeGreaterThan(11 * 3_600_000);
  });

  it('dayOffset moves by exactly 24 hours and stays at noon', () => {
    for (const d of [-3, -1, 1, 3]) {
      expect(workNoon(d).getTime() - workNoon().getTime()).toBe(
        d * 86_400_000,
      );
      expect(workNoon(d).toISOString().slice(11)).toBe('06:00:00.000Z');
    }
  });

  it('workTodayIso() reports exactly that day', () => {
    expect(workTodayIso()).toBe(workNoon().toISOString().slice(0, 10));
  });

  /**
   * Dhaka is UTC+6, so the old UTC-based formula returned the previous day
   * between 00:00 and 06:00 Dhaka time. That six-hour window every day was
   * the original bug.
   */
  it('Dhaka date, not the UTC date', () => {
    const utcDate = new Date().toISOString().slice(0, 10);
    const workDate = workTodayIso();
    const hourUtc = new Date().getUTCHours();
    if (hourUtc >= 18) expect(workDate).not.toBe(utcDate);
    else expect(workDate).toBe(utcDate);
  });
});
