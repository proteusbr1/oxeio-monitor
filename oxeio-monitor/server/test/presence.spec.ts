import { describe, expect, it } from 'vitest';

import {
  presenceSpans,
  summarizeDay,
  type DaySegment,
} from '../src/summary/summary.math';

const at = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00.000Z`);
const span = (from: string, to: string) => ({
  startedAt: at(from),
  endedAt: at(to),
});
const active = (from: string, to: string): DaySegment => ({
  ...span(from, to),
  state: 'active',
  durationSec: (at(to).getTime() - at(from).getTime()) / 1000,
});
const idle = (from: string, to: string): DaySegment => ({
  ...active(from, to),
  state: 'idle',
});

const MIN = 60;

describe('presenceSpans — active stretches joined across short pauses', () => {
  it('joins pauses up to the threshold, splits at longer ones', () => {
    const blocks = presenceSpans(
      [span('08:00', '09:00'), span('09:05', '12:00'), span('13:10', '17:00')],
      15 * MIN,
    );
    expect(blocks).toEqual([span('08:00', '12:00'), span('13:10', '17:00')]);
  });

  it('a pause exactly as long as the threshold is joined', () => {
    expect(
      presenceSpans([span('08:00', '09:00'), span('09:15', '10:00')], 15 * MIN),
    ).toEqual([span('08:00', '10:00')]);
  });

  it('one minute longer is not', () => {
    expect(
      presenceSpans([span('08:00', '09:00'), span('09:16', '10:00')], 15 * MIN),
    ).toHaveLength(2);
  });

  it('two devices: overlapping time counts once; one covers the other’s pause', () => {
    const blocks = presenceSpans(
      [span('08:00', '10:00'), span('09:30', '11:00'), span('10:00', '12:00')],
      0,
    );
    expect(blocks).toEqual([span('08:00', '12:00')]);
  });

  it('a single stretch: presence is that stretch', () => {
    expect(presenceSpans([span('08:00', '09:30')], 15 * MIN)).toEqual([
      span('08:00', '09:30'),
    ]);
  });

  it('unordered input, no input', () => {
    expect(
      presenceSpans([span('13:00', '14:00'), span('08:00', '09:00')], 15 * MIN),
    ).toEqual([span('08:00', '09:00'), span('13:00', '14:00')]);
    expect(presenceSpans([], 15 * MIN)).toEqual([]);
  });
});

describe('summarizeDay — the policy chooses the measure', () => {
  const segments = [
    active('08:00', '09:00'),
    idle('09:00', '09:10'),
    active('09:10', '12:00'),
    idle('12:00', '13:00'),
    active('13:00', '17:00'),
  ];
  const base = {
    segments,
    screenshotCount: 0,
    adjustmentSec: 600,
    productiveSpans: [],
    unproductiveSpans: [],
    isOffDay: false,
  };

  it('active (the default): credited = worked + adjustment, presence still stored', () => {
    const day = summarizeDay(base);
    expect(day.workedSec).toBe((60 + 170 + 240) * MIN);
    expect(day.presenceSec).toBe((240 + 240) * MIN); // 08:00–12:00 joined, 13:00–17:00
    expect(day.creditedSec).toBe(day.workedSec + 600);
  });

  it('presence: credited = presence + adjustment', () => {
    const day = summarizeDay({
      ...base,
      measure: 'presence',
      presenceGapSec: 15 * MIN,
    });
    expect(day.creditedSec).toBe((240 + 240) * MIN + 600);
  });

  it('presence with a threshold that bridges lunch', () => {
    const day = summarizeDay({
      ...base,
      measure: 'presence',
      presenceGapSec: 60 * MIN,
    });
    expect(day.presenceSec).toBe(9 * 60 * MIN);
  });

  it('no activity: presence 0', () => {
    expect(
      summarizeDay({ ...base, segments: [], measure: 'presence' }).presenceSec,
    ).toBe(0);
  });
});
