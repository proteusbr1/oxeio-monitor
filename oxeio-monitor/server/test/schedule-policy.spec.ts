import { describe, expect, it } from 'vitest';

import {
  minuteOfWorkDay,
  schedulePolicyOf,
} from '../src/schedule/schedule-policy';

/** Tests run in the pinned zone Etc/GMT-6 (UTC+6, no daylight saving). */
const workDate = new Date('2026-10-05T00:00:00.000Z');

describe('minuteOfWorkDay', () => {
  it('local wall-clock minutes of an instant on that work day', () => {
    expect(minuteOfWorkDay(new Date('2026-10-05T02:30:00Z'), workDate)).toBe(
      8 * 60 + 30,
    );
  });
  it('the midnight cut that ends the day is 1440, not 0', () => {
    expect(minuteOfWorkDay(new Date('2026-10-05T18:00:00Z'), workDate)).toBe(
      1440,
    );
  });
  it('before the day: 0', () => {
    expect(minuteOfWorkDay(new Date('2026-10-04T17:00:00Z'), workDate)).toBe(0);
  });
});

describe('schedulePolicyOf', () => {
  const row = {
    scheduleEnforced: true,
    officeFrom: '08:00',
    officeTo: '17:00',
    breakMinutes: 60,
    breakWindowFrom: '11:00',
    breakWindowTo: '14:00',
    toleranceMarkMin: 5,
    toleranceDayMin: 10,
  };

  it('turns the row into minutes', () => {
    expect(schedulePolicyOf(row)).toEqual({
      startMin: 480,
      endMin: 1020,
      breakMin: 60,
      breakFromMin: 660,
      breakToMin: 840,
      toleranceMarkMin: 5,
      toleranceDayMin: 10,
    });
  });
  it('not enforced, or no office hours: null', () => {
    expect(schedulePolicyOf({ ...row, scheduleEnforced: false })).toBeNull();
    expect(schedulePolicyOf({ ...row, officeFrom: null })).toBeNull();
    expect(schedulePolicyOf(null)).toBeNull();
  });
  it('no window: the whole working day; no break minutes: 0', () => {
    expect(
      schedulePolicyOf({
        ...row,
        breakWindowFrom: null,
        breakWindowTo: null,
        breakMinutes: null,
      }),
    ).toMatchObject({ breakMin: 0, breakFromMin: 480, breakToMin: 1020 });
  });
});
