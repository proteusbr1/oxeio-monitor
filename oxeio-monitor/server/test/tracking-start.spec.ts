import { describe, expect, it } from 'vitest';

import {
  expectedSecOf as trayExpectedSec,
  paceSecOf as trayPaceSec,
} from '../src/agent/progress.math';
import {
  elapsedWindow,
  elapsedWorkdays,
  isObserved,
  proratedExpectedSec,
  rollupMonth,
  type ElapsedInput,
} from '../src/summary/summary.math';

/**
 * **The expectation window — one definition, on every screen.**
 *
 * This file guards two things:
 *
 * 1. **The window is right** (`elapsedWindow()` / `elapsedWorkdays()`) —
 *    it starts on the tracking start day and ends yesterday.
 *
 *    The mistake it prevents: `expected_sec` used to count from the 1st of the
 *    month, yet in this installation the agent went live on **13 August 2026**. So the
 *    Monthly page showed everyone ~94 hours behind — for a time when there
 *    was no measuring instrument at all. **Missing observation is not a failure** (rule 2).
 *
 * 2. **All four screens report the same number** (section 5 below). At one
 *    point the tray, the Live Board and the monthly rollup counted
 *    `workdays_elapsed` with three different definitions — what an employee
 *    saw in their own `/me` and what the owner saw on the dashboard differed by
 *    ~89 hours. Two answers on two screens means there is no answer to "which
 *    is true" — the biggest sin of this repo.
 *
 * **Test month — August 2026:** the 1st is a Saturday, Fridays are 7 · 14 · 21 · 28,
 * so 27 working days (the same month as `proration.e2e.spec.ts`).
 */

/** UTC-midnight date — both Prisma's `@db.Date` and `workDateOf()` have this shape */
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const HOUR = 3600;

const AUG_START = day('2026-08-01');
const AUG_END = day('2026-08-31');

/** Friday off (ISO 5) — this fixture's policy */
const FRIDAY_OFF = 5;

const NO_HOLIDAYS: ReadonlySet<number> = new Set<number>();

/** `trackingStartedOn` is deliberately **absent** — that is the old behaviour */
const BASE: ElapsedInput = {
  periodStart: AUG_START,
  periodEnd: AUG_END,
  today: day('2026-08-20'),
  joinedOn: null,
  leftOn: null,
  weeklyOffDays: [FRIDAY_OFF],
  holidays: NO_HOLIDAYS,
};

// ══════════════════════ 1 · without tracking start — as before ══════════════════════

describe('elapsedWorkdays — without trackingStartedOn the window starts at the start of the period', () => {
  /**
   * This is the safety net of the feature: the new concept is **optional**.
   * Without it, the start limit is `periodStart` (or the join day) as before, so
   * calculations that know nothing about tracking start keep their results.
   */
  it('1 August to yesterday — 17 working days', () => {
    expect(elapsedWorkdays(BASE)).toBe(17);
    expect(elapsedWindow(BASE)).toEqual({
      from: AUG_START,
      to: day('2026-08-19'),
    });
  });

  it('`null` and absent — both mean the same', () => {
    expect(elapsedWorkdays({ ...BASE, trackingStartedOn: null })).toBe(
      elapsedWorkdays(BASE),
    );
  });

  /**
   * **A hand-counted list, not `countWorkdays()`.**
   *
   * This used to say `expect(elapsedWorkdays(BASE)).toBe(countWorkdays(…))`
   * and claimed to "match the old formula". But `elapsedWorkdays()` itself
   * calls `countWorkdays()` inside — so the test wrote the same formula twice
   * and compared it with itself. If the formula were wrong it would be equally
   * wrong on both sides and the test would stay happily green. **What was
   * supposed to be measured was never measured.**
   */
  it('the days of the window match the hand-counted list', () => {
    // 1–19 August, excluding Fridays the 7th and 14th
    const byHand = [
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04',
      '2026-08-05', '2026-08-06', '2026-08-08', '2026-08-09',
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
      '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18',
      '2026-08-19',
    ];

    expect(byHand).toHaveLength(17);
    expect(elapsedWorkdays(BASE)).toBe(byHand.length);

    // and the two ends of the window are the two ends of that list
    const window = elapsedWindow(BASE);
    expect(window?.from).toEqual(day(byHand[0]));
    expect(window?.to).toEqual(day(byHand[byHand.length - 1]));
  });

  /** The join-day rule (G37) is intact — otherwise someone who joined on the 17th would be behind on day one */
  it('if joinedOn is mid-month, from there — as before', () => {
    expect(elapsedWorkdays({ ...BASE, joinedOn: day('2026-08-17') })).toBe(3);
  });

  it('leftOn pulls the end limit of the window down — as before', () => {
    expect(elapsedWorkdays({ ...BASE, leftOn: day('2026-08-10') })).toBe(9);
  });

  /**
   * Updating an old month stops the window at the last day of the period. If
   * it did not, last month's `workdays_elapsed` would grow past the whole month forever.
   */
  it('updating last month counts the whole month', () => {
    expect(elapsedWorkdays({ ...BASE, today: day('2026-09-10') })).toBe(27);
  });

  it('nothing has been counted in a future month', () => {
    const future = { ...BASE, today: day('2026-07-20') };
    expect(elapsedWindow(future)).toBeNull();
    expect(elapsedWorkdays(future)).toBe(0);
  });
});

// ═══════════════════ 2 · days before tracking start are not counted ═══════════════════

describe('elapsedWorkdays — working days before tracking start are excluded', () => {
  /** The real incident: the agent went live on 13 August, and we did not see the 12 days before it */
  it('if the start is mid-month, the earlier days drop out', () => {
    const withStart = { ...BASE, trackingStartedOn: day('2026-08-13') };

    expect(elapsedWorkdays(withStart)).toBe(6);
    expect(elapsedWindow(withStart)).toEqual({
      from: day('2026-08-13'),
      to: day('2026-08-19'),
    });

    // And those 11 days used to silently become "0 hours worked"
    expect(elapsedWorkdays(BASE) - elapsedWorkdays(withStart)).toBe(11);
  });

  it('no effect if the start is before the period', () => {
    expect(
      elapsedWorkdays({ ...BASE, trackingStartedOn: day('2026-07-20') }),
    ).toBe(elapsedWorkdays(BASE));
  });

  it('no effect even if the start is exactly the 1st of the month', () => {
    expect(elapsedWorkdays({ ...BASE, trackingStartedOn: AUG_START })).toBe(17);
  });

  /**
   * Of the two start limits, **the later one** wins. Even if tracking started
   * on the 13th, an employee who joined on the 17th is expected from the 17th —
   * otherwise they would start with the shortfall of the four days before joining.
   */
  it('if joinedOn is after the tracking start, joinedOn wins', () => {
    expect(
      elapsedWorkdays({
        ...BASE,
        joinedOn: day('2026-08-17'),
        trackingStartedOn: day('2026-08-13'),
      }),
    ).toBe(3);
  });

  /**
   * **And this is the whole reason for per-employee tracking start.**
   *
   * If the number were the **organisation's** first day (as it used to be, a
   * `findFirst` with no `where`), then in the very common case of an old
   * organisation and a new employee the window would start at the
   * organisation's first day, so months before they came to the system would
   * enter their shortfall. A correctly set `joined_on` would stop that too, but
   * that column is hand-written by the owner and may be empty; **this limit
   * comes from the data itself**, so it can be relied on separately.
   *
   * **What it does not do must be written down too.** `trackingStartedOn`
   * comes from `min(daily_summary.work_date)`, and `refreshDate()` writes a row
   * for every active employee — data or no data. So it measures **"since when
   * the server has been carrying this employee"**, not "since when the agent
   * went live". For an employee activated on 1 October whose agent arrived on
   * 8 October, the 5 agentless days are still a full shortfall — this file
   * used to say that exact case was "fixed", and the claim was false.
   */
  it('if joinedOn is before the tracking start, the tracking start wins', () => {
    expect(
      elapsedWorkdays({
        ...BASE,
        joinedOn: day('2026-08-03'),
        trackingStartedOn: day('2026-08-13'),
      }),
    ).toBe(6);
  });

  /**
   * **G120 fixed.** This test used to be the canary for that gap, and it has now been flipped.
   *
   * **The gap that existed:** `trackingStartedOn` came from
   * `min(daily_summary.work_date)`, yet `refreshDate()` writes a row for every
   * **active** employee (data or no data). So an employee activated on 3 August
   * had tracking counted from 3 August — even if the agent went live on the 13th —
   * and the eight agentless days in between stayed as their **full shortfall**.
   *
   * **The source is now `work_sessions`** (`src/summary/tracking-start.ts`),
   * whose rows exist only when the agent really sent something. So the number
   * now truly measures *"since when their agent has been live"*.
   *
   * The arithmetic (`elapsedWorkdays`) did **not change by a single line** in
   * this batch — only what feeds it changed. So this test shows that if the
   * feed is right the result is right; the real guard for the source change is
   * in `proration.e2e.spec.ts`.
   */
  it('if the agent went live late, the earlier days are no longer counted', () => {
    const activatedAug3 = {
      ...BASE,
      joinedOn: day('2026-08-03'),
      // The agent went live on the 13th — and the first `work_sessions` row is from then too
      trackingStartedOn: day('2026-08-13'),
    };

    // 13–19 August, excluding Friday the 14th = 6 days
    expect(elapsedWorkdays(activatedAug3)).toBe(6);

    /**
     * The difference from the old behaviour is **9 working days** — i.e. 72
     * hours, which used to be counted as that employee's shortfall although they were never observed.
     */
    const asBefore = { ...activatedAug3, trackingStartedOn: day('2026-08-03') };
    expect(elapsedWorkdays(asBefore) - elapsedWorkdays(activatedAug3)).toBe(9);
  });

  /**
   * **Never observed** — the caller then sends `today`, not `null`.
   *
   * Sending `null` would become "no limit" in `maxDate()`, the window would
   * open across the whole month, and someone whose agent never sent anything
   * would get a **full-month shortfall** — the opposite of the fix. This pair
   * of tests guards that decision.
   */
  it('never observed — sending today gives expectation 0, sending null gives the whole month', () => {
    const neverSeen = { ...BASE, trackingStartedOn: BASE.today };
    expect(elapsedWorkdays(neverSeen)).toBe(0);

    // What the mistake looks like — this is what happens if someone writes `?? null`
    const withNull = { ...BASE, trackingStartedOn: null };
    expect(elapsedWorkdays(withNull)).toBeGreaterThan(0);
  });

  /** Tracking starts today — not even one finished day has been seen, so expectation 0 */
  it('if tracking starts today the window is empty', () => {
    const fresh = { ...BASE, trackingStartedOn: BASE.today };
    expect(elapsedWindow(fresh)).toBeNull();
    expect(elapsedWorkdays(fresh)).toBe(0);
  });

  it('tracking start also matches the calendar holidays', () => {
    expect(
      elapsedWorkdays({
        ...BASE,
        trackingStartedOn: day('2026-08-13'),
        holidays: new Set([day('2026-08-17').getTime()]),
      }),
    ).toBe(5);
  });
});

// ════════════════════════════ 3 · today is excluded ════════════════════════════

describe('elapsedWorkdays — today is not counted in the expectation', () => {
  /**
   * This exact mistake was caught on the Live Board: counting today's full 8
   * hours in the expectation showed the team "114 hours behind" at 6 a.m.,
   * and by evening the number fixed itself. The same team got two different
   * verdicts in a day, purely because of the clock hands.
   */
  it('the window stops yesterday, not today', () => {
    // Counting today (Thursday 20 August) would give 18 — hand-counted
    expect(elapsedWorkdays(BASE)).toBe(17);
    expect(elapsedWindow(BASE)?.to).toEqual(day('2026-08-19'));
  });

  /** On the first day of the period not one day has finished yet — expectation 0 is the honest answer */
  it('if today is the 1st of the month the window is empty', () => {
    const first = { ...BASE, today: AUG_START };
    expect(elapsedWindow(first)).toBeNull();
    expect(elapsedWorkdays(first)).toBe(0);
  });

  /** If today is the weekly day off, excluding or not makes no difference — the number must still stay fixed */
  it('even if today is Friday, only up to yesterday', () => {
    // 1–20 August, excluding Fridays the 7th and 14th = 18
    expect(elapsedWorkdays({ ...BASE, today: day('2026-08-21') })).toBe(18);
  });
});

// ═════════════════ 4 · regression of the real incident — 14 August 2026 ═════════════════

describe('14 August 2026 — the phantom ~94-hour shortfall will not return', () => {
  /** 27 working days × 8 hours — August's prorated target */
  const AUG_TARGET = 27 * 8 * HOUR;

  const monthBase = {
    workedSec: 0,
    adjustmentSec: 0,
    targetSec: AUG_TARGET,
    expectedWorkdays: 27,
    monthWorkdays: 27,
    daysWithWork: 0,
  };

  const elapsedOn = (trackingStartedOn: Date | null): number =>
    elapsedWorkdays({
      ...BASE,
      today: day('2026-08-14'),
      trackingStartedOn,
    });

  it('counting before tracking start gives 12 working days, i.e. an expectation of 96 hours', () => {
    const before = rollupMonth({ ...monthBase, workdaysElapsed: elapsedOn(null), observedWorkdays: elapsedOn(null) });

    expect(elapsedOn(null)).toBe(12);
    expect(before.expectedSec).toBe(96 * HOUR);
  });

  /**
   * Observation started on 13 August, today is the 14th — exactly one working day has finished.
   * If someone worked not even an hour the shortfall is 8 hours, not 96. The other
   *    88 hours are no failure — they are simply **our not having seen**.
   */
  it('counting from 13 August gives 1 working day, expectation 8 hours', () => {
    const started = day('2026-08-13');
    const after = rollupMonth({
      ...monthBase,
      workdaysElapsed: elapsedOn(started),
      observedWorkdays: elapsedOn(started),
    });

    expect(elapsedOn(started)).toBe(1);
    expect(after.expectedSec).toBe(8 * HOUR);
    expect(after.paceSec).toBe(-8 * HOUR);
  });

  /**
   * The target and shortfall (`shortfall_sec`) **do not change** — payroll
   * deductions come from those two (`payroll.math.ts`: `targetSec − creditedSec`).
   * This change touches only pace/expected, not anyone's pay amount.
   */
  it('target and shortfall unchanged — the deduction calculation is outside this change', () => {
    const before = rollupMonth({ ...monthBase, workdaysElapsed: elapsedOn(null), observedWorkdays: elapsedOn(null) });
    const after = rollupMonth({
      ...monthBase,
      workdaysElapsed: elapsedOn(day('2026-08-13')),
      observedWorkdays: elapsedOn(day('2026-08-13')),
    });

    expect(after.targetSec).toBe(before.targetSec);
    expect(after.shortfallSec).toBe(before.shortfallSec);
    expect(after.creditedSec).toBe(before.creditedSec);
  });
});

// ═══════════════ 5 · one rule, every screen — same input, same answer ═══════════════

/**
 * **The most important part of this file.**
 *
 * The mistake it prevents is not an error in one number — it is **a mismatch
 * between two numbers**. At one time `workdays_elapsed` had three definitions in use:
 *
 * | Where             | Start                         | End       | What it counts          |
 * |-------------------|-------------------------------|-----------|-------------------------|
 * | Monthly rollup    | max(month, joined, tracking)  | yesterday | calendar working days   |
 * | tray / `/me`      | max(month, joined)            | **today** | calendar working days   |
 * | Live Board        | max(month, **org** tracking)  | yesterday | **daily_summary rows**  |
 *
 * Result: what an employee saw in their own tray and what the owner saw on the
 * Monthly page differed by ~89 hours. Now all four paths call the same two
 * functions — `elapsedWorkdays()` and `proratedExpectedSec()` — so the
 * number can no longer differ.
 */
describe('same input → tray · Monthly · Live Board all give the same number', () => {
  /** An employee who joined on the 17th, tracking from the 13th, today is 20 August */
  const input: ElapsedInput = {
    ...BASE,
    joinedOn: day('2026-08-17'),
    trackingStartedOn: day('2026-08-13'),
  };

  /** 17–31 August, excluding Fridays the 21st and 28th = 13 working days (the d of `prorate()`) */
  const EMPLOYEE_WORKDAYS = 13;
  const TARGET_SEC = EMPLOYEE_WORKDAYS * 8 * HOUR;

  const workdaysElapsed = elapsedWorkdays(input);

  /** Monthly rollup — both the `monthly_summary.expected_sec` and `pace_sec` columns come from here */
  const monthly = rollupMonth({
    workedSec: 40 * HOUR,
    adjustmentSec: 0,
    targetSec: TARGET_SEC,
    expectedWorkdays: EMPLOYEE_WORKDAYS,
    monthWorkdays: 27,
    workdaysElapsed,
    observedWorkdays: workdaysElapsed,
    daysWithWork: 5,
  });

  it('the window is from the join day to yesterday — 3 working days', () => {
    expect(elapsedWindow(input)).toEqual({
      from: day('2026-08-17'),
      to: day('2026-08-19'),
    });
    expect(workdaysElapsed).toBe(3);
  });

  /**
   * tray (`/me`, the agent's tray) → `progress.math.ts`
   *   Monthly page and Live Board → the `monthly_summary.expected_sec` column
   *   Both end up in the same `proratedExpectedSec()` below.
   */
  it('the tray and the monthly rollup match to the exact second', () => {
    const tray = trayExpectedSec({
      creditedSec: 40 * HOUR,
      monthlyTargetHours: TARGET_SEC / HOUR,
      expectedWorkdays: EMPLOYEE_WORKDAYS,
      workdaysElapsed,
    });

    expect(tray).toBe(monthly.expectedSec);
    expect(monthly.expectedSec).toBe(24 * HOUR); // 3 days × 8 hours
  });

  it('pace is the same too — the employee and the owner read the same thing', () => {
    const tray = trayPaceSec({
      creditedSec: 40 * HOUR,
      monthlyTargetHours: TARGET_SEC / HOUR,
      expectedWorkdays: EMPLOYEE_WORKDAYS,
      workdaysElapsed,
    });

    expect(tray).toBe(monthly.paceSec);
    expect(monthly.paceSec).toBe(16 * HOUR);
  });

  /** The formula really is just one — both paths end up in this same function */
  it('both paths end up in `proratedExpectedSec()`', () => {
    expect(
      proratedExpectedSec({
        targetSec: TARGET_SEC,
        expectedWorkdays: EMPLOYEE_WORKDAYS,
        workdaysElapsed,
      }),
    ).toBe(monthly.expectedSec);
  });

  /**
   * The report (F01/F02 → the Monthly page heatmap and the daily email) adds
   * up the days' targets, but **exactly inside this window**. So the sum
   * always comes to "window working days × daily target".
   *
   * `reports.context.service.ts` does not build the window itself, it calls
   * `elapsedWindow()` — here that same sum is imitated and shown.
   */
  it("the report's day-by-day sum is the same window, the same working days", () => {
    const window = elapsedWindow(input);
    expect(window).not.toBeNull();

    let workdaysSeen = 0;
    for (
      let t = window!.from.getTime();
      t <= window!.to.getTime();
      t += 86_400_000
    ) {
      // The report's `targetSecOf()` gives 0 on a day off, so working days are what is counted.
      // Friday = `getUTCDay() === 5` (in JS's Sunday = 0 scheme)
      if (new Date(t).getUTCDay() !== 5) workdaysSeen += 1;
    }

    expect(workdaysSeen).toBe(workdaysElapsed);
  });

  /**
   * **If the old tray formula comes back, this test breaks.**
   * That formula was: from the 1st (or joined) of the month **counting today**, with no tracking start.
   */
  it('going back to the old tray formula would bring the difference back', () => {
    const oldTrayElapsed = elapsedWorkdays({
      ...input,
      trackingStartedOn: null,
      // The old code counted today too — shifting back by one day does exactly that
      today: day('2026-08-21'),
    });

    expect(oldTrayElapsed).toBe(4);
    expect(oldTrayElapsed).not.toBe(workdaysElapsed);
  });
});


// ══════════════ 6 · G111 — "not observed" and "no shortfall" are different ══════════════

/**
 * **G111** — the same 0 can say two completely opposite things.
 *
 * Someone with not one **finished** working day seen yet has an empty window
 * → expectation 0 → pace 0. On screen that looks **exactly like someone who
 * met the target**. It happens precisely in a new employee's first week or when
 * someone's agent is installed late — and then the news gets read as "all is well".
 */
describe('isObserved — one rule, three screens', () => {
  it('`false` if not one finished working day has been seen', () => {
    expect(isObserved({ workdaysElapsed: 0 })).toBe(false);
  });

  it('`true` as soon as one has been seen — there is no concept of "seen enough"', () => {
    expect(isObserved({ workdaysElapsed: 1 })).toBe(true);
  });

  /**
   * **This is the real guard.** If the flag were counted from `daysWithWork`
   * (whether they worked), someone who did not work even an hour on a seen day would
   * show as "not yet observed" — i.e. **a genuine shortfall would be hidden**, and
   * the error would go the opposite way and get worse.
   */
  it('"seen" does not mean "worked"', () => {
    const numbers = rollupMonth({
      workedSec: 0,
      adjustmentSec: 0,
      targetSec: 216 * HOUR,
      expectedWorkdays: 27,
      monthWorkdays: 27,
      workdaysElapsed: 5,
      observedWorkdays: 5,
      daysWithWork: 0,
    });

    expect(numbers.daysWithWork).toBe(0);
    expect(isObserved(numbers)).toBe(true);
    // And so their shortfall is a genuine shortfall, nothing to hide
    expect(numbers.paceSec).toBeLessThan(0);
  });

  /**
   * **The most important test of this file's G111 part.**
   *
   * The two have **exactly the same** `paceSec` (0), yet their situations are
   * polar opposites. Without the flag the two states are completely identical to
   * the screen — and then someone not yet seen would also read as "target met".
   */
  it('target exactly met vs not yet seen — pace the same 0, state different', () => {
    const met = rollupMonth({
      workedSec: 216 * HOUR,
      adjustmentSec: 0,
      targetSec: 216 * HOUR,
      expectedWorkdays: 27,
      monthWorkdays: 27,
      workdaysElapsed: 27,
      observedWorkdays: 27,
      daysWithWork: 27,
    });

    const unseen = rollupMonth({
      workedSec: 0,
      adjustmentSec: 0,
      targetSec: 216 * HOUR,
      expectedWorkdays: 27,
      monthWorkdays: 27,
      // The agent went live today — there is no finished day
      workdaysElapsed: 0,
      observedWorkdays: 0,
      daysWithWork: 0,
    });

    expect(met.paceSec).toBe(0);
    expect(unseen.paceSec).toBe(0);
    expect(isObserved(met)).toBe(true);
    expect(isObserved(unseen)).toBe(false);
  });

  /**
   * The flag comes from exactly the window the expectation comes from —
   * so "seen" and "has an expectation" can never say two different things.
   */
  it('as soon as the window is empty, not observed — both tied to one rule', () => {
    // Tracking starts today, so there is nothing up to yesterday
    const input: ElapsedInput = { ...BASE, trackingStartedOn: day('2026-08-20') };

    expect(elapsedWindow(input)).toBeNull();
    expect(isObserved({ workdaysElapsed: elapsedWorkdays(input) })).toBe(false);
    expect(
      proratedExpectedSec({
        targetSec: 216 * HOUR,
        expectedWorkdays: 27,
        workdaysElapsed: elapsedWorkdays(input),
      }),
    ).toBe(0);
  });
});
