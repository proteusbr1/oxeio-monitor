import { describe, expect, it } from 'vitest';

import {
  trendDayExpectation,
  type TrendStaff,
} from '../src/dashboard/dashboard.service';
import { elapsedWorkdays } from '../src/summary/summary.math';

/**
 * **E01 — the seven-day strip's expectation.**
 *
 * The bug this file prevents: the strip's target used to be counted by
 * **looking at `daily_summary` rows** (`day_type !== 'holiday'`). But if
 * someone worked an hour on a holiday, `dayTypeOf()` writes the day as
 * `worked` — so that very holiday would become the expectation of a full
 * working day. If someone worked two hours on a Friday, the chart for that
 * day would draw a full-day target bar in their name: **a penalty for
 * working on a holiday.** This was fixed earlier on the monthly card, but not on the strip.
 *
 * The last describe is the most important: whether the strip and the monthly
 * card use **the same definition** is checked against `elapsedWorkdays()`.
 *
 * **Test week — 8 to 14 August 2026:** the 8th is Saturday … the 14th Friday.
 * With the weekly day off on Friday (ISO 5), the only holiday that week is the 14th.
 */

/** UTC midnight — both Prisma's `@db.Date` and `workDateOf()` have this shape */
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/** Daily target of 8 hours, Friday off, observed since July */
function staff(over: Partial<TrendStaff> = {}): TrendStaff {
  return {
    employeeId: 1,
    weeklyOffDays: [5],
    joinedOn: null,
    leftOn: null,
    trackedFrom: day('2026-07-01'),
    dailyTargetSec: 8 * 3600,
    ...over,
  };
}

const NO_HOLIDAYS: ReadonlySet<number> = new Set<number>();

describe('trendDayExpectation — no penalty for working on a holiday', () => {
  it('no target on the weekly day off — even if work was done', () => {
    // Friday 14 August. The old code looked at `day_type`, and if work had been
    // done that was `worked` — so a full 8-hour target would be set.
    expect(trendDayExpectation(day('2026-08-14'), [staff()], NO_HOLIDAYS)).toEqual(
      { expectedStaff: 0, targetSec: 0 },
    );
  });

  it('the same on a public holiday — the calendar has the last word', () => {
    const holidays = new Set([day('2026-08-12').getTime()]);

    expect(
      trendDayExpectation(day('2026-08-12'), [staff()], holidays),
    ).toEqual({ expectedStaff: 0, targetSec: 0 });
  });

  it('the full target on a normal working day', () => {
    expect(trendDayExpectation(day('2026-08-13'), [staff()], NO_HOLIDAYS)).toEqual(
      { expectedStaff: 1, targetSec: 8 * 3600 },
    );
  });

  it('`weeklyOffDay: null` means every day is a working day (schema rule)', () => {
    const everyDay = staff({ weeklyOffDays: [] });

    expect(
      trendDayExpectation(day('2026-08-14'), [everyDay], NO_HOLIDAYS)
        .expectedStaff,
    ).toBe(1);
  });
});

describe("trendDayExpectation — an unobserved day is nobody's shortfall", () => {
  it("no expectation on a day before the employee's own tracking start", () => {
    const late = staff({ trackedFrom: day('2026-08-13') });

    expect(
      trendDayExpectation(day('2026-08-12'), [late], NO_HOLIDAYS),
    ).toEqual({ expectedStaff: 0, targetSec: 0 });
  });

  it('the tracking start day itself counts', () => {
    const late = staff({ trackedFrom: day('2026-08-13') });

    expect(
      trendDayExpectation(day('2026-08-13'), [late], NO_HOLIDAYS).expectedStaff,
    ).toBe(1);
  });

  it('never observed (`trackedFrom: null`) — no day has an expectation', () => {
    const unseen = staff({ trackedFrom: null });

    expect(
      trendDayExpectation(day('2026-08-13'), [unseen], NO_HOLIDAYS),
    ).toEqual({ expectedStaff: 0, targetSec: 0 });
  });
});

describe('trendDayExpectation — no expectation outside the employment period', () => {
  it('the day before joining is not counted', () => {
    const fresh = staff({ joinedOn: day('2026-08-13') });

    expect(
      trendDayExpectation(day('2026-08-12'), [fresh], NO_HOLIDAYS).expectedStaff,
    ).toBe(0);
    expect(
      trendDayExpectation(day('2026-08-13'), [fresh], NO_HOLIDAYS).expectedStaff,
    ).toBe(1);
  });

  it('the day after leaving is not counted', () => {
    const gone = staff({ leftOn: day('2026-08-12') });

    expect(
      trendDayExpectation(day('2026-08-12'), [gone], NO_HOLIDAYS).expectedStaff,
    ).toBe(1);
    expect(
      trendDayExpectation(day('2026-08-13'), [gone], NO_HOLIDAYS).expectedStaff,
    ).toBe(0);
  });
});

describe('trendDayExpectation — team', () => {
  it("days off differ per employee — the sum is the team's target", () => {
    // Friday 14 August: a day off for the first, not for the second
    const friday = staff({ employeeId: 1, weeklyOffDays: [5] });
    const sunday = staff({
      employeeId: 2,
      weeklyOffDays: [7],
      dailyTargetSec: 6 * 3600,
    });

    expect(
      trendDayExpectation(day('2026-08-14'), [friday, sunday], NO_HOLIDAYS),
    ).toEqual({ expectedStaff: 1, targetSec: 6 * 3600 });
  });

  it('zero when nobody is there — and that really is "everyone is off"', () => {
    expect(trendDayExpectation(day('2026-08-14'), [], NO_HOLIDAYS)).toEqual({
      expectedStaff: 0,
      targetSec: 0,
    });
  });

  it('fractions are not rounded here — the sum is rounded once, in the caller', () => {
    const odd = staff({ dailyTargetSec: 208 * 3600 / 27 });

    expect(
      trendDayExpectation(day('2026-08-13'), [odd, odd], NO_HOLIDAYS).targetSec,
    ).toBe((208 * 3600 / 27) * 2);
  });
});

/**
 * **The strip and the monthly card — one definition.**
 *
 * `elapsedWorkdays()` (the source of the month's `expected_sec`) and
 * `trendDayExpectation()` both answer the same question: "will that day count
 * in their expectation?" **Two deliberate differences remain**, and the last
 * two tests below write down exactly those — so that nobody, trying to "make
 * them equal", ends up writing "everyone is off today" on the board.
 */
describe('the strip and the monthly card follow one rule', () => {
  /** A window of that one day — asking `elapsedWorkdays()` a one-day question */
  const monthlySaysExpected = (
    date: Date,
    s: TrendStaff,
    today: Date,
    holidays: ReadonlySet<number> = NO_HOLIDAYS,
  ): boolean =>
    elapsedWorkdays({
      periodStart: date,
      periodEnd: date,
      today,
      joinedOn: s.joinedOn,
      leftOn: s.leftOn,
      trackingStartedOn: s.trackedFrom,
      weeklyOffDays: s.weeklyOffDays,
      holidays,
    }) === 1;

  const TOMORROW = day('2026-08-15');

  it('on every finished day the two say the same thing', () => {
    const cases: Array<[string, TrendStaff, ReadonlySet<number>]> = [
      ['2026-08-13', staff(), NO_HOLIDAYS],
      ['2026-08-14', staff(), NO_HOLIDAYS],
      ['2026-08-12', staff(), new Set([day('2026-08-12').getTime()])],
      ['2026-08-12', staff({ trackedFrom: day('2026-08-13') }), NO_HOLIDAYS],
      ['2026-08-12', staff({ joinedOn: day('2026-08-13') }), NO_HOLIDAYS],
      ['2026-08-13', staff({ leftOn: day('2026-08-12') }), NO_HOLIDAYS],
    ];

    for (const [iso, s, holidays] of cases) {
      const ribbon =
        trendDayExpectation(day(iso), [s], holidays).expectedStaff === 1;

      expect(
        [iso, ribbon],
        // If it fails we must be able to see which day — otherwise the seven
        //    cases would blur into one message
        `${iso} — ফিতে ও কার্ড আলাদা কথা বলছে`,
      ).toEqual([iso, monthlySaysExpected(day(iso), s, TOMORROW, holidays)]);
    }
  });

  /**
   * The second (and last) mismatch is written down here — because an unwritten
   * mismatch does more harm in future than one that has been found.
   *
   * It is never visible on screen: `teamTrend()` sends only those employees
   * who have a `monthly_summary` row for the current month, and `refreshDate()`
   * writes the daily and monthly rows together — so the state "a monthly row
   * exists but not a single daily row" never arises.
   */
  it('a never-observed employee — no expectation here, but there is in `elapsedWorkdays()`', () => {
    const unseen = staff({ trackedFrom: null });
    const date = day('2026-08-13');

    expect(trendDayExpectation(date, [unseen], NO_HOLIDAYS).expectedStaff).toBe(0);
    // There `null` means "the limit is unknown", so the window is not narrowed
    expect(monthlySaysExpected(date, unseen, TOMORROW)).toBe(true);
  });

  it('**today** — the second deliberate difference, outside the employment-period limit', () => {
    const today = day('2026-08-13');
    const s = staff();

    // Monthly card: today has not finished, so it is not in "how much was expected so far"
    expect(monthlySaysExpected(today, s, today)).toBe(false);

    // Strip: that day's target is there — the day is just still running.
    // Setting it to 0 would make `WeekAndMonth.tsx` label today's bar "day off".
    expect(
      trendDayExpectation(today, [s], NO_HOLIDAYS).expectedStaff,
    ).toBe(1);
  });
});
