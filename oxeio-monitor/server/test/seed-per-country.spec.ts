import { describe, expect, it } from 'vitest';

import {
  parseHolidayCsv,
  parseHolidayFile,
  parseHolidayIcs,
} from '../src/calendar/holiday-import';
import { HOLIDAY_SETS, resolveHolidaySet } from '../prisma/holiday-sets';
import { BD_HOLIDAYS, HOLIDAY_YEARS } from '../prisma/holidays.data';
import { DEFAULT_SEED_POLICY, seedPolicyFromEnv } from '../prisma/seed-config';

/**
 * Seed and holidays for countries other than Bangladesh.
 *
 * The default stays exactly what the seed always did — Bangladesh's list,
 * 208 h, 26 days, Friday off — and that is the first thing each block checks.
 */

describe('resolveHolidaySet — SEED_COUNTRY', () => {
  it('unset → Bangladesh, the same list and settings key as before', () => {
    const set = resolveHolidaySet({});
    expect(set?.code).toBe('BD');
    expect(set?.entries).toBe(BD_HOLIDAYS);
    expect(set?.years).toBe(HOLIDAY_YEARS);
    expect(set?.settingKey).toBe('seed.holidays');
  });

  it('BD in any case', () => {
    expect(resolveHolidaySet({ SEED_COUNTRY: ' bd ' })?.code).toBe('BD');
  });

  it('none → no holidays', () => {
    expect(resolveHolidaySet({ SEED_COUNTRY: 'none' })).toBeNull();
  });

  it('SEED_HOLIDAYS=false → no holidays, only for exactly "false"', () => {
    expect(resolveHolidaySet({ SEED_HOLIDAYS: 'false' })).toBeNull();
    expect(resolveHolidaySet({ SEED_HOLIDAYS: 'no' })?.code).toBe('BD');
  });

  it('a country without a list stops the seed, never falls back to Bangladesh', () => {
    expect(() => resolveHolidaySet({ SEED_COUNTRY: 'BR' })).toThrow(
      /import-holidays/,
    );
  });

  it('only Bangladesh ships with the code', () => {
    expect(Object.keys(HOLIDAY_SETS)).toEqual(['BD']);
  });
});

describe('seedPolicyFromEnv — SEED_POLICY_*', () => {
  it('nothing set → 208 h, 26 days, Friday, as before', () => {
    expect(seedPolicyFromEnv({})).toEqual({
      monthlyTargetHours: 208,
      expectedWorkdays: 26,
      weeklyOffDays: [5],
    });
    expect(DEFAULT_SEED_POLICY.weeklyOffDays).toEqual([5]);
  });

  it('another week', () => {
    expect(
      seedPolicyFromEnv({
        SEED_POLICY_MONTHLY_HOURS: '176',
        SEED_POLICY_WORKDAYS: '22',
        SEED_POLICY_WEEKLY_OFF: '7,6',
      }),
    ).toEqual({
      monthlyTargetHours: 176,
      expectedWorkdays: 22,
      weeklyOffDays: [6, 7],
    });
  });

  it('"none" → no weekly day off', () => {
    expect(
      seedPolicyFromEnv({ SEED_POLICY_WEEKLY_OFF: 'none' }).weeklyOffDays,
    ).toEqual([]);
  });

  it.each([
    ['SEED_POLICY_MONTHLY_HOURS', 'abc'],
    ['SEED_POLICY_MONTHLY_HOURS', '0'],
    ['SEED_POLICY_WORKDAYS', '22.5'],
    ['SEED_POLICY_WORKDAYS', '40'],
    ['SEED_POLICY_WEEKLY_OFF', '8'],
    ['SEED_POLICY_WEEKLY_OFF', 'sunday'],
    ['SEED_POLICY_WEEKLY_OFF', '6,x'],
  ])('%s=%s stops the seed instead of falling back', (name, value) => {
    expect(() => seedPolicyFromEnv({ [name]: value })).toThrow(name);
  });
});

describe('parseHolidayCsv', () => {
  it('reads date, name, type — header and comments optional', () => {
    const r = parseHolidayCsv(
      [
        'date,name,type',
        '# national',
        '2027-01-01,New Year,public',
        '2027-02-09,"Carnival, Tuesday",optional',
        '2027-04-21,Tiradentes',
      ].join('\n'),
    );

    expect(r.problems).toEqual([]);
    expect(r.holidays.map((h) => [h.entry.date, h.entry.name, h.type])).toEqual(
      [
        ['2027-01-01', 'New Year', 'public'],
        ['2027-02-09', 'Carnival, Tuesday', 'optional'],
        ['2027-04-21', 'Tiradentes', 'public'],
      ],
    );
  });

  it('dates from a file are decisions, never "approximate"', () => {
    const [h] = parseHolidayCsv('2027-01-01,New Year').holidays;
    expect(h.entry.approximate).toBe(false);
  });

  it('reports bad lines instead of guessing', () => {
    const r = parseHolidayCsv(
      [
        '2027-02-30,Not a day',
        '01/05/2027,Wrong format',
        '2027-05-01,',
        '2027-05-02,X,holiday',
      ].join('\n'),
    );

    expect(r.holidays).toEqual([]);
    expect(r.problems).toHaveLength(4);
  });

  it('one holiday per date — a second name is reported, not merged', () => {
    const r = parseHolidayCsv(
      '2027-01-01,New Year\n2027-01-01,Confraternização',
    );
    expect(r.holidays).toHaveLength(1);
    expect(r.problems[0]).toMatch(/already "New Year"/);
  });
});

describe('parseHolidayIcs', () => {
  const ics = (body: string): string =>
    ['BEGIN:VCALENDAR', body, 'END:VCALENDAR'].join('\r\n');

  it('reads all-day events, with folded lines and escapes', () => {
    const r = parseHolidayIcs(
      ics(
        [
          'BEGIN:VEVENT',
          'DTSTART;VALUE=DATE:20270101',
          'SUMMARY:New Year\\, national',
          'END:VEVENT',
          'BEGIN:VEVENT',
          'DTSTART;VALUE=DATE:20270421',
          'SUMMARY:Tira',
          ' dentes',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );

    expect(r.problems).toEqual([]);
    expect(r.holidays.map((h) => [h.entry.date, h.entry.name])).toEqual([
      ['2027-01-01', 'New Year, national'],
      ['2027-04-21', 'Tiradentes'],
    ]);
  });

  it('a multi-day event is one holiday per day; DTEND is exclusive', () => {
    const r = parseHolidayIcs(
      ics(
        [
          'BEGIN:VEVENT',
          'DTSTART;VALUE=DATE:20270208',
          'DTEND;VALUE=DATE:20270210',
          'SUMMARY:Carnival',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );

    expect(r.holidays.map((h) => h.entry.date)).toEqual([
      '2027-02-08',
      '2027-02-09',
    ]);
  });

  it('skips events with a time of day, and says so', () => {
    const r = parseHolidayIcs(
      ics(
        [
          'BEGIN:VEVENT',
          'DTSTART:20270101T090000Z',
          'SUMMARY:Meeting',
          'END:VEVENT',
        ].join('\r\n'),
      ),
    );

    expect(r.holidays).toEqual([]);
    expect(r.problems[0]).toMatch(/time of day/);
  });

  it('picks the parser by extension', () => {
    expect(parseHolidayFile('x.ICS', ics('')).holidays).toEqual([]);
    expect(parseHolidayFile('x.csv', '2027-01-01,A').holidays).toHaveLength(1);
  });
});
