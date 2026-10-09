import { describe, expect, it } from 'vitest';

import {
  addDays,
  cutoffOnOrAfter,
  isDue,
  payPeriodProblem,
  periodAfter,
  periodHolding,
  resolvePayPeriod,
} from '../src/hours-statement/pay-period.rules';

describe('resolvePayPeriod', () => {
  it('defaults: calendar month, 07:00', () => {
    expect(resolvePayPeriod(null)).toEqual({
      cutoffDay: 'end',
      sendTime: '07:00',
    });
  });
  it('keeps valid saved values, drops broken ones', () => {
    expect(resolvePayPeriod({ cutoffDay: 25, sendTime: '06:30' })).toEqual({
      cutoffDay: 25,
      sendTime: '06:30',
    });
    expect(
      resolvePayPeriod({ cutoffDay: 31 as number, sendTime: '7h' }),
    ).toEqual({ cutoffDay: 'end', sendTime: '07:00' });
  });
});

describe('payPeriodProblem', () => {
  it('cutoff 1–28 or end; time HH:MM', () => {
    expect(payPeriodProblem({ cutoffDay: 25, sendTime: '07:00' })).toBeNull();
    expect(
      payPeriodProblem({ cutoffDay: 'end', sendTime: '23:59' }),
    ).toBeNull();
    expect(payPeriodProblem({ cutoffDay: 29, sendTime: '07:00' })).toMatch(
      /28/,
    );
    expect(payPeriodProblem({ cutoffDay: 0, sendTime: '07:00' })).toMatch(/28/);
    expect(payPeriodProblem({ cutoffDay: 25, sendTime: '24:00' })).toMatch(
      /HH:MM/,
    );
  });
});

describe('dates', () => {
  it('addDays crosses months and years', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('cutoffOnOrAfter', () => {
    expect(cutoffOnOrAfter('2026-10-09', 25)).toBe('2026-10-25');
    expect(cutoffOnOrAfter('2026-10-25', 25)).toBe('2026-10-25');
    expect(cutoffOnOrAfter('2026-10-26', 25)).toBe('2026-11-25');
    expect(cutoffOnOrAfter('2026-12-26', 25)).toBe('2027-01-25');
    expect(cutoffOnOrAfter('2028-02-10', 'end')).toBe('2028-02-29');
  });
});

describe('periods', () => {
  it('the period holding a day, cutoff 25', () => {
    expect(periodHolding('2026-10-09', 25)).toEqual({
      start: '2026-09-26',
      end: '2026-10-25',
    });
    expect(periodHolding('2026-10-26', 25)).toEqual({
      start: '2026-10-26',
      end: '2026-11-25',
    });
    expect(periodHolding('2026-01-10', 25)).toEqual({
      start: '2025-12-26',
      end: '2026-01-25',
    });
  });
  it('end of month is the calendar month', () => {
    expect(periodHolding('2026-02-10', 'end')).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
  });
  it('the next period starts the day after, even when the cutoff changed', () => {
    expect(periodAfter('2026-10-25', 25)).toEqual({
      start: '2026-10-26',
      end: '2026-11-25',
    });
    expect(periodAfter('2026-10-25', 'end')).toEqual({
      start: '2026-10-26',
      end: '2026-10-31',
    });
    expect(periodAfter('2026-10-31', 25)).toEqual({
      start: '2026-11-01',
      end: '2026-11-25',
    });
  });
});

describe('isDue — the day after the end, at the send time', () => {
  const end = '2026-10-25';
  it('not on the last day, not before the time', () => {
    expect(isDue(end, '2026-10-25', 23 * 60, '07:00')).toBe(false);
    expect(isDue(end, '2026-10-26', 6 * 60 + 59, '07:00')).toBe(false);
  });
  it('from the time on, and any later day (server was down)', () => {
    expect(isDue(end, '2026-10-26', 7 * 60, '07:00')).toBe(true);
    expect(isDue(end, '2026-10-26', 15 * 60 + 10, '07:00')).toBe(true);
    expect(isDue(end, '2026-11-02', 0, '07:00')).toBe(true);
  });
});
