import { describe, expect, it } from 'vitest';

import { measureOf, sameMeasure } from '../src/calendar/work-regime';

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

describe('sameMeasure — whether two policies count the same hours', () => {
  const active = { hoursMeasure: 'active' as const, presenceGapMin: 15 };
  const presence = { hoursMeasure: 'presence' as const, presenceGapMin: 15 };

  it('active and active, whatever the gap', () => {
    expect(sameMeasure(active, { ...active, presenceGapMin: 30 })).toBe(true);
  });

  it('no policy counts active time', () => {
    expect(sameMeasure(null, active)).toBe(true);
    expect(sameMeasure(null, presence)).toBe(false);
  });

  it('active and presence differ', () => {
    expect(sameMeasure(active, presence)).toBe(false);
  });

  it('presence and presence: the gap decides', () => {
    expect(sameMeasure(presence, { ...presence })).toBe(true);
    expect(sameMeasure(presence, { ...presence, presenceGapMin: 30 })).toBe(
      false,
    );
  });
});
