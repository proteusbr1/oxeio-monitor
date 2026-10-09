import { describe, expect, it } from 'vitest';

import {
  BREACH_LABEL,
  clockOf,
  signedDuration,
} from '../src/pages/schedule/schedule.format';

describe('schedule formatting', () => {
  it('minutes since midnight as a clock', () => {
    expect(clockOf(500)).toBe('08:20');
    expect(clockOf(1440)).toBe('24:00');
    expect(clockOf(null)).toBe('—');
  });
  it('a signed balance', () => {
    expect(signedDuration(70)).toBe('+1h10');
    expect(signedDuration(-12)).toBe('−12min');
    expect(signedDuration(0)).toBe('0');
    expect(signedDuration(-60)).toBe('−1h00');
  });
  it('every breach has a label', () => {
    expect(Object.keys(BREACH_LABEL).sort()).toEqual([
      'break_missing',
      'break_short',
      'early_leave',
      'late',
      'no_show',
    ]);
  });
});
