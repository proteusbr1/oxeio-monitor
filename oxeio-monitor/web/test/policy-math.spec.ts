import { describe, expect, it } from 'vitest';

import {
  targetPreview,
  workdaysInMonth,
} from '../src/pages/settings/policy.math';

/**
 * The policy form's preview: what the numbers come to in a real month.
 * August 2026 starts on a Saturday (31 days); September 2026 on a Tuesday (30).
 */
describe('workdaysInMonth', () => {
  it('one day off a week (Fri) — 27 in August, 26 in September', () => {
    expect(workdaysInMonth('2026-08', [5])).toBe(27);
    expect(workdaysInMonth('2026-09', [5])).toBe(26);
  });

  it('Sat + Sun off — 21 in August, 22 in September', () => {
    expect(workdaysInMonth('2026-08', [6, 7])).toBe(21);
    expect(workdaysInMonth('2026-09', [6, 7])).toBe(22);
  });

  it('no days off — every day', () => {
    expect(workdaysInMonth('2026-02', [])).toBe(28);
  });
});

describe('targetPreview', () => {
  it('a six-day week of 26 days matches its calendar month', () => {
    const p = targetPreview({
      yearMonth: '2026-09',
      monthlyTargetHours: 208,
      expectedWorkdays: 26,
      offDays: [5],
    })!;
    expect(p).toEqual({
      workdays: 26,
      dailyHours: 8,
      monthHours: 208,
      mismatch: false,
    });
  });

  it('Sat + Sun with 26 expected workdays — the month would land at 176 h', () => {
    const p = targetPreview({
      yearMonth: '2026-09',
      monthlyTargetHours: 208,
      expectedWorkdays: 26,
      offDays: [6, 7],
    })!;
    expect(p.workdays).toBe(22);
    expect(p.monthHours).toBe(176);
    expect(p.mismatch).toBe(true);
  });

  it('nothing to show while the form is half filled', () => {
    expect(
      targetPreview({
        yearMonth: '2026-09',
        monthlyTargetHours: 0,
        expectedWorkdays: 26,
        offDays: [],
      }),
    ).toBeNull();
    expect(
      targetPreview({
        yearMonth: '2026-09',
        monthlyTargetHours: 208,
        expectedWorkdays: NaN,
        offDays: [],
      }),
    ).toBeNull();
  });
});
