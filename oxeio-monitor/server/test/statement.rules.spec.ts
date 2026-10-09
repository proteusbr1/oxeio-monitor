import { describe, expect, it } from 'vitest';

import {
  countDays,
  employedRange,
  hourlyInPeriod,
  monthsTouched,
} from '../src/hours-statement/statement.rules';

describe('monthsTouched', () => {
  it('the months a period crosses', () => {
    expect(monthsTouched({ start: '2026-09-26', end: '2026-10-25' })).toEqual([
      '2026-09',
      '2026-10',
    ]);
    expect(monthsTouched({ start: '2026-10-01', end: '2026-10-31' })).toEqual([
      '2026-10',
    ]);
  });
});

describe('hourlyInPeriod — from the pay terms history, basis only', () => {
  it('hourly now and no history', () => {
    expect(hourlyInPeriod(['2026-09', '2026-10'], 'hourly', [])).toBe(true);
  });
  it('monthly until September, hourly from October: in the 26/09–25/10 period', () => {
    expect(
      hourlyInPeriod(['2026-09', '2026-10'], 'hourly', [
        { throughMonth: '2026-09', payBasis: 'monthly' },
      ]),
    ).toBe(true);
  });
  it('hourly until August, monthly since: not in the September–October period', () => {
    expect(
      hourlyInPeriod(['2026-09', '2026-10'], 'monthly', [
        { throughMonth: '2026-08', payBasis: 'hourly' },
      ]),
    ).toBe(false);
  });
});

describe('employedRange', () => {
  const range = { start: '2026-09-26', end: '2026-10-25' };
  it('cut at joining and leaving', () => {
    expect(employedRange(range, '2026-10-01', null)).toEqual({
      start: '2026-10-01',
      end: '2026-10-25',
    });
    expect(employedRange(range, null, '2026-10-10')).toEqual({
      start: '2026-09-26',
      end: '2026-10-10',
    });
  });
  it('not employed in the period: null', () => {
    expect(employedRange(range, '2026-11-01', null)).toBeNull();
    expect(employedRange(range, null, '2026-09-20')).toBeNull();
  });
});

describe('countDays', () => {
  it('leave, holidays and workdays with nothing recorded; days off ignored', () => {
    // 2026-10-05 Mon … 2026-10-11 Sun; Sat+Sun off
    const counts = countDays({
      from: '2026-10-05',
      to: '2026-10-11',
      offDays: [6, 7],
      holidays: new Set(['2026-10-07']),
      leaves: new Set(['2026-10-08']),
      creditedByDate: new Map([
        ['2026-10-05', 28_800],
        ['2026-10-06', 0],
      ]),
    });
    // Mon worked; Tue 0 → no data; Wed holiday; Thu leave; Fri nothing → no data
    expect(counts).toEqual({ leaveDays: 1, holidayDays: 1, noDataDays: 2 });
  });
});
