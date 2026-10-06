import { describe, expect, it } from 'vitest';

import { parseCalendarDate } from '../src/calendar/calendar-date';

describe('parseCalendarDate — a calendar date, not an instant', () => {
  /**
   * A `@db.Date` column wants UTC midnight. Even an hour either way and
   * Postgres could shift the date by one day.
   */
  it('returns UTC midnight', () => {
    const d = parseCalendarDate('2026-08-10');

    expect(d?.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  /**
   * The real trap: `new Date('2026-08-10T00:00:00')` (no trailing `Z`) is read
   * in the server's local time. If the server is in Dhaka that is 18:00 of the
   * previous day in UTC, so the holiday calendar would silently shift a day back.
   */
  it('does not slip in a local timezone', () => {
    const d = parseCalendarDate('2026-01-01');

    expect(d?.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(d?.getUTCHours()).toBe(0);
  });

  /**
   * JS silently turns `2026-02-31` into 3 March. Without checking back, the
   * holiday calendar would get a date nobody wrote.
   */
  it('rejects a non-existent date instead of quietly shifting it', () => {
    expect(parseCalendarDate('2026-02-31')).toBeNull();
    expect(parseCalendarDate('2025-02-29')).toBeNull();
    expect(parseCalendarDate('2026-13-01')).toBeNull();
  });

  it('accepts 29 February of a leap year', () => {
    expect(parseCalendarDate('2028-02-29')?.toISOString().slice(0, 10)).toBe(
      '2028-02-29',
    );
  });

  it('returns null when the format is wrong', () => {
    for (const bad of ['2026-8-10', '10-08-2026', '2026/08/10', '', 'today']) {
      expect(parseCalendarDate(bad)).toBeNull();
    }
  });

  /** Adding a time means it is no longer a calendar date, so reject it */
  it('rejects a string with a time', () => {
    expect(parseCalendarDate('2026-08-10T06:00:00Z')).toBeNull();
  });
});
