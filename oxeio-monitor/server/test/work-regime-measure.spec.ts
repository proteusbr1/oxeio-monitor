import { describe, expect, it } from 'vitest';

import { measureOf } from '../src/calendar/work-regime';

describe('measureOf — how a policy counts hours', () => {
  it('no policy: active time, 15-minute gap', () => {
    expect(measureOf(null)).toEqual({ measure: 'active', presenceGapSec: 900 });
    expect(measureOf(undefined)).toEqual({
      measure: 'active',
      presenceGapSec: 900,
    });
  });

  it('a gap of 0 or null falls back to 15 minutes', () => {
    expect(
      measureOf({ hoursMeasure: 'presence', presenceGapMin: 0 }).presenceGapSec,
    ).toBe(900);
    expect(
      measureOf({ hoursMeasure: 'presence', presenceGapMin: null })
        .presenceGapSec,
    ).toBe(900);
  });

  it('presence with its own gap', () => {
    expect(measureOf({ hoursMeasure: 'presence', presenceGapMin: 20 })).toEqual(
      {
        measure: 'presence',
        presenceGapSec: 1200,
      },
    );
  });
});
