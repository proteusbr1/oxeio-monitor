import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isSettledMonth,
  monthKey,
  planHolidaySeed,
  planHolidaySeedRun,
  workToday,
  yearsSettled,
  yearsToSeed,
  type ExistingHoliday,
  type HolidayEntry,
} from '../prisma/holiday-seed';
import { isRealDate } from '../src/calendar/holiday-import';

/**
 * Planning a holiday insert — the seed (`SEED_COUNTRY`) and the file import
 * (`import-holidays.ts`).
 *
 * The rules that matter are not about any specific date:
 *   1. Nothing already in the table is changed or deleted — a date the owner
 *      corrected or moved stays as it is, and a moved holiday does not come
 *      back at its old date.
 *   2. The current and past months are not touched without consent — a new
 *      holiday there moves targets and pay already counted.
 */

const entry = (over: Partial<HolidayEntry> = {}): HolidayEntry => ({
  date: '2026-03-21',
  name: 'Spring Festival',
  nameEn: 'Spring Festival',
  approximate: false,
  ...over,
});

const row = (date: string, name: string): ExistingHoliday => ({ date, name });

/**
 * Most of the `planHolidaySeedRun` tests below are about the year gate, not
 * the month gate. So "today" is a day on which every date in the list is in
 * the future — the month gate is then inactive, and the tests measure
 * exactly what they mean to.
 *
 * This is deliberately not done with `allowPast: true`: every test would
 * then silently exercise the consent path, and the default path (no consent)
 * would go effectively untested.
 */
const early = { today: '2026-01-01', allowPast: false };

// ── Date validity ────────────────────────────────────────────────────────────

describe('isRealDate', () => {
  it('accepts a normal date', () => {
    expect(isRealDate('2026-03-21')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true); // leap year
  });

  /** `new Date('2026-02-30')` silently becomes 2 March — it does not stop */
  it('catches 2026-02-30 and 2026-02-29', () => {
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-02-29')).toBe(false);
  });

  it('month/day limits and format', () => {
    expect(isRealDate('2026-13-01')).toBe(false);
    expect(isRealDate('2026-00-10')).toBe(false);
    expect(isRealDate('2026-04-31')).toBe(false);
    expect(isRealDate('2026-3-21')).toBe(false);
    expect(isRealDate('21-03-2026')).toBe(false);
    expect(isRealDate('')).toBe(false);
  });
});

// ── "Today" ──────────────────────────────────────────────────────────────────

/**
 * Whether a month is "already out" depends on today's date — and a wrong
 * "today" moves holidays into a month whose pay is already counted.
 */
describe('workToday', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('converts the UTC clock to the work-zone date', () => {
    expect(workToday(new Date('2026-08-14T05:00:00.000Z'), 'Etc/GMT-6')).toBe('2026-08-14');
  });

  /**
   * The real trap. 2 AM on 1 September in a UTC+6 zone is 8 PM on 31 August
   * in UTC. Going by UTC, the seed would think August is the "current month"
   * and quietly insert holidays into just-finished August.
   */
  it('early morning ahead of UTC is the previous day in UTC — the zone date is returned', () => {
    expect(workToday(new Date('2026-08-31T20:00:00.000Z'), 'Etc/GMT-6')).toBe('2026-09-01');
  });

  it('just before and after local midnight', () => {
    expect(workToday(new Date('2026-08-14T17:59:59.000Z'), 'Etc/GMT-6')).toBe('2026-08-14');
    expect(workToday(new Date('2026-08-14T18:00:00.000Z'), 'Etc/GMT-6')).toBe('2026-08-15');
  });

  it('follows the zone, behind UTC too', () => {
    // 01:30 UTC on the 1st is still the 31st in São Paulo (UTC-3)
    expect(workToday(new Date('2026-09-01T01:30:00.000Z'), 'America/Sao_Paulo')).toBe('2026-08-31');
    expect(workToday(new Date('2026-09-01T03:00:00.000Z'), 'America/Sao_Paulo')).toBe('2026-09-01');
  });

  it('reads WORK_TIMEZONE, and is UTC when it is not set', () => {
    vi.stubEnv('WORK_TIMEZONE', 'Etc/GMT-6');
    expect(workToday(new Date('2026-08-14T18:00:00.000Z'))).toBe('2026-08-15');
    vi.stubEnv('WORK_TIMEZONE', '');
    expect(workToday(new Date('2026-08-14T18:00:00.000Z'))).toBe('2026-08-14');
  });
});

describe('monthKey and isSettledMonth', () => {
  it('month key', () => {
    expect(monthKey('2026-08-26')).toBe('2026-08');
  });

  /** The current month counts as "gone" too — the figures are already written mid-month */
  it('the current month is treated as settled', () => {
    expect(isSettledMonth('2026-08-05', '2026-08-14')).toBe(true);
    expect(isSettledMonth('2026-08-26', '2026-08-14')).toBe(true);
    expect(isSettledMonth('2026-08-31', '2026-08-01')).toBe(true);
  });

  it('a past month is settled', () => {
    expect(isSettledMonth('2026-03-21', '2026-08-14')).toBe(true);
    expect(isSettledMonth('2025-12-25', '2026-08-14')).toBe(true);
  });

  /** A future month is safe — there is no monthly_summary row there at all */
  it('a future month is not settled', () => {
    expect(isSettledMonth('2026-09-01', '2026-08-31')).toBe(false);
    expect(isSettledMonth('2027-01-24', '2026-08-14')).toBe(false);
  });
});

// ── The plan ─────────────────────────────────────────────────────────────────

describe('planHolidaySeed', () => {
  const list: HolidayEntry[] = [
    entry({ date: '2026-03-21', name: 'Spring Festival' }),
    entry({ date: '2026-12-16', name: 'National Day' }),
  ];

  it('everything is inserted into an empty DB', () => {
    const plan = planHolidaySeed(list, []);

    expect(plan.create).toHaveLength(2);
    expect(plan.keptByDate).toEqual([]);
    expect(plan.unlisted).toEqual([]);
  });

  it('does not touch it when a row exists on that date', () => {
    const plan = planHolidaySeed(list, [row('2026-12-16', 'National Day')]);

    expect(plan.create.map((h) => h.date)).toEqual(['2026-03-21']);
    expect(plan.keptByDate.map((h) => h.date)).toEqual(['2026-12-16']);
  });

  /** The owner renamed it — the planner does not revert that, it only reports */
  it('with a different name on the same date it does not change it, it reports', () => {
    const plan = planHolidaySeed(list, [row('2026-12-16', 'National Day (observed)')]);

    expect(plan.create.map((h) => h.date)).not.toContain('2026-12-16');
    expect(plan.renamed).toEqual([
      { date: '2026-12-16', inDb: 'National Day (observed)', inList: 'National Day' },
    ]);
  });

  /**
   * The owner moved a holiday one day earlier. Looking only at dates, the
   * planner would find the old date empty and create the holiday there
   * again — one extra day off, and the month's work days would silently drop.
   */
  it('a holiday the owner moved is recognised by name and left alone', () => {
    const plan = planHolidaySeed(list, [row('2026-12-15', 'National Day')]);

    expect(plan.keptByName).toEqual([{ entry: list[1], foundAt: '2026-12-15' }]);
    expect(plan.create.map((h) => h.date)).toEqual(['2026-03-21']);
  });

  /**
   * Two contradictory statements about one thing — the moved row must not
   * also be reported as "not in the list".
   */
  it('a row recognised by name is not reported as "not in the list"', () => {
    const plan = planHolidaySeed(list, [row('2026-12-15', 'National Day')]);

    expect(plan.keptByName).toHaveLength(1);
    expect(plan.unlisted).toEqual([]);
  });

  /** The same name in another year is a different holiday — it must not be blocked */
  it('a row with the same name from the previous year does not block this year\'s', () => {
    const plan = planHolidaySeed(
      [entry({ date: '2027-03-10', name: 'Spring Festival' })],
      [row('2026-03-21', 'Spring Festival')],
    );

    expect(plan.create.map((h) => h.date)).toEqual(['2027-03-10']);
  });

  /**
   * A cancelled holiday or one the owner added themselves — the difference
   * cannot be told from here, so it is not deleted, only shown.
   */
  it('shows rows not in the list, but never deletes them', () => {
    const plan = planHolidaySeed(list, [row('2026-08-15', 'Company Day')]);

    expect(plan.unlisted).toEqual([{ date: '2026-08-15', name: 'Company Day' }]);
    expect(plan.create).toHaveLength(2);
  });

  it('rows for a year outside the list are left completely alone', () => {
    const plan = planHolidaySeed(list, [row('2025-12-25', 'Christmas Day')]);

    expect(plan.unlisted).toEqual([]);
  });

  it('a second run over the same list inserts nothing and reports nothing', () => {
    const first = planHolidaySeed(list, []);
    const again = planHolidaySeed(
      list,
      first.create.map((h) => row(h.date, h.name)),
    );

    expect(again.create).toEqual([]);
    expect(again.renamed).toEqual([]);
    expect(again.unlisted).toEqual([]);
  });
});

// ── Which years get seeded ───────────────────────────────────────────────────

describe('yearsToSeed', () => {
  it('all years on a new DB', () => {
    expect(yearsToSeed([2026, 2027], [])).toEqual([2026, 2027]);
  });

  /**
   * A seeded year is never looked at again. If the owner deleted a day, the
   * DB holds no trace of it — looking back, the day would seem "missing" and
   * be inserted again.
   */
  it('an already-seeded year is skipped', () => {
    expect(yearsToSeed([2026, 2027], [2026])).toEqual([2027]);
    expect(yearsToSeed([2026, 2027], [2026, 2027])).toEqual([]);
  });

  it('a new year is seeded automatically', () => {
    expect(yearsToSeed([2027, 2028], [2026, 2027])).toEqual([2028]);
  });

  it('an unknown year in `seeded` causes no trouble', () => {
    expect(yearsToSeed([2026], [2019, 2026])).toEqual([]);
  });
});

// ── One run ──────────────────────────────────────────────────────────────────

/**
 * The notes are produced every time — not only on the run that inserts.
 * Otherwise, once a year was seeded, a cancelled holiday sitting in the table
 * (taking a workday out of its month) would never be mentioned again.
 */
describe('planHolidaySeedRun', () => {
  const list: HolidayEntry[] = [
    entry({ date: '2026-03-21', name: 'Spring Festival', approximate: true }),
    entry({ date: '2026-12-16', name: 'National Day' }),
    entry({ date: '2027-12-16', name: 'National Day' }),
  ];

  const cancelled = row('2026-08-15', 'Former Holiday');

  it('when the year is open, that year\'s rows are inserted', () => {
    const run = planHolidaySeedRun(list, [], [2026], early);

    expect(run.create.map((h) => h.date)).toEqual(['2026-03-21', '2026-12-16']);
    expect(run.heldBack.map((h) => h.date)).toEqual(['2027-12-16']);
  });

  it('the approximate flag travels with the entry to the insert', () => {
    const run = planHolidaySeedRun(list, [], [2026], early);

    expect(run.create.find((h) => h.date === '2026-03-21')?.approximate).toBe(true);
    expect(run.create.find((h) => h.date === '2026-12-16')?.approximate).toBe(false);
  });

  it('even when all years are seeded, it reports a row not in the list', () => {
    const run = planHolidaySeedRun(list, [cancelled], [], early);

    expect(run.create).toEqual([]);
    expect(run.notes.some((n) => n.includes('2026-08-15'))).toBe(true);
    expect(run.notes.some((n) => n.includes('Former Holiday'))).toBe(true);
  });

  it('even when all years are seeded, it reports a rename — and does not rename', () => {
    const run = planHolidaySeedRun(
      list,
      [
        row('2026-03-21', 'Spring Festival (moved)'),
        row('2026-12-16', 'National Day'),
        row('2027-12-16', 'National Day'),
      ],
      [],
      early,
    );
    const note = run.notes.find((n) => n.includes('2026-03-21'));

    expect(run.create).toEqual([]);
    expect(note).toContain('Spring Festival (moved)');
    expect(note).toContain('the seed does not rename');
    expect(note).toContain('Settings → Holidays');
  });

  /**
   * The owner deleted the row — it is not brought back (the year is closed),
   * but it is not passed over in silence either.
   */
  it('a missing row in a closed year is not inserted, but is reported by name', () => {
    const run = planHolidaySeedRun(list, [row('2026-12-16', 'National Day')], [], early);

    expect(run.create).toEqual([]);
    expect(run.heldBack.map((h) => h.date)).toEqual(['2026-03-21', '2027-12-16']);
    expect(run.notes.some((n) => n.includes('2026-03-21'))).toBe(true);
  });

  it('when everything matches there is no note', () => {
    const run = planHolidaySeedRun(
      list,
      list.map((h) => row(h.date, h.name)),
      [],
      early,
    );

    expect(run.notes).toEqual([]);
    expect(run.create).toEqual([]);
    expect(run.heldBack).toEqual([]);
    expect(run.kept).toBe(3);
  });

  /** Notes that need the owner's attention (⚠️) come first; merely informative ones (`·`) after */
  it('notes demanding attention come first', () => {
    const run = planHolidaySeedRun(
      list,
      [cancelled, row('2026-12-15', 'National Day')],
      [2026, 2027],
      early,
    );

    const firstPlain = run.notes.findIndex((n) => n.startsWith('·'));
    const lastWarn = run.notes.map((n) => n.startsWith('⚠️')).lastIndexOf(true);

    expect(firstPlain).toBeGreaterThan(-1);
    expect(firstPlain).toBeGreaterThan(lastWarn);
  });
});

// ── Guarding the current and past months ─────────────────────────────────────

/**
 * The bug this section prevents: a routine `npm run seed` in mid-August
 * inserting two August holidays. August's work days drop, `dailyTargetSec`
 * rises, `target_sec`, `expected_sec` and `pace_sec` all move, and the
 * payroll `d / D` fraction is directly money — no question, no error.
 */
describe('planHolidaySeedRun — current/past months', () => {
  const august = { today: '2026-08-14', allowPast: false };

  const list: HolidayEntry[] = [
    entry({ date: '2026-03-21', name: 'Spring Festival' }), // past month
    entry({ date: '2026-08-05', name: 'Remembrance Day' }), // current month, before today
    entry({ date: '2026-08-26', name: 'Harvest Festival', approximate: true }), // current month, after today
    entry({ date: '2026-12-16', name: 'National Day' }), // future month
  ];

  it('only the future month\'s one is inserted', () => {
    const run = planHolidaySeedRun(list, [], [2026], august);

    expect(run.create.map((h) => h.date)).toEqual(['2026-12-16']);
  });

  /**
   * The rest of the current month is held back too — the month's work days D
   * is a whole-month figure; even a late holiday changes the earlier days'
   * `target_sec` and `pace_sec`.
   */
  it('a future date in the current month is held back too — D is a whole-month figure', () => {
    const run = planHolidaySeedRun(list, [], [2026], august);

    expect(run.needsConsent.map((h) => h.date)).toEqual([
      '2026-03-21',
      '2026-08-05',
      '2026-08-26',
    ]);
  });

  it('each held-back date appears in the note by name', () => {
    const run = planHolidaySeedRun(list, [], [2026], august);

    for (const date of ['2026-03-21', '2026-08-05', '2026-08-26']) {
      expect(run.notes.some((n) => n.includes(date))).toBe(true);
    }
    expect(run.notes.some((n) => n.includes('Harvest Festival'))).toBe(true);
  });

  /**
   * Not just "not inserted" — how to get it inserted and what happens then.
   * The past-month part is separate: the current month corrects itself, a
   * past month does not.
   */
  it('the note has the consent route, the money point and the past-month consequence', () => {
    const run = planHolidaySeedRun(list, [], [2026], august);
    const howTo = run.notes.find((n) => n.includes('SEED_HOLIDAYS_PAST=true'));

    expect(howTo).toBeDefined();
    expect(howTo).toContain('d÷D');
    expect(howTo).toContain('past month');
  });

  it('with consent all are inserted, and there is no complaint either', () => {
    const run = planHolidaySeedRun(list, [], [2026], { today: '2026-08-14', allowPast: true });

    expect(run.create).toHaveLength(4);
    expect(run.needsConsent).toEqual([]);
    expect(run.notes).toEqual([]);
  });

  /**
   * "Year closed" and "month gone" at once → only `heldBack`: even with
   * consent it would not be inserted, so asking for consent would give false hope.
   */
  it('when the year is closed, consent is not asked for', () => {
    const run = planHolidaySeedRun(list, [], [], august);

    expect(run.needsConsent).toEqual([]);
    expect(run.heldBack).toHaveLength(4);
  });

  it('consent is not asked for rows already in the table', () => {
    const run = planHolidaySeedRun(
      list,
      list.map((h) => row(h.date, h.name)),
      [2026],
      august,
    );

    expect(run.create).toEqual([]);
    expect(run.needsConsent).toEqual([]);
    expect(run.notes).toEqual([]);
  });
});

// ── Which years count as fully seeded ────────────────────────────────────────

describe('yearsSettled', () => {
  const pending = (date: string) => entry({ date });

  it('when nothing is held back, the open years are fully settled', () => {
    expect(yearsSettled([2026, 2027], [])).toEqual([2026, 2027]);
  });

  /**
   * If a year were closed while rows awaited consent, the next run with
   * `SEED_HOLIDAYS_PAST=true` would insert nothing — `yearsToSeed` would skip
   * the year. The flag would exist and do nothing.
   */
  it('a year with rows awaiting consent is not fully settled', () => {
    expect(yearsSettled([2026, 2027], [pending('2026-08-05')])).toEqual([2027]);
  });

  it('another year\'s held-back row does not hold back this year', () => {
    expect(yearsSettled([2026], [pending('2027-01-24')])).toEqual([2026]);
  });

  it('empty when no year is open', () => {
    expect(yearsSettled([], [pending('2026-08-05')])).toEqual([]);
  });
});
