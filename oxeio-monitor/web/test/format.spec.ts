import { describe, expect, it } from 'vitest';

import {
  formatAgo,
  formatBytes,
  formatCount,
  formatDate,
  formatDateShort,
  formatDuration,
  formatHoursAsDuration,
  formatMonth,
  formatPct,
  formatSignedDuration,
  formatMoney,
  formatTime,
  isValidWorkDate,
  monthEndOf,
  parseWorkDate,
  pctOf,
  shiftMonth,
  shiftWorkDate,
  thisMonthRange,
  todayInWorkZone,
  weekdayOf,
  workDateOf,
} from '../src/lib/format';

/**
 * **The web app's first test file.**
 *
 * Careful: none of what is tested here is a question of "looks nice": each
 * is a mistake where a **wrong number** lands on screen and nobody catches
 * it because it looks right. If the work-zone date shifts by a day, a person who
 * works at night cannot find their hours; if the adjustment sign is lost,
 * add and subtract look the same.
 */

// ── work-zone dates ─────────────────────────────────────────────────────────────

describe('todayInWorkZone — the browser timezone is not assumed', () => {
  /**
   * The most important test in this file. Between midnight and 6 am in Dhaka,
   * UTC is still on the **previous day**. Writing `toISOString().slice(0,10)`
   * would make someone working then unable to find today's hours at all, yet
   * working at night is normal in this system (§ 2.1a).
   */
  it('2 am in Dhaka = new day, even though it is still the previous day in UTC', () => {
    const utc = new Date('2026-08-11T20:00:00Z'); // 2 am on 12 August in Dhaka
    expect(utc.toISOString().slice(0, 10)).toBe('2026-08-11');
    expect(todayInWorkZone(utc)).toBe('2026-08-12');
  });

  it('11:59 pm in Dhaka is still the same day', () =>
    expect(todayInWorkZone(new Date('2026-08-12T17:59:00Z'))).toBe('2026-08-12'));

  it('workDateOf takes both an ISO string and a Date', () => {
    expect(workDateOf('2026-08-11T20:30:00Z')).toBe('2026-08-12');
    expect(workDateOf(new Date('2026-08-11T20:30:00Z'))).toBe('2026-08-12');
  });
});

describe('parseWorkDate — an impossible date is not silently changed', () => {
  /**
   * Careful: `new Date('2026-02-31')` silently becomes 3 March. If it is not
   * checked on the way back, the user would see the wrong day's data without knowing.
   */
  it('31 February is null', () => expect(parseWorkDate('2026-02-31')).toBeNull());
  it('month 13 is null', () => expect(parseWorkDate('2026-13-01')).toBeNull());
  it('null when the format does not match', () => expect(parseWorkDate('11/08/2026')).toBeNull());
  it('a valid date passes', () => expect(isValidWorkDate('2026-02-28')).toBe(true));
  it('29 February of a leap year passes', () =>
    expect(isValidWorkDate('2028-02-29')).toBe(true));
  it('29 February of a non-leap year does not', () =>
    expect(isValidWorkDate('2026-02-29')).toBe(false));
});

describe('shifting dates', () => {
  it('crosses the month boundary', () =>
    expect(shiftWorkDate('2026-08-01', -1)).toBe('2026-07-31'));

  it('on a bad date, what was given comes back', () =>
    expect(shiftWorkDate('গতকাল', -1)).toBe('গতকাল'));

  it('last day of the month: leap years work out by themselves', () => {
    expect(monthEndOf('2026-02')).toBe('2026-02-28');
    expect(monthEndOf('2028-02-10')).toBe('2028-02-29');
  });

  it('crosses the year boundary, the month moves', () =>
    expect(shiftMonth('2026-01', -1)).toBe('2025-12'));

  it('the current month range is based on today in the work zone', () => {
    const range = thisMonthRange(new Date('2026-08-11T20:00:00Z'));
    expect(range).toEqual({ from: '2026-08-01', to: '2026-08-12' });
  });
});

describe('showing dates', () => {
  it('full date', () => expect(formatDate('2026-08-10')).toBe('10 August 2026'));
  it('in a narrow column', () => expect(formatDateShort('2026-10-05')).toBe('5 Oct'));
  it('weekday', () => expect(weekdayOf('2026-08-10')).toBe('Mon'));
  it('month', () => expect(formatMonth('2026-08')).toBe('August 2026'));

  /** Careful: on bad input it gives back what came in, not blank; otherwise the cell would silently be empty */
  it('a bad date gives back what came in', () =>
    expect(formatDate('not-a-date')).toBe('not-a-date'));

  it('a bad month gives back what came in', () =>
    expect(formatMonth('2026-99')).toBe('2026-99'));

  /** Careful: time on the work-zone clock, not the user's timezone */
  it('time on the work-zone clock', () =>
    expect(formatTime('2026-08-11T08:32:00Z')).toBe('14:32'));

  it('dash when there is no time', () => expect(formatTime(null)).toBe('—'));
  it('dash on a broken ISO', () => expect(formatTime('আজ দুপুর')).toBe('—'));
});

describe('formatAgo — singular/plural', () => {
  const now = new Date('2026-08-12T10:00:00Z');
  const ago = (sec: number) =>
    formatAgo(new Date(now.getTime() - sec * 1000).toISOString(), now);

  it('just now', () => expect(ago(10)).toBe('Just now'));
  /** Careful: "1 minutes ago" sounds mechanical and lowers trust in the number */
  it('one minute: singular', () => expect(ago(60)).toBe('1 minute ago'));
  it('two minutes: plural', () => expect(ago(120)).toBe('2 minutes ago'));
  it('one hour', () => expect(ago(3600)).toBe('1 hour ago'));
  it('two days', () => expect(ago(2 * 86400)).toBe('2 days ago'));

  /** Careful: with clock skew a negative number would make the system look broken */
  it('never negative even for a future time', () =>
    expect(formatAgo(new Date(now.getTime() + 60_000).toISOString(), now)).toBe(
      'Just now',
    ));

  it('Never when it never came', () => expect(formatAgo(null)).toBe('Never'));
});

// ── Durations ───────────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('hours and minutes', () => expect(formatDuration(7 * 3600 + 32 * 60)).toBe('7h 32m'));
  it('under one hour: minutes only', () => expect(formatDuration(32 * 60)).toBe('32m'));

  /** Careful: seeing an empty cell you cannot tell "no data" from truly zero */
  it('zero means 0m, not blank', () => expect(formatDuration(0)).toBe('0m'));
  it('dash when there is no data', () => expect(formatDuration(null)).toBe('—'));
  it('dash on NaN', () => expect(formatDuration(Number.NaN)).toBe('—'));

  /**
   * After rounding, the minutes can become 60. Without carrying into the hour
   * the screen would show `0h 60m`: not wrong, but nobody would trust that number.
   */
  it('3598 seconds → 1h 0m, not "0h 60m"', () =>
    expect(formatDuration(3598)).toBe('1h 0m'));

  it('negative time is clamped to 0', () => expect(formatDuration(-500)).toBe('0m'));
});

describe('formatSignedDuration — the sign is the real information', () => {
  it('a positive value also carries a sign', () =>
    expect(formatSignedDuration(2 * 3600)).toBe('+2:00'));

  /** Careful: the Unicode minus (U+2212), not a hyphen */
  it('a negative value uses the Unicode minus', () => {
    const text = formatSignedDuration(-30 * 60);
    expect(text).toBe('−0:30');
    expect(text.charCodeAt(0)).toBe(0x2212);
  });

  it('the hour stays even when under one hour', () =>
    expect(formatSignedDuration(30 * 60)).toBe('+0:30'));

  it('zero is treated as positive', () => expect(formatSignedDuration(0)).toBe('+0:00'));

  /** Careful: the `formatDuration()` trap is here too; caught by the first test after the move */
  it('3598 seconds → +1:00, not "+0:60"', () =>
    expect(formatSignedDuration(3598)).toBe('+1:00'));

  it('the same in the negative direction', () =>
    expect(formatSignedDuration(-3598)).toBe('−1:00'));
});

describe('formatHoursAsDuration — the two API formats on one screen', () => {
  it('number', () => expect(formatHoursAsDuration(7.53)).toBe('7h 32m'));
  /** Careful: payroll sends hours as a **string** (Decimal) */
  it('string', () => expect(formatHoursAsDuration('7.53')).toBe('7h 32m'));
  it('dash on null', () => expect(formatHoursAsDuration(null)).toBe('—'));
  it('dash on a junk string', () => expect(formatHoursAsDuration('অনেক')).toBe('—'));
});

// ── Percent, bytes, money ───────────────────────────────────────────────────

describe('formatPct — null means no data, not zero', () => {
  /**
   * Writing `0%` would say "was not productive at all", when the truth is
   * "nothing to say": on a day off the difference changes the whole report.
   */
  it('dash on null', () => expect(formatPct(null)).toBe('—'));
  it('0% on zero', () => expect(formatPct(0)).toBe('0%'));
  it('decimal places', () => expect(formatPct(72.456, 1)).toBe('72.5%'));

  it('0 when the denominator is zero, not NaN', () => expect(pctOf(5, 0)).toBe(0));
  it('ordinary percentage', () => expect(pctOf(1, 4)).toBe(25));
});

describe('formatBytes', () => {
  it('under 1 KiB', () => expect(formatBytes(900)).toBe('900 B'));
  it('KB', () => expect(formatBytes(2048)).toBe('2.0 KB'));
  it('no decimals when large', () => expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB'));
  it('dash on null', () => expect(formatBytes(null)).toBe('—'));
});

describe('formatMoney — not converted to a number', () => {
  /**
   * Careful: the server sends money as a **string** (Decimal). Computing with
   * `Number()` would turn 13000.10 into 13000.0999… on screen.
   */
  it('thousands comma', () => expect(formatMoney('13000.50')).toBe('$ 13,000.50'));
  it('the decimal places stay exactly', () =>
    expect(formatMoney('13000.10')).toBe('$ 13,000.10'));
  it('no decimals are added when there are none', () =>
    expect(formatMoney('900')).toBe('$ 900'));
  it('negative', () => expect(formatMoney('-1500')).toBe('$ -1,500'));
  it('seven digits', () => expect(formatMoney('1234567')).toBe('$ 1,234,567'));
  it('dash on null', () => expect(formatMoney(null)).toBe('—'));
});

describe('formatCount', () => {
  it('thousands comma', () => expect(formatCount(12345)).toBe('12,345'));
  it('dash on null', () => expect(formatCount(null)).toBe('—'));
});
