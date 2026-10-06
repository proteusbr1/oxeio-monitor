import { describe, expect, it } from 'vitest';

import {
  APPROX_SUFFIX,
  BD_HOLIDAYS,
  HOLIDAY_YEARS,
  PENDING_GAZETTES,
  baseName,
  workToday,
  gazetteNotes,
  hasApproxSuffix,
  holidayRowName,
  isRealDate,
  isSettledMonth,
  monthKey,
  planHolidaySeed,
  planHolidaySeedRun,
  validateHolidays,
  yearOf,
  yearsSettled,
  yearsToSeed,
  type ExistingHoliday,
  type HolidayEntry,
} from '../prisma/holidays.data';
/**
 * Careful: the report side is also tested from here, not from
 * `reports.range.spec.ts` — the marker has two copies (the seed writes it,
 * the report reads it), and checking they are identical needs both files
 * together. Separated, exactly that pair would go untested, and it is
 * the place most likely to break.
 */
import {
  APPROX_HOLIDAY_SUFFIX,
  approximateHolidayDates,
  isApproximateHoliday,
} from '../src/reports/reports.range';

/**
 * The government holiday list (R7, O2).
 *
 * The most important tests in this file are not about any specific date —
 * the government will change dates anyway. What matters is two rules:
 *   1. Approximate dates go into the DB marked as approximate (the
 *      "(probable)" suffix). If it were dropped, a guess would slip in
 *      disguised as a confirmed number.
 *   2. The seed never deletes anyone's manual work — a date corrected after
 *      the announcement will not revert on the next `db seed`, and a moved
 *      holiday will not come back at its old date.
 */

const entry = (over: Partial<HolidayEntry> = {}): HolidayEntry => ({
  date: '2026-03-21',
  name: 'ঈদুল ফিতর',
  nameEn: 'Eid-ul-Fitr',
  approximate: true,
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
  it('catches 2026-02-30', () => {
    expect(isRealDate('2026-02-30')).toBe(false);
  });

  it('catches 2026-02-29 — 2026 is not a leap year', () => {
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

// ── Validating the list ──────────────────────────────────────────────────────

describe('validateHolidays', () => {
  it('catches an invalid date', () => {
    const problems = validateHolidays([entry({ date: '2026-02-30' })]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2026-02-30');
  });

  /**
   * `holiday_date` is unique — with the same date twice, the seed would
   * silently overwrite one with the other and a holiday would vanish.
   */
  it('catches the same date twice, naming the earlier one', () => {
    const problems = validateHolidays([
      entry({ date: '2026-03-21', name: 'ঈদুল ফিতর' }),
      entry({ date: '2026-03-21', name: 'অন্য কিছু' }),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ঈদুল ফিতর');
  });

  it('catches an empty name — both Bengali and English', () => {
    expect(validateHolidays([entry({ name: '   ' })])).toHaveLength(1);
    expect(validateHolidays([entry({ nameEn: '' })])).toHaveLength(1);
  });

  /** The API limit is 120 characters (`CreateHolidayDto`) — measured including the suffix */
  it('catches a name over 120 characters', () => {
    expect(validateHolidays([entry({ name: 'ছ'.repeat(121) })])).toHaveLength(1);
  });

  /** The suffix comes from `approximate`; written by hand it would be added twice */
  it('catches a hand-written approximate suffix in the name', () => {
    const problems = validateHolidays([
      entry({ name: 'ঈদুল ফিতর (সম্ভাব্য)' }),
    ]);

    expect(problems).toHaveLength(1);
  });

  it('returns all the errors at once, does not stop at the first', () => {
    const problems = validateHolidays([
      entry({ date: '2026-02-30' }),
      entry({ date: '2026-04-31' }),
      entry({ date: '2026-06-01', name: '' }),
    ]);

    expect(problems).toHaveLength(3);
  });

  it('says nothing for a correct list', () => {
    expect(validateHolidays([entry(), entry({ date: '2026-03-22' })])).toEqual(
      [],
    );
  });
});

// ── The real list itself ─────────────────────────────────────────────────────

describe('BD_HOLIDAYS — the list in the repo', () => {
  it('has no errors', () => {
    expect(validateHolidays(BD_HOLIDAYS)).toEqual([]);
  });

  it('only 2026 and 2027 — no other year has slipped in', () => {
    expect([...HOLIDAY_YEARS].sort((a, b) => a - b)).toEqual([2026, 2027]);
    for (const holiday of BD_HOLIDAYS) {
      expect(HOLIDAY_YEARS).toContain(yearOf(holiday.date));
    }
  });

  it('sorted by date — easier to scan by eye, and gaps show up', () => {
    const dates = BD_HOLIDAYS.map((h) => h.date);
    expect(dates).toEqual([...dates].sort());
  });

  /**
   * The heart of this work. Lunar and tithi-based holiday dates change after
   * the moon is sighted; if the flag were dropped, a guess would slip in as
   * confirmed and nobody would think to verify it.
   */
  it('lunar and calendar-based holidays are approximate', () => {
    const moonBound = [
      'শবে বরাত',
      'শবে কদর',
      'জুমাতুল বিদা',
      'ঈদুল ফিতর',
      'ঈদুল আজহা',
      'আশুরা',
      'মিলাদুন্নবী',
      'জন্মাষ্টমী',
      'দুর্গাপূজা',
      'দশমী',
    ];

    for (const holiday of BD_HOLIDAYS) {
      if (moonBound.some((needle) => holiday.name.includes(needle))) {
        expect(
          holiday.approximate,
          `${holiday.date} "${holiday.name}" — approximate হওয়ার কথা`,
        ).toBe(true);
      }
    }
  });

  /**
   * The opposite direction too: a national day on a Gregorian date is never
   * "probable". If everything were made approximate, the marker would mean nothing.
   */
  it('fixed-date national days are not approximate', () => {
    const fixed = ['02-21', '03-26', '05-01', '08-05', '11-07', '12-16', '12-25'];

    for (const holiday of BD_HOLIDAYS) {
      if (fixed.includes(holiday.date.slice(5))) {
        expect(
          holiday.approximate,
          `${holiday.date} "${holiday.name}" — নির্দিষ্ট তারিখ`,
        ).toBe(false);
      }
    }
  });

  /** The mistake this work prevents: the Eid days not being in the list at all */
  it('2026 and 2027 — both years have both Eids', () => {
    for (const year of [2026, 2027]) {
      const ofYear = BD_HOLIDAYS.filter((h) => yearOf(h.date) === year);
      expect(ofYear.some((h) => h.name.includes('ঈদুল ফিতর'))).toBe(true);
      expect(ofYear.some((h) => h.name.includes('ঈদুল আজহা'))).toBe(true);
    }
  });

  /**
   * Two days dropped from the list in 2024 — the old seed used to insert them.
   * If they came back, two work days would silently become holidays again.
   */
  it('cancelled holidays (Father of the Nation\'s birthday, National Mourning Day) have not returned', () => {
    const names = BD_HOLIDAYS.map((h) => h.name);
    expect(names).not.toContain('জাতির পিতার জন্মদিন');
    expect(names).not.toContain('জাতীয় শোক দিবস');

    /**
     * This could not be checked by date — the test first did that and
     * was caught out: on 15 August 2027 Eid-e-Miladunnabi falls. A cancelled
     * day and another holiday on that same date are not the same thing.
     */
    expect(BD_HOLIDAYS.find((h) => h.date === '2026-03-17')?.name).toBe(
      'শবে কদর',
    );
    expect(BD_HOLIDAYS.find((h) => h.date === '2026-08-15')).toBeUndefined();
  });
});

// ── Names that go into the DB ────────────────────────────────────────────────

describe('holidayRowName and baseName', () => {
  it('adds the suffix when approximate, not otherwise', () => {
    expect(holidayRowName(entry({ approximate: true }))).toBe(
      `ঈদুল ফিতর${APPROX_SUFFIX}`,
    );
    expect(holidayRowName(entry({ approximate: false }))).toBe('ঈদুল ফিতর');
  });

  /** When the announcement comes the owner will remove the suffix — the row must still be recognisable */
  it('baseName is the same with or without the suffix', () => {
    expect(baseName(`ঈদুল ফিতর${APPROX_SUFFIX}`)).toBe('ঈদুল ফিতর');
    expect(baseName('ঈদুল ফিতর')).toBe('ঈদুল ফিতর');
    expect(baseName('  ঈদুল ফিতর  ')).toBe('ঈদুল ফিতর');
  });

  /** Only the tail is checked — a bracket in the middle of a name is not the marker */
  it('hasApproxSuffix looks only at the tail', () => {
    expect(hasApproxSuffix(`ঈদুল ফিতর${APPROX_SUFFIX}`)).toBe(true);
    expect(hasApproxSuffix(`ঈদুল ফিতর${APPROX_SUFFIX}   `)).toBe(true);
    expect(hasApproxSuffix('ঈদুল ফিতর')).toBe(false);
    expect(hasApproxSuffix('ঈদ (সম্ভাব্য) — সংশোধিত')).toBe(false);
  });
});

// ── Which month's figures have already gone out ──────────────────────────────

/**
 * This section is the heart of this round. Adding a holiday in the current
 * or a past month reduces that month's work days, raises `dailyTargetSec`,
 * moves three cells of `monthly_summary`, and the payroll `d / D` fraction
 * goes straight into money. So everything stands on the answer to one
 * question: "has the month already passed?"
 */
describe('workToday', () => {
  it('converts the UTC clock to the Dhaka date', () => {
    expect(workToday(new Date('2026-08-14T05:00:00.000Z'))).toBe('2026-08-14');
  });

  /**
   * This is the real trap. 2 AM on 1 September in Dhaka is 8 PM on 31 August
   * in UTC. Going by UTC, the seed would think August is the "current
   * month", and would quietly insert holidays into just-finished August and
   * disturb that month's payroll.
   */
  it('early morning in Dhaka is the previous day in UTC — still the Dhaka date is returned', () => {
    expect(workToday(new Date('2026-08-31T20:00:00.000Z'))).toBe('2026-09-01');
  });

  it('just before and after local midnight', () => {
    expect(workToday(new Date('2026-08-14T17:59:59.000Z'))).toBe('2026-08-14');
    expect(workToday(new Date('2026-08-14T18:00:00.000Z'))).toBe('2026-08-15');
  });

  it('follows the work time zone, not a fixed +6', () => {
    // 01:30 UTC on the 1st is still the 31st in São Paulo (UTC-3)
    expect(workToday(new Date('2026-09-01T01:30:00.000Z'), 'America/Sao_Paulo')).toBe('2026-08-31');
    expect(workToday(new Date('2026-09-01T03:00:00.000Z'), 'America/Sao_Paulo')).toBe('2026-09-01');
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

// ── Years with no gazette yet ────────────────────────────────────────────────

describe('gazetteNotes', () => {
  /**
   * Only `approximate` rows are counted. When 26 March falls does not depend
   * on the gazette — mixing them would give one number with two definitions.
   */
  it('counts only the approximate dates', () => {
    const notes = gazetteNotes(
      [
        entry({ date: '2027-03-09', approximate: true }),
        entry({ date: '2027-03-10', approximate: true }),
        entry({ date: '2027-03-26', name: 'স্বাধীনতা দিবস', approximate: false }),
      ],
      [{ year: 2027, dueBy: 'November 2026' }],
    );

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('2 dates');
    expect(notes[0]).toContain('November 2026');
  });

  /** There is no point talking about uncertainty that does not exist */
  it('silent when that year has nothing approximate', () => {
    expect(
      gazetteNotes(
        [entry({ date: '2027-12-16', approximate: false })],
        [{ year: 2027, dueBy: 'November 2026' }],
      ),
    ).toEqual([]);
    expect(
      gazetteNotes([entry({ date: '2026-03-21' })], [
        { year: 2027, dueBy: 'November 2026' },
      ]),
    ).toEqual([]);
  });

  /**
   * The real list — when the seed runs, the owner really will see this
   * message, and the number will match the list. Not a hand-written number.
   */
  it('in the real list 2027\'s uncertainty is counted, and the number comes from the list', () => {
    const notes = gazetteNotes(BD_HOLIDAYS);
    const unsure2027 = BD_HOLIDAYS.filter(
      (h) => yearOf(h.date) === 2027 && h.approximate,
    ).length;

    expect(unsure2027).toBeGreaterThan(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`${unsure2027} dates`);
    expect(notes[0]).toContain('2027');
  });

  /**
   * The 2026 gazette is out (November 2025) — so the year must not be in the
   * list, otherwise the warning would fire falsely.
   */
  it('2026 is not in the list of years awaiting a gazette', () => {
    expect(PENDING_GAZETTES.map((g) => g.year)).not.toContain(2026);
  });
});

// ── Whether the uncertainty reaches the numbers ──────────────────────────────

/**
 * Until now the marker lived only in the name. But the numbers that stand on
 * those dates — the month's work days -> the denominator of the daily target
 * -> `target_sec`, and the payroll `d / D` fraction (directly money) —
 * carried no trace of the uncertainty. These tests guard that bridge.
 */
describe('the approximate-holiday marker — writing and reading', () => {
  /**
   * The most important test in this file. The string is written in two
   * places (`prisma/holidays.data.ts` writes it, `src/reports/reports.range.ts`
   * reads it) because an import breaks in both directions: going
   * `src/` -> `prisma/` moves the `nest build` output to `dist/src/main.js`,
   * and going `prisma/` -> `src/` breaks the seed in the runtime image
   * (which has no `src/`). If the two copies drifted apart, the seed would
   * still set the marker but the report would not recognise it and would say
   * "no probable dates" forever — the uncertainty would silently evaporate
   * and no test would go red.
   */
  it('the report reads exactly what the seed writes', () => {
    expect(APPROX_HOLIDAY_SUFFIX).toBe(APPROX_SUFFIX);
  });

  it('the report recognises the seed-built name as approximate', () => {
    expect(isApproximateHoliday(holidayRowName(entry({ approximate: true })))).toBe(
      true,
    );
    expect(
      isApproximateHoliday(holidayRowName(entry({ approximate: false }))),
    ).toBe(false);
  });

  /**
   * When the announcement comes the owner removes the marker in Settings ->
   * Holidays. The report's warning should stop at that moment too —
   * otherwise a settled date would be called "probable" forever, and after a
   * while nobody would read the warning at all.
   */
  it('when the owner removes the marker it is immediately no longer approximate', () => {
    expect(isApproximateHoliday('ঈদে মিলাদুন্নবী (সা.)')).toBe(false);
    expect(isApproximateHoliday(`ঈদে মিলাদুন্নবী (সা.)${APPROX_SUFFIX}  `)).toBe(
      true,
    );
  });

  /** If the marker is in the middle of a name it is not the tail — it must not count */
  it('does not count when it is in the middle of the name', () => {
    expect(isApproximateHoliday('ঈদ (সম্ভাব্য) — সংশোধিত')).toBe(false);
  });

  const at = (date: string, name: string) => ({
    date: new Date(`${date}T00:00:00.000Z`),
    name,
  });

  it('returns only the approximate dates, sorted', () => {
    expect(
      approximateHolidayDates([
        at('2026-08-26', `ঈদে মিলাদুন্নবী (সা.)${APPROX_SUFFIX}`),
        at('2026-08-05', 'জুলাই গণঅভ্যুত্থান দিবস'),
        at('2026-09-04', `শুভ জন্মাষ্টমী${APPROX_SUFFIX}`),
      ]),
    ).toEqual(['2026-08-26', '2026-09-04']);
  });

  /**
   * "None is probable" and "there is no holiday" are not the same thing.
   * Both return an empty list, and that is right — this function only speaks
   * about uncertainty; whether a holiday exists is not its job (that belongs
   * to the work-day calculation).
   */
  it('empty when all dates are firm', () => {
    expect(approximateHolidayDates([at('2026-12-16', 'বিজয় দিবস')])).toEqual([]);
    expect(approximateHolidayDates([])).toEqual([]);
  });

  /** Joining the ranges of several months, the caller may send the same row twice */
  it('the same date appearing twice is counted once', () => {
    const row = at('2026-08-26', `ঈদে মিলাদুন্নবী (সা.)${APPROX_SUFFIX}`);

    expect(approximateHolidayDates([row, row])).toEqual(['2026-08-26']);
  });

  /**
   * The real case for the current month: Eid-e-Miladunnabi on 26 August 2026,
   * and it is moon-dependent. If the date moves, August's work days change ->
   * everyone's `target_sec` changes -> the payroll denominator changes too.
   * If the list and the report disagreed here, the number would silently
   * rest on a guess.
   */
  it('August 2026\'s Miladunnabi stays approximate from the list through to the report', () => {
    const eidMilad = BD_HOLIDAYS.find((h) => h.date === '2026-08-26');

    expect(eidMilad?.approximate).toBe(true);
    expect(
      approximateHolidayDates([
        at('2026-08-26', holidayRowName(eidMilad as HolidayEntry)),
      ]),
    ).toEqual(['2026-08-26']);
  });
});

// ── Seed planning ────────────────────────────────────────────────────────────

describe('planHolidaySeed', () => {
  const list: HolidayEntry[] = [
    entry({ date: '2026-03-21', name: 'ঈদুল ফিতর', cluster: 'eid' }),
    entry({
      date: '2026-03-22',
      name: 'ঈদুল ফিতরের ছুটি (২য় দিন)',
      cluster: 'eid',
    }),
    entry({
      date: '2026-12-16',
      name: 'বিজয় দিবস',
      nameEn: 'Victory Day',
      approximate: false,
    }),
  ];

  it('everything is inserted into an empty DB', () => {
    const plan = planHolidaySeed(list, []);

    expect(plan.create).toHaveLength(3);
    expect(plan.keptByDate).toEqual([]);
    expect(plan.unlisted).toEqual([]);
  });

  it('does not touch it when a row exists on that date', () => {
    const plan = planHolidaySeed(list, [row('2026-12-16', 'বিজয় দিবস')]);

    expect(plan.create.map((h) => h.date)).toEqual([
      '2026-03-21',
      '2026-03-22',
    ]);
    expect(plan.keptByDate.map((h) => h.date)).toEqual(['2026-12-16']);
  });

  /** The owner renamed it — the seed does not revert that, it only reports */
  it('with a different name on the same date it does not change it, it reports', () => {
    const plan = planHolidaySeed(list, [
      row('2026-12-16', 'বিজয় দিবস (সরকারি)'),
    ]);

    expect(plan.create.map((h) => h.date)).not.toContain('2026-12-16');
    expect(plan.renamed).toEqual([
      {
        date: '2026-12-16',
        inDb: 'বিজয় দিবস (সরকারি)',
        inList: 'বিজয় দিবস',
      },
    ]);
  });

  /**
   * This was the most dangerous case. The owner moved the Eid cluster one day
   * earlier after the announcement. Looking only at dates, the seed would
   * find the old dates empty and create holidays there again — Eid would sit
   * across twice as many days and the month's work days would silently drop.
   */
  it('if one day of a cluster is moved, the whole cluster is left alone', () => {
    const plan = planHolidaySeed(list, [
      row('2026-03-20', 'ঈদুল ফিতর'), // the owner changed 21 -> 20
    ]);

    expect(plan.create.map((h) => h.date)).toEqual(['2026-12-16']);
    expect(plan.keptByCluster.map((h) => h.date)).toEqual([
      '2026-03-21',
      '2026-03-22',
    ]);
  });

  it('even with the marker removed, the moved row is recognised', () => {
    const plan = planHolidaySeed(list, [
      row('2026-03-20', `ঈদুল ফিতর${APPROX_SUFFIX}`),
    ]);

    expect(plan.create.map((h) => h.date)).toEqual(['2026-12-16']);
  });

  it('a moved holiday outside a cluster leaves only itself alone', () => {
    const plan = planHolidaySeed(list, [row('2026-12-15', 'বিজয় দিবস')]);

    expect(plan.keptByName).toEqual([
      { entry: list[2], foundAt: '2026-12-15' },
    ]);
    expect(plan.create.map((h) => h.date)).toEqual([
      '2026-03-21',
      '2026-03-22',
    ]);
  });

  /**
   * Two contradictory statements about one thing — this was the bug. If the
   * owner moved Victory Day from 16 to 15 December, the row would show up in
   * `keptByName` ("owner moved it, not touched") and in `unlisted` ("not in
   * the list — is it still a holiday?") at once. The two notes would print
   * side by side and the reader would stop trusting either.
   */
  it('a row recognised by name is no longer reported as "not in the list"', () => {
    const plan = planHolidaySeed(list, [row('2026-12-15', 'বিজয় দিবস')]);

    expect(plan.keptByName).toHaveLength(1);
    expect(plan.unlisted).toEqual([]);
  });

  /** Same for a moved cluster — Eid is not both "moved" and "unknown" */
  it('a row of a moved cluster is not reported as "not in the list" either', () => {
    const plan = planHolidaySeed(list, [
      row('2026-03-20', 'ঈদুল ফিতর'), // the owner changed 21 -> 20
      row('2026-03-22', 'ঈদুল ফিতরের ছুটি (২য় দিন)'), // this one did not move
    ]);

    expect(plan.keptByCluster).toHaveLength(2);
    expect(plan.unlisted).toEqual([]);
  });

  /** The same name in another year is a different holiday — it must not be blocked */
  it('a row with the same name from the previous year does not block this year\'s', () => {
    const plan = planHolidaySeed(
      [entry({ date: '2027-03-10', name: 'ঈদুল ফিতর' })],
      [row('2026-03-21', 'ঈদুল ফিতর')],
    );

    expect(plan.create.map((h) => h.date)).toEqual(['2027-03-10']);
  });

  /**
   * A cancelled holiday or one the owner added themselves — the difference
   * cannot be told from here, so it is not deleted, only shown.
   */
  it('shows rows not in the list, but does not put them on the delete list', () => {
    const plan = planHolidaySeed(list, [row('2026-08-15', 'জাতীয় শোক দিবস')]);

    expect(plan.unlisted).toEqual([
      { date: '2026-08-15', name: 'জাতীয় শোক দিবস' },
    ]);
    expect(plan.create).toHaveLength(3);
  });

  /** No comment at all about rows for a year not being seeded this time */
  it('rows for a year outside the list are left completely alone', () => {
    const plan = planHolidaySeed(list, [row('2025-12-25', 'বড়দিন')]);

    expect(plan.unlisted).toEqual([]);
  });

  it('inserting the real list into an empty DB, the count matches', () => {
    const plan = planHolidaySeed(BD_HOLIDAYS, []);

    expect(plan.create).toHaveLength(BD_HOLIDAYS.length);
    // Running it twice, the second run inserts nothing
    const again = planHolidaySeed(
      BD_HOLIDAYS,
      plan.create.map((h) => row(h.date, holidayRowName(h))),
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
   * The seed never looks back at an already-seeded year. If the owner
   * deleted a day after the announcement, the DB holds no trace of it — on
   * looking back the day would seem "missing" and be inserted again, and one
   * extra holiday would be counted.
   */
  it('an already-seeded year is skipped', () => {
    expect(yearsToSeed([2026, 2027], [2026])).toEqual([2027]);
    expect(yearsToSeed([2026, 2027], [2026, 2027])).toEqual([]);
  });

  it('a newly added year is seeded automatically', () => {
    expect(yearsToSeed([2026, 2027, 2028], [2026, 2027])).toEqual([2028]);
  });

  it('an unknown year in `seeded` causes no trouble', () => {
    expect(yearsToSeed([2026], [2019, 2026])).toEqual([]);
  });
});

// ── One seed run ─────────────────────────────────────────────────────────────

/**
 * The note is printed every time. Previously, once a year was seeded,
 * `seedHolidays()` returned early, so the `unlisted`/`renamed` notes went
 * silent for good after the first run — in a live DB `2026-08-15 National
 * Mourning Day` (cancelled in 2024) sits there reducing one August work day,
 * and the seed no longer said so.
 * Not saying it is not a decision, it is suppression — the seed itself was
 * breaking the rule.
 */
describe('planHolidaySeedRun', () => {
  const list: HolidayEntry[] = [
    entry({ date: '2026-03-21', name: 'ঈদুল ফিতর' }),
    entry({
      date: '2026-12-16',
      name: 'বিজয় দিবস',
      nameEn: 'Victory Day',
      approximate: false,
    }),
    entry({
      date: '2027-12-16',
      name: 'বিজয় দিবস',
      nameEn: 'Victory Day',
      approximate: false,
    }),
  ];

  const cancelled = row('2026-08-15', 'জাতীয় শোক দিবস');

  it('when the year is open, that year\'s rows are inserted', () => {
    const run = planHolidaySeedRun(list, [], [2026], early);

    expect(run.create.map((h) => h.date)).toEqual([
      '2026-03-21',
      '2026-12-16',
    ]);
    expect(run.heldBack.map((h) => h.date)).toEqual(['2027-12-16']);
  });

  /**
   * The heart of this work. Both years are already seeded, so no row is
   * inserted — yet the cancelled holiday is still reported.
   */
  it('even when all years are seeded, it reports the cancelled holiday', () => {
    const run = planHolidaySeedRun(list, [cancelled], [], early);

    expect(run.create).toEqual([]);
    expect(run.notes.some((n) => n.includes('2026-08-15'))).toBe(true);
    expect(run.notes.some((n) => n.includes('জাতীয় শোক দিবস'))).toBe(true);
  });

  /** A rename is reported every time too — not said once and then forgotten */
  it('even when all years are seeded, it reports the rename', () => {
    const run = planHolidaySeedRun(
      list,
      [
        row('2026-03-21', 'ঈদুল ফিতর (সংশোধিত)'),
        row('2026-12-16', 'বিজয় দিবস'),
        row('2027-12-16', 'বিজয় দিবস'),
      ],
      [],
      early,
    );

    expect(run.create).toEqual([]);
    expect(run.notes.some((n) => n.includes('ঈদুল ফিতর (সংশোধিত)'))).toBe(true);
  });

  /**
   * The real state of the live VPS, and this is to-do number 4. The old seed
   * left `Father of the Nation's birthday` on 2026-03-17; the new list has
   * `Shab-e-Qadr (probable)` on that date. `planHolidaySeed()` matches on
   * the date and does not rename (deliberate — so the owner's manual work is
   * not wiped), so that row will never get the "(probable)" marker. Fixing
   * it is not mandatory, but not saying so would be suppression — the note
   * must say it clearly so the owner can fix it by hand.
   */
  it('the marker is being lost — the note says so explicitly', () => {
    const run = planHolidaySeedRun(
      [entry({ date: '2026-03-17', name: 'শবে কদর', nameEn: 'Laylat al-Qadr' })],
      [row('2026-03-17', 'জাতির পিতার জন্মদিন')],
      [2026],
      early,
    );
    const note = run.notes.find((n) => n.includes('2026-03-17'));

    expect(note).toContain('জাতির পিতার জন্মদিন');
    expect(note).toContain(`শবে কদর${APPROX_SUFFIX}`);
    expect(note).toContain('the seed does not rename');
    expect(note).toContain('never get');
    expect(note).toContain('Settings → Holidays');
  });

  /**
   * The opposite case: if the DB name has the marker too, nothing is lost —
   * saying "will not get the marker" would then be false, and that is exactly
   * the falsehood this round is meant to prevent.
   */
  it('a rename that loses no marker does not say "will not get the marker"', () => {
    const run = planHolidaySeedRun(
      [entry({ date: '2026-03-17', name: 'শবে কদর', nameEn: 'Laylat al-Qadr' })],
      [row('2026-03-17', `লাইলাতুল কদর${APPROX_SUFFIX}`)],
      [2026],
      early,
    );
    const note = run.notes.find((n) => n.includes('2026-03-17'));

    expect(note).toContain('the seed does not rename');
    expect(note).not.toContain('never get');
  });

  /**
   * The owner deleted the row after the announcement — the seed does not
   * bring it back (the year is closed), but it does not stay silent either.
   * Silence would give the false impression that "the list and the DB match".
   */
  it('a missing row in a closed year is not inserted, but is reported by name', () => {
    const run = planHolidaySeedRun(
      list,
      [row('2026-12-16', 'বিজয় দিবস')],
      [],
      early,
    );

    expect(run.create).toEqual([]);
    expect(run.heldBack.map((h) => h.date)).toEqual([
      '2026-03-21',
      '2027-12-16',
    ]);
    expect(run.notes.some((n) => n.includes('2026-03-21'))).toBe(true);
  });

  it('when everything matches there is no note — and then silence is true too', () => {
    const run = planHolidaySeedRun(
      list,
      list.map((h) => row(h.date, holidayRowName(h))),
      [],
      early,
    );

    expect(run.notes).toEqual([]);
    expect(run.create).toEqual([]);
    expect(run.heldBack).toEqual([]);
    expect(run.kept).toBe(3);
  });

  /** Notes that demand the owner's attention (warning prefix) come first; merely informative ones (`·`) after */
  it('notes demanding attention come first', () => {
    const run = planHolidaySeedRun(
      list,
      [cancelled, row('2026-12-15', 'বিজয় দিবস')],
      [2026, 2027],
      early,
    );

    const firstPlain = run.notes.findIndex((n) => n.startsWith('·'));
    const lastWarn = run.notes.map((n) => n.startsWith('⚠️')).lastIndexOf(true);

    expect(firstPlain).toBeGreaterThan(lastWarn);
  });

  /** The real list on an empty DB — there should be no complaint on the first run */
  it('inserting the real list into an empty DB gives no notes', () => {
    const run = planHolidaySeedRun(
      BD_HOLIDAYS,
      [],
      [...HOLIDAY_YEARS],
      early,
    );

    expect(run.notes).toEqual([]);
    expect(run.create).toHaveLength(BD_HOLIDAYS.length);
  });

  /**
   * Second run: all years seeded, all rows in the DB — yet if a cancelled
   * holiday is sitting there, the seed still reports it. This behaviour did not exist before.
   */
  it('on the second run of the real list it does not stay silent about the cancelled holiday', () => {
    const inDb = BD_HOLIDAYS.map((h) => row(h.date, holidayRowName(h)));
    const run = planHolidaySeedRun(
      BD_HOLIDAYS,
      [...inDb, cancelled],
      [],
      early,
    );

    expect(run.create).toEqual([]);
    expect(run.notes).toHaveLength(1);
    expect(run.notes[0]).toContain('2026-08-15');
  });
});

// ── Guarding the current and past months ─────────────────────────────────────

/**
 * The bug this section prevents: running `npm run seed` on the VPS on 14
 * August 2026 would have inserted two new holidays in August (`2026-08-05`,
 * `2026-08-26`). August's work days 26 -> 24, `dailyTargetSec` 8.00h ->
 * 8.67h, all three of `monthly_summary`'s `target_sec`, `expected_sec` and
 * `pace_sec` new, and G37's `d / D` fraction (`src/payroll/payroll.service.ts`)
 * is directly money. A routine command, no question, no error — and pay would
 * change in the middle of the month.
 */
describe('planHolidaySeedRun — current/past months', () => {
  const august = { today: '2026-08-14', allowPast: false };

  const list: HolidayEntry[] = [
    entry({ date: '2026-03-21', name: 'ঈদুল ফিতর' }), // past month
    entry({
      date: '2026-08-05',
      name: 'জুলাই গণঅভ্যুত্থান দিবস',
      nameEn: 'July Mass Uprising Day',
      approximate: false,
    }), // current month, before today
    entry({
      date: '2026-08-26',
      name: 'ঈদে মিলাদুন্নবী (সা.)',
      nameEn: 'Eid-e-Miladunnabi',
    }), // current month, after today
    entry({
      date: '2026-12-16',
      name: 'বিজয় দিবস',
      nameEn: 'Victory Day',
      approximate: false,
    }), // future month
  ];

  it('only the future month\'s one is inserted', () => {
    const run = planHolidaySeedRun(list, [], [2026], august);

    expect(run.create.map((h) => h.date)).toEqual(['2026-12-16']);
  });

  /**
   * The remaining day of the current month (26 August, today the 14th) is
   * held back too — deliberate. The month's work days D is a whole-month
   * figure; even a holiday late in the month retroactively changes the
   * earlier days' `target_sec` and `pace_sec`.
   */
  it('a future date in the current month is held back too — D is a whole-month figure', () => {
    const run = planHolidaySeedRun(list, [], [2026], august);

    expect(run.needsConsent.map((h) => h.date)).toEqual([
      '2026-03-21',
      '2026-08-05',
      '2026-08-26',
    ]);
  });

  /** Not dropped silently — each one's name and date appear in the note */
  it('each held-back date appears in the note by name', () => {
    const run = planHolidaySeedRun(list, [], [2026], august);

    for (const date of ['2026-03-21', '2026-08-05', '2026-08-26']) {
      expect(run.notes.some((n) => n.includes(date))).toBe(true);
    }
    expect(run.notes.some((n) => n.includes('ঈদে মিলাদুন্নবী (সা.)'))).toBe(
      true,
    );
  });

  /**
   * Not just "not inserted" — both how to get it inserted and what happens then.
   *
   * The past-month part must be separate, because the current month corrects
   * itself while a past month does not — said together, the owner would
   * think everything would fix itself.
   */
  it('the note has the consent route, the money point and the past-month consequence', () => {
    const run = planHolidaySeedRun(list, [], [2026], august);
    const howTo = run.notes.find((n) => n.includes('SEED_HOLIDAYS_PAST=true'));

    expect(howTo).toBeDefined();
    expect(howTo).toContain('d÷D');
    expect(howTo).toContain('past month');
    expect(howTo).toContain('§ 2.1c');
  });

  it('with consent all are inserted, and there is no complaint either', () => {
    const run = planHolidaySeedRun(list, [], [2026], {
      today: '2026-08-14',
      allowPast: true,
    });

    expect(run.create).toHaveLength(4);
    expect(run.needsConsent).toEqual([]);
    expect(run.notes).toEqual([]);
  });

  /**
   * A row can fall under "year closed" and "month gone" at once. Then it is
   * only `heldBack`, because even with consent it would not be inserted while
   * the year is closed — asking for consent would give false hope. One row,
   * one message.
   */
  it('when the year is closed, consent is not asked for', () => {
    const run = planHolidaySeedRun(list, [], [], august);

    expect(run.needsConsent).toEqual([]);
    expect(run.heldBack).toHaveLength(4);
  });

  /** Rows already in the DB are not this gate's concern — nothing is being inserted */
  it('consent is not asked for rows already seeded', () => {
    const run = planHolidaySeedRun(
      list,
      list.map((h) => row(h.date, holidayRowName(h))),
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
   * Why this is needed: if a year were closed while rows awaited consent, on
   * the next run even `SEED_HOLIDAYS_PAST=true` would insert nothing —
   * `yearsToSeed` would skip the year entirely. The flag would exist and do
   * nothing, and a comment would say "it will be inserted with consent". A
   * false comment in code is worse than a bug, so the year is kept open.
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
