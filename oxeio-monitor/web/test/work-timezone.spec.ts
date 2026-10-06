import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  workHourNow,
  formatDateTime,
  formatTime,
  setWorkTimeZone,
  thisMonthRange,
  todayInWorkZone,
  shiftWorkDate,
  startOfWorkDate,
  workDateOf,
  workTimeZone,
  workTimeZoneLabel,
  workWallOf,
} from '../src/lib/format';
import { TEST_WORK_ZONE } from './setup';

/**
 * The work-day zone comes from the server (`GET /auth/time-zone`, called in
 * `main.tsx` before the first render). These tests check that:
 *  1. without that answer the zone is UTC (the server's own default); the
 *     tests themselves run pinned to UTC+6 (`test/setup.ts`), which is how
 *     `format.spec.ts` runs;
 *  2. a negative offset (America/Sao_Paulo, UTC−3) cuts days at its own
 *     midnight, across month and year boundaries;
 *  3. daylight saving (Europe/Lisbon) uses the offset in force at each
 *     instant, the same answers the server's own tests check.
 */

const SAO_PAULO = { timeZone: 'America/Sao_Paulo', utcOffsetMinutes: -180 };
const LISBON = { timeZone: 'Europe/Lisbon', utcOffsetMinutes: 60 };
const hoursOf = (date: string): number =>
  (startOfWorkDate(shiftWorkDate(date, 1)).getTime() - startOfWorkDate(date).getTime()) / 3_600_000;

afterEach(() => setWorkTimeZone(TEST_WORK_ZONE));

describe('product default — UTC', () => {
  it('a fresh module starts on UTC, +0 h', async () => {
    vi.resetModules();
    const fresh = await import('../src/lib/format');
    expect(fresh.workTimeZone()).toBe('UTC');
    expect(fresh.workTimeZoneLabel()).toBe('UTC');
    expect(fresh.startOfWorkDate('2026-08-11').toISOString()).toBe('2026-08-11T00:00:00.000Z');
    expect(fresh.todayInWorkZone(new Date('2026-08-11T23:59:00Z'))).toBe('2026-08-11');
  });
});

describe('the test zone — Etc/GMT-6 (UTC+6)', () => {
  it('is GMT-6, +6 h', () => {
    expect(workTimeZone()).toBe('Etc/GMT-6');
    expect(workTimeZoneLabel()).toBe('GMT-6');
    expect(workWallOf(new Date('2026-08-11T00:00:00Z')).toISOString()).toBe('2026-08-11T06:00:00.000Z');
    expect(startOfWorkDate('2026-08-11').toISOString()).toBe('2026-08-10T18:00:00.000Z');
  });

  it('the day still turns at 18:00 UTC', () => {
    expect(todayInWorkZone(new Date('2026-08-11T17:59:00Z'))).toBe('2026-08-11');
    expect(todayInWorkZone(new Date('2026-08-11T18:00:00Z'))).toBe('2026-08-12');
    expect(formatTime('2026-08-11T12:30:00Z')).toBe('18:30');
  });
});

describe('America/Sao_Paulo (UTC−3)', () => {
  it('exposes −3 h', () => {
    setWorkTimeZone(SAO_PAULO);
    expect(workTimeZone()).toBe('America/Sao_Paulo');
    expect(workTimeZoneLabel()).toBe('Sao Paulo');
    expect(startOfWorkDate('2026-08-11').toISOString()).toBe('2026-08-11T03:00:00.000Z');
  });

  it('the day turns at 00:00 local = 03:00 UTC', () => {
    setWorkTimeZone(SAO_PAULO);
    expect(todayInWorkZone(new Date('2026-08-11T02:59:00Z'))).toBe('2026-08-10');
    expect(todayInWorkZone(new Date('2026-08-11T03:00:00Z'))).toBe('2026-08-11');
    // 15:00 local — where a UTC+6 zone turns the day
    expect(workDateOf('2026-08-11T18:00:00Z')).toBe('2026-08-11');
  });

  it('clocks and hours are local', () => {
    setWorkTimeZone(SAO_PAULO);
    expect(formatTime('2026-08-11T21:30:00Z')).toBe('18:30');
    expect(workHourNow(new Date('2026-08-11T10:05:00Z'))).toBe(7);
    expect(workHourNow(new Date('2026-08-11T03:10:00Z'))).toBe(0);
    expect(formatDateTime('2026-08-12T02:30:00Z')).toBe(
      '11 August 2026, 23:30',
    );
  });

  it('month and year roll over at local midnight', () => {
    setWorkTimeZone(SAO_PAULO);
    // 31 Dec 23:59 local
    expect(thisMonthRange(new Date('2027-01-01T02:59:00Z'))).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(thisMonthRange(new Date('2027-01-01T03:00:00Z'))).toEqual({
      from: '2027-01-01',
      to: '2027-01-01',
    });
  });

  it('ignores a malformed answer and keeps the previous zone', () => {
    setWorkTimeZone({ timeZone: 'Broken', utcOffsetMinutes: Number.NaN });
    expect(workTimeZone()).toBe('Etc/GMT-6');
    expect(formatTime('2026-08-11T12:30:00Z')).toBe('18:30');
  });
});

describe('Europe/Lisbon (daylight saving)', () => {
  it('uses the offset in force at each instant', () => {
    setWorkTimeZone(LISBON);
    expect(formatTime('2026-01-15T12:00:00Z')).toBe('12:00');
    expect(formatTime('2026-07-15T12:00:00Z')).toBe('13:00');
    expect(workDateOf('2026-01-01T23:30:00Z')).toBe('2026-01-01');
    expect(workDateOf('2026-07-01T23:30:00Z')).toBe('2026-07-02');
    expect(startOfWorkDate('2026-07-02').toISOString()).toBe('2026-07-01T23:00:00.000Z');
  });

  it('the spring day has 23 hours, the autumn day 25', () => {
    setWorkTimeZone(LISBON);
    expect(hoursOf('2026-03-29')).toBe(23);
    expect(hoursOf('2026-10-25')).toBe(25);
    expect(hoursOf('2026-07-02')).toBe(24);
  });

  it('a zone the browser does not know falls back to the offset sent', () => {
    setWorkTimeZone({ timeZone: 'Mars/Olympus', utcOffsetMinutes: -120 });
    expect(formatTime('2026-07-15T12:00:00Z')).toBe('10:00');
  });
});
