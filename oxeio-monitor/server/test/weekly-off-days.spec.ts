import { describe, expect, it } from 'vitest';

import { isOfficeOpen } from '../src/alerts/alerts.rules';
import {
  isWorkday as isReportWorkday,
  weekStartIsoDay,
} from '../src/reports/reports.range';
import { prorate } from '../src/summary/proration';
import { countWorkdays } from '../src/summary/summary.math';
import { isOffWeekday, normaliseOffDays } from '../src/summary/weekly-off';

/**
 * Several weekly days off per policy.
 *
 * Bangladesh keeps one (Friday, `[5]`) and every number stays as it was —
 * the existing suites prove that with their fixtures moved from `5` to `[5]`.
 * These cases add the two-day weeks most other countries use: Sat + Sun and
 * Fri + Sat, on a 31-day month (August 2026, starts on a Saturday) and a
 * 30-day month (September 2026, starts on a Tuesday).
 */

const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const NONE = new Set<number>();

const AUG = [d('2026-08-01'), d('2026-08-31')] as const;
const SEPT = [d('2026-09-01'), d('2026-09-30')] as const;

const FRI = [5];
const SAT_SUN = [6, 7];
const FRI_SAT = [5, 6];

describe('countWorkdays with a list of days off', () => {
  it('Friday only — unchanged: 27 in August, 26 in September', () => {
    expect(countWorkdays(...AUG, FRI, NONE)).toBe(27);
    expect(countWorkdays(...SEPT, FRI, NONE)).toBe(26);
  });

  it('Sat + Sun — 21 in August (5 Sat, 5 Sun), 22 in September', () => {
    expect(countWorkdays(...AUG, SAT_SUN, NONE)).toBe(21);
    expect(countWorkdays(...SEPT, SAT_SUN, NONE)).toBe(22);
  });

  it('Fri + Sat — 22 in August, 22 in September', () => {
    expect(countWorkdays(...AUG, FRI_SAT, NONE)).toBe(22);
    expect(countWorkdays(...SEPT, FRI_SAT, NONE)).toBe(22);
  });

  it('no days off — every calendar day', () => {
    expect(countWorkdays(...AUG, [], NONE)).toBe(31);
  });

  it('a holiday on a day off is not taken off twice', () => {
    const sunday = new Set([d('2026-08-02').getTime()]);
    expect(countWorkdays(...AUG, SAT_SUN, sunday)).toBe(21);
  });

  it('reports.range agrees with summary.math', () => {
    for (let t = AUG[0].getTime(); t <= AUG[1].getTime(); t += 86_400_000) {
      const day = new Date(t);
      const viaReports = isReportWorkday(day, {
        weeklyOffDays: SAT_SUN,
        holidays: NONE,
      });
      const isoDay = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
      expect(viaReports).toBe(!isOffWeekday(isoDay, SAT_SUN));
    }
  });
});

describe('proration with two days off', () => {
  const base = {
    monthStart: SEPT[0],
    monthEnd: SEPT[1],
    joinedOn: null,
    leftOn: null,
    holidays: NONE,
    // a 22-day month at 8 h: what a Sat+Sun policy would be set to
    monthlyTargetSec: 176 * 3600,
    policyWorkdays: 22,
  };

  it('full month — target is the policy target', () => {
    const r = prorate({ ...base, weeklyOffDays: SAT_SUN });
    expect(r.monthWorkdays).toBe(22);
    expect(r.targetSec).toBe(176 * 3600);
  });

  it('joins on Mon 14 Sept — 13 workdays left, weekends not counted', () => {
    const r = prorate({
      ...base,
      weeklyOffDays: SAT_SUN,
      joinedOn: d('2026-09-14'),
    });
    expect(r.employeeWorkdays).toBe(13);
    expect(r.targetSec).toBe(13 * 8 * 3600);
  });
});

describe('weekStartIsoDay — the week starts after the days off', () => {
  it('Friday off → Saturday, as before', () =>
    expect(weekStartIsoDay([5])).toBe(6));
  it('Sunday off → Monday, as before', () =>
    expect(weekStartIsoDay([7])).toBe(1));
  it('none → Monday, as before', () => expect(weekStartIsoDay([])).toBe(1));
  it('Sat + Sun → Monday', () => expect(weekStartIsoDay([6, 7])).toBe(1));
  it('Fri + Sat → Sunday', () => expect(weekStartIsoDay([5, 6])).toBe(7));
  it('order does not matter', () => expect(weekStartIsoDay([7, 6])).toBe(1));
  it('apart (Wed + Sun) → the day after the longest block, Monday first', () =>
    expect(weekStartIsoDay([3, 7])).toBe(1));
});

describe('alerts follow every day off', () => {
  const office = {
    officeFrom: '09:00',
    officeTo: '18:00',
    weeklyOffDays: SAT_SUN,
    isHoliday: false,
  };
  // 12:00 Dhaka = 06:00 UTC
  const noon = (iso: string): Date => new Date(`${iso}T06:00:00Z`);

  it('closed on Saturday and on Sunday, open on Monday', () => {
    expect(isOfficeOpen({ ...office, now: noon('2026-08-08') })).toBe(false);
    expect(isOfficeOpen({ ...office, now: noon('2026-08-09') })).toBe(false);
    expect(isOfficeOpen({ ...office, now: noon('2026-08-10') })).toBe(true);
  });
});

describe('normaliseOffDays', () => {
  it('sorts, removes duplicates and anything that is not an ISO day', () => {
    expect(normaliseOffDays([7, 6, 6, 0, 8, 2.5])).toEqual([6, 7]);
  });
});
