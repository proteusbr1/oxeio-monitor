import { describe, expect, it } from 'vitest';

import {
  effectiveDepositStart,
  checkNotice,
  daysBetween,
  isYearMonth,
  monthsBetween,
  nextMonth,
} from '../src/deposits/deposit.math';

/**
 * R21 — the pure deposit calculations. No database needed, so these are the
 * first line of defence.
 */

describe('month arithmetic', () => {
  it('next month — correct across a year boundary too', () => {
    expect(nextMonth('2026-08')).toBe('2026-09');
    expect(nextMonth('2026-11')).toBe('2026-12');
    // December goes to January of the next year, not '2026-13'
    expect(nextMonth('2026-12')).toBe('2027-01');
  });

  it('every month, both ends included', () => {
    expect(monthsBetween('2026-08', '2026-08')).toEqual(['2026-08']);
    expect(monthsBetween('2026-08', '2026-11')).toEqual([
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
  });

  it('order stays correct across a year boundary', () => {
    expect(monthsBetween('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });

  it('start after end gives an empty list — it does not throw', () => {
    // This can legitimately happen when staff join after the rule's start month
    expect(monthsBetween('2026-09', '2026-08')).toEqual([]);
  });

  it('a bad format is not silently accepted', () => {
    expect(() => monthsBetween('2026-8', '2026-09')).toThrow(RangeError);
    expect(() => monthsBetween('2026-13', '2027-01')).toThrow(RangeError);
    expect(isYearMonth('2026-00')).toBe(false);
    expect(isYearMonth('2026-12')).toBe(true);
  });

  it('an unusually long range is stopped', () => {
    // More than 50 years — bad input, so the loop is not allowed to run
    expect(() => monthsBetween('2026-01', '2126-01')).toThrow(RangeError);
  });
});

describe('notice arithmetic', () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it('the last day counts too', () => {
    // Notice given 31 July with last day 30 August = 30 days. That is what
    // people mean by "30 days' notice", and a one-day error would hold back the money.
    expect(daysBetween(d('2026-07-31'), d('2026-08-30'))).toBe(30);
  });

  it('exactly 30 days meets the rule', () => {
    const check = checkNotice(d('2026-07-31'), d('2026-08-30'), 30);
    expect(check.daysGiven).toBe(30);
    expect(check.meetsRule).toBe(true);
  });

  it('29 days does not meet it', () => {
    const check = checkNotice(d('2026-08-01'), d('2026-08-30'), 30);
    expect(check.daysGiven).toBe(29);
    expect(check.meetsRule).toBe(false);
  });

  it('an unknown date means "no" — "don\'t know" is not treated as "yes"', () => {
    expect(checkNotice(null, d('2026-08-30'), 30)).toEqual({
      daysGiven: null,
      daysRule: 30,
      meetsRule: false,
    });
    expect(checkNotice(d('2026-07-01'), null, 30).meetsRule).toBe(false);
  });

  it('when the rule is 0 days, any notice is enough', () => {
    // Sounds odd but is valid — relaxing the rule should not need a code change
    expect(checkNotice(d('2026-08-29'), d('2026-08-30'), 0).meetsRule).toBe(true);
  });

  it('a last day before the notice date is negative — and does not meet the rule', () => {
    const check = checkNotice(d('2026-09-10'), d('2026-08-30'), 30);
    expect(check.daysGiven).toBe(-11);
    expect(check.meetsRule).toBe(false);
  });
});

/**
 * Which month this staff member's deposit starts from — one single definition.
 *
 * The rule used to be written in two places: once when filling the ledger and
 * once when displaying on screen. If the two drifted apart, the screen would
 * show one month while the ledger used another, and since both looked
 * "correct" nobody would notice the difference. These tests guard that they
 * stay the same.
 */
describe('effectiveDepositStart', () => {
  const policyStart = '2026-01';

  it('the rule\'s month when nothing else is set', () => {
    expect(
      effectiveDepositStart({ override: null, joinedMonth: null, policyStart }),
    ).toBe('2026-01');
  });

  it('the joining month when they joined later', () => {
    expect(
      effectiveDepositStart({ override: null, joinedMonth: '2026-04', policyStart }),
    ).toBe('2026-04');
  });

  /** If they joined before the rule started, it is the rule's month — nothing was due before that */
  it('the rule\'s month even if they joined earlier', () => {
    expect(
      effectiveDepositStart({ override: null, joinedMonth: '2025-03', policyStart }),
    ).toBe('2026-01');
  });

  /**
   * The month chosen by the owner beats even the joining date. `joined_on` is
   * often a guess or empty; the owner sets this field personally, so if a
   * guess beat a statement, a correction would change nothing.
   */
  it('override beats everything', () => {
    expect(
      effectiveDepositStart({
        override: '2026-03',
        joinedMonth: '2026-07',
        policyStart,
      }),
    ).toBe('2026-03');
  });

  it('override may be earlier than the rule', () => {
    expect(
      effectiveDepositStart({ override: '2025-11', joinedMonth: null, policyStart }),
    ).toBe('2025-11');
  });
});
