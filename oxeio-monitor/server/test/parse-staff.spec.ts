import { describe, expect, it } from 'vitest';

import { parseStaff, shouldSeedSampleStaff } from '../prisma/parse-staff';

/**
 * Validation of `staff.local.json`.
 *
 * Careful: every mistake here lands directly in a money amount, because this
 * file decides whose salary is what and who joined when. There used to be no
 * validation (`as Staff[]`), so a typo surfaced as a Prisma message that did
 * not say which employee's row was wrong.
 *
 * So the messages are tested too: "it stopped" is not enough, it must say
 * where.
 */
const ROW = ['OX-01', 'Rakib Hasan', 'Accountant', 25000] as const;

const one = (row: unknown) => () => parseStaff([row]);

describe('parseStaff: happy path', () => {
  it('a four-cell row works (old file without a date)', () => {
    expect(parseStaff([[...ROW]])).toEqual([
      {
        empCode: 'OX-01',
        fullName: 'Rakib Hasan',
        designation: 'Accountant',
        monthlySalary: 25000,
      },
    ]);
  });

  /**
   * The most important claim. With no date, the field is absent from the
   * result, not `null`. The seed does not send `undefined` fields to Prisma,
   * so a date somebody set by hand in the dashboard survives.
   *
   * With `null`, re-running the seed would wipe that date, and with it the
   * proration, with no error.
   */
  it('without a date there is no joinedOn field at all', () => {
    expect('joinedOn' in parseStaff([[...ROW]])[0]).toBe(false);
  });

  it('a five-cell row gives a date at UTC midnight', () => {
    const [row] = parseStaff([[...ROW, '2026-01-05']]);
    expect(row.joinedOn?.toISOString()).toBe('2026-01-05T00:00:00.000Z');
  });

  /**
   * Dhaka is UTC+6. If `new Date('2026-01-01')` were read as local time it
   * would become 31 December, and someone who joined on the 1st would land in
   * the previous month: full salary this month, one day's pay in the last.
   */
  it('the first day of a month does not slip into the previous month', () => {
    const [row] = parseStaff([[...ROW, '2026-01-01']]);
    expect(row.joinedOn?.toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('trims whitespace', () => {
    const [row] = parseStaff([[' OX-01 ', ' Rakib ', ' Accountant ', 25000]]);
    expect(row).toMatchObject({ empCode: 'OX-01', fullName: 'Rakib' });
  });

  it('an empty list works', () => {
    expect(parseStaff([])).toEqual([]);
  });
});

describe('parseStaff: catching mistakes', () => {
  it('stops when it is not a list', () => {
    expect(() => parseStaff({ 'OX-01': 25000 })).toThrow(/must be a list/);
  });

  /** Three cells means salary `undefined`, which gives an unclear Prisma error. */
  it('stops when there are too few cells', () => {
    expect(one(['OX-01', 'Rakib', 'Accountant'])).toThrow(/four or five cells/);
  });

  it('also stops when there are too many cells', () => {
    expect(one([...ROW, '2026-01-05', 'extra'])).toThrow(/four or five cells/);
  });

  /** Putting quotes around a number in JSON is a very common mistake. */
  it('stops when the salary is written as a string', () => {
    expect(one(['OX-01', 'Rakib', 'Accountant', '25000'])).toThrow(/without quotes/);
  });

  /** The column is `Int`: a fraction would silently lose the cents. */
  it('stops on a fractional salary', () => {
    expect(one(['OX-01', 'Rakib', 'Accountant', 25000.5])).toThrow(/fraction/);
  });

  it('stops on a negative salary', () => {
    expect(one(['OX-01', 'Rakib', 'Accountant', -1])).toThrow(/negative/);
  });

  it('stops when the name is empty', () => {
    expect(one(['OX-01', '   ', 'Accountant', 25000])).toThrow(/name — must be text/);
  });

  /**
   * With a duplicated code, the seed's upsert would overwrite the first with
   * the second: one employee silently vanishes and another's name and salary
   * take their place. Easy to do when the list is built by copy-paste.
   */
  it('stops when the same code appears twice', () => {
    const rows = [[...ROW], ['OX-01', 'Onno Keu', 'Manager', 40000]];
    expect(() => parseStaff(rows)).toThrow(/this code appears earlier/);
  });

  it('stops when the date format is wrong', () => {
    expect(one([...ROW, '05-01-2026'])).toThrow(/YYYY-MM-DD/);
    expect(one([...ROW, '2026-1-5'])).toThrow(/YYYY-MM-DD/);
  });

  /**
   * The trickiest case. `new Date('2026-02-30')` does not throw: JS quietly
   * makes it 2 March. Without converting back and comparing, the typo would go
   * straight into proration.
   */
  it('stops on a date that does not exist in the calendar', () => {
    expect(one([...ROW, '2026-02-30'])).toThrow(/no such date/);
    expect(one([...ROW, '2026-13-01'])).toThrow(/no such date/);
  });

  /** 2024 is a leap year and 2026 is not: whether 29 February is valid depends on the year. */
  it('handles leap years correctly', () => {
    expect(parseStaff([[...ROW, '2024-02-29']])[0].joinedOn).toBeInstanceOf(
      Date,
    );
    expect(one([...ROW, '2026-02-29'])).toThrow(/no such date/);
  });

  /**
   * The message carries both the code and the row number, so nobody has to
   * search a 12-row file for the one to fix.
   */
  it('the message says which row and which employee', () => {
    const rows = [[...ROW], ['OX-02', 'Karim', 'Intern', 'oops']];
    expect(() => parseStaff(rows)).toThrow(/Row 2 \(OX-02\)/);
  });
});

/**
 * Sample employees no longer go into production.
 *
 * These tests come from a bug found in the field. `staff.local.json` is
 * gitignored, so it is never on the VPS, and every seed run there created the
 * three sample employees from `staff.example.json`.
 *
 * The harm was not "three extra names in the list": they added 624 hours to
 * the team's monthly target, so the Live Board's "how far behind" number was
 * wrong by exactly that much, though they had not worked a minute.
 */
describe('shouldSeedSampleStaff', () => {
  it('a real list always seeds, so the update path is not closed', () => {
    expect(shouldSeedSampleStaff(false, 0)).toBe(true);
    expect(shouldSeedSampleStaff(false, 12)).toBe(true);
  });

  it('an empty database gets the samples, so a fresh clone can be run', () => {
    expect(shouldSeedSampleStaff(true, 0)).toBe(true);
  });

  /** The core test: this is the one that failed before the fix. */
  it('with employees present, the samples are no longer seeded', () => {
    expect(shouldSeedSampleStaff(true, 1)).toBe(false);
    expect(shouldSeedSampleStaff(true, 7)).toBe(false);
  });

  /**
   * "Empty" means zero, not "zero active": a running system where everyone was
   * deactivated should not get the sample people back either.
   */
  it('the samples do not return even if everyone is deactivated', () => {
    expect(shouldSeedSampleStaff(true, 3)).toBe(false);
  });
});
