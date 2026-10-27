import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INGEST_LIMITS,
  MAX_BACKFILL_DAYS,
  outOfBounds,
  partitionByBounds,
} from '../src/agent/ingest-bounds';

/**
 * M1: with a device token from `enroll-login`, a staff member could post
 * `active` segments for any start and end and credit themselves back-dated
 * hours for the whole open month. These are the three bounds that stop it.
 *
 * Pure function, fixed instants: nothing here depends on the real clock.
 */
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const ENROLLED = new Date('2026-10-01T09:00:00.000Z');

const at = (ms: number) => new Date(NOW.getTime() + ms);
const span = (startMs: number, endMs: number) => ({
  startedAt: at(startMs),
  endedAt: at(endMs),
});

describe('outOfBounds', () => {
  it('a segment that closed a minute ago is fine', () => {
    expect(outOfBounds(span(-30 * MIN, -MIN), ENROLLED, NOW)).toBeNull();
  });

  it('the future: past the allowance is refused, within it is not', () => {
    expect(outOfBounds(span(-MIN, 4 * MIN), ENROLLED, NOW)).toBeNull();
    expect(outOfBounds(span(-MIN, 6 * MIN), ENROLLED, NOW)).toBe('future');
    // a whole afternoon credited in advance
    expect(outOfBounds(span(0, 5 * 3_600_000), ENROLLED, NOW)).toBe('future');
  });

  /** The bound that closes the hole: a new fake device claims nothing older */
  it('before enrolment: refused, with a small allowance', () => {
    const enrolled = at(-10 * MIN);
    expect(outOfBounds(span(-14 * MIN, -12 * MIN), enrolled, NOW)).toBeNull();
    expect(outOfBounds(span(-16 * MIN, -12 * MIN), enrolled, NOW)).toBe(
      'before_enrolment',
    );
    expect(outOfBounds(span(-3 * DAY, -3 * DAY + 3_600_000), enrolled, NOW)).toBe(
      'before_enrolment',
    );
  });

  /**
   * The agent keeps segments 30 days after they close, and one may be a day
   * long, so a 31-day-old start must still be taken from an honest PC.
   */
  it(`the backfill limit is ${MAX_BACKFILL_DAYS} days, above the agent's 30 + 1`, () => {
    const longAgo = new Date(NOW.getTime() - 90 * DAY);
    expect(outOfBounds(span(-31 * DAY, -30 * DAY), longAgo, NOW)).toBeNull();
    expect(outOfBounds(span(-33 * DAY, -33 * DAY + MIN), longAgo, NOW)).toBe('too_old');
  });

  it('an end before the start is judged by the start (the server zeroes it later)', () => {
    expect(outOfBounds(span(-MIN, -2 * MIN), ENROLLED, NOW)).toBeNull();
    expect(outOfBounds(span(10 * MIN, -2 * MIN), ENROLLED, NOW)).toBe('future');
  });

  it('the limits can be widened (the test config does, for work-noon fixtures)', () => {
    const wide = { ...DEFAULT_INGEST_LIMITS, futureSkewMs: DAY };
    expect(outOfBounds(span(0, 5 * 3_600_000), ENROLLED, NOW, wide)).toBeNull();
  });
});

describe('partitionByBounds', () => {
  it('keeps the good rows, counts the bad ones by reason, and keeps their range', () => {
    const rows = [
      span(-60 * MIN, -30 * MIN), // fine
      span(-30 * MIN, 2 * 3_600_000), // future
      span(-25 * DAY, -25 * DAY + MIN), // before enrolment (enrolled 19 days ago)
      span(-10 * MIN, -MIN), // fine
    ];

    const { kept, rejected } = partitionByBounds(rows, (r) => r, ENROLLED, NOW);

    expect(kept).toEqual([rows[0], rows[3]]);
    expect(rejected.total).toBe(2);
    expect(rejected.byReason).toEqual({ future: 1, before_enrolment: 1 });
    expect(rejected.earliest).toEqual(rows[2].startedAt);
    expect(rejected.latest).toEqual(rows[1].endedAt);
  });

  it('nothing dropped: an empty tally', () => {
    const { kept, rejected } = partitionByBounds(
      [span(-2 * MIN, -MIN)],
      (r) => r,
      ENROLLED,
      NOW,
    );
    expect(kept).toHaveLength(1);
    expect(rejected).toEqual({ total: 0, byReason: {}, earliest: null, latest: null });
  });
});
