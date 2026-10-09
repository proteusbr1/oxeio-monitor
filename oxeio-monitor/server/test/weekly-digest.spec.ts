import type { Mailer } from '../src/mail/mailer';
import type { MailRecipients } from '../src/mail/recipients.service';
import { TeamsChannel } from '../src/alerts/teams.channel';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type {
  TelegramChannel,
  TelegramOutcome,
} from '../src/alerts/telegram.channel';
import { WeeklyDigestJob } from '../src/digest/weekly.job';
import {
  TELEGRAM_TEXT_LIMIT,
  buildWeekly,
  isPrivateChatId,
  weeklyGateOf,
  weeklyMessage,
  weeklyScheduleOf,
  weeklyWindow,
  type ObservedDay,
  type WeeklySource,
} from '../src/digest/weekly.rules';
import { WeeklyDigestService } from '../src/digest/weekly.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { ReportsService } from '../src/reports/reports.service';
import type {
  AttendanceReport,
  AttendanceRow,
  ReportMeta,
  SummaryReport,
  SummaryRow,
} from '../src/reports/reports.types';

/**
 * R3 — the weekly summary (to the owner's Telegram).
 *
 * The mistakes here are all **silent**: the message still went out, only what
 * was inside was wrong. The biggest ones —
 *   1. The targets of days **before** tracking started counted in the
 *      expectation, so the very first message would name people as "32 hours
 *      behind" (the main test of this file),
 *   2. Merging "no row" with "row exists, 0 hours" — then real absence while
 *      the agent was running would never reach the "Behind" list,
 *   3. The names of employees dropped from the report not reaching the message,
 *   4. The whole message failing to arrive after exceeding 4096 characters,
 *   5. Trimming that cuts the **count** too ("4 behind" when it is really 12).
 */

// ── fixtures ────────────────────────────────────────────────────────────────

/** Window: 8–14 August 2026 (Sat → Fri), today = the 14th */
const WINDOW_DATES = [
  '2026-08-08',
  '2026-08-09',
  '2026-08-10',
  '2026-08-11',
  '2026-08-12',
  '2026-08-13',
  '2026-08-14',
] as const;

const TODAY_DATE = '2026-08-14';

/**
 * The fixture's weekly day off is **Sunday**, not Friday — deliberate. That
 * keeps today (Friday the 14th) a working day, so the "leave out today's
 * target" rule actually gets tested. If the day off fell on today, 0 hours
 * would be left out, and every test would stay green even if the rule were broken.
 *
 * A Friday-off policy is tested separately in the "first message" block
 * below — because that layout is where the bug was most dangerous.
 */
const OFF_DATE = '2026-08-09';

/** 6 working days × 8 hours = 48 — matches the target in `week()` */
const DAY_TARGET = 8;

function att(over: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    employeeId: 1,
    empCode: 'OX-001',
    fullName: 'Jane Doe',
    receivesTasks: false,
    department: null,
    date: TODAY_DATE,
    dayType: 'workday',
    status: 'worked',
    // Nobody in the sample is on leave — this fixture makes no claim about G130
    onLeave: false,
    workedHours: 8,
    presenceHours: 8,
    idleHours: 0,
    adjustmentHours: 0,
    tasksDone: null,
    creditedHours: 8,
    targetHours: DAY_TARGET,
    ...over,
  };
}

/**
 * One employee's F01 rows, one for each day of the window.
 *
 * `buildWeekly()` does **not read the hours** of these rows, only `date` and
 * `targetHours` — hours come from F02 (adding from two sources would
 * accumulate rounded values and show two numbers on two screens). So the
 * hours here are just junk, and that is fine.
 */
function daysOf(
  employeeId = 1,
  empCode = 'OX-001',
  dates: readonly string[] = WINDOW_DATES,
): AttendanceRow[] {
  return dates.map((date) =>
    att({
      employeeId,
      empCode,
      date,
      dayType: date === OFF_DATE ? 'weekly_off' : 'workday',
      targetHours: date === OFF_DATE ? 0 : DAY_TARGET,
    }),
  );
}

/** The `daily_summary` rows for those days exist — i.e. the days were measured */
function seenOn(
  employeeId = 1,
  dates: readonly string[] = WINDOW_DATES,
): ObservedDay[] {
  return dates.map((date) => ({ employeeId, date }));
}

function week(over: Partial<SummaryRow> = {}): SummaryRow {
  return {
    employeeId: 1,
    empCode: 'OX-001',
    fullName: 'Jane Doe',
    bucket: '2026-08-08',
    bucketStart: '2026-08-08',
    bucketEnd: TODAY_DATE,
    workdays: 6,
    daysWithWork: 6,
    workedHours: 48,
    adjustmentHours: 0,
    creditedHours: 48,
    // 6 working days × 8 hours — **including today**
    targetHours: 48,
    shortfallHours: 0,
    overtimeHours: 0,
    ...over,
  };
}

/** F02 row → a source where the whole window has been observed */
function fullyObserved(
  rows: SummaryRow[],
  dates: readonly string[] = WINDOW_DATES,
): Pick<WeeklySource, 'week' | 'daily' | 'observed'> {
  return {
    week: rows,
    daily: rows.flatMap((r) => daysOf(r.employeeId, r.empCode, dates)),
    observed: rows.flatMap((r) => seenOn(r.employeeId, dates)),
  };
}

function source(over: Partial<WeeklySource> = {}): WeeklySource {
  return {
    from: '2026-08-08',
    to: TODAY_DATE,
    days: 7,
    ...fullyObserved([week()]),
    excludedEmployees: [],
    ...over,
  };
}

/** n employees, in the same shape — only code and name differ */
function staff(
  n: number,
  over: (i: number) => Partial<SummaryRow> = () => ({}),
): SummaryRow[] {
  return Array.from({ length: n }, (_, i) =>
    week({
      employeeId: i + 1,
      empCode: `OX-${String(i + 1).padStart(3, '0')}`,
      // A long non-Latin name — testing length with ASCII "Jane Doe"
      //    would miss the most important case (a team with non-Latin names)
      fullName: `山田太郎・ガルシア・ロドリゲス・フェルナンデス・ゴンサレス ${i + 1}`,
      ...over(i),
    }),
  );
}

// ── schedule ────────────────────────────────────────────────────────────────

describe('weeklyScheduleOf — day and hour from env', () => {
  it('Friday 6 p.m. when nothing is given', () => {
    const s = weeklyScheduleOf(undefined, undefined);

    expect(s.isoDay).toBe(5);
    expect(s.hour).toBe(18);
    expect(s.expression).toBe('0 0 18 * * 5');
    expect(s.ignored).toEqual([]);
  });

  it('given values are respected', () => {
    expect(weeklyScheduleOf('1', '9').expression).toBe('0 0 9 * * 1');
    expect(weeklyScheduleOf(' 3 ', ' 0 ').expression).toBe('0 0 0 * * 3');
  });

  it('ISO 7 (Sunday) is 0 in cron — without reconciling it the message would never go out', () => {
    const s = weeklyScheduleOf('7', '18');

    expect(s.isoDay).toBe(7);
    expect(s.expression).toBe('0 0 18 * * 0');
  });

  it('a wrong value does not crash — default, but not silently', () => {
    const s = weeklyScheduleOf('Friday', '25');

    expect(s.isoDay).toBe(5);
    expect(s.hour).toBe(18);
    expect(s.ignored).toHaveLength(2);
    expect(s.ignored[0]).toContain('WEEKLY_DIGEST_DAY');
    expect(s.ignored[1]).toContain('WEEKLY_DIGEST_HOUR');
  });

  it('"18abc" is not 18 — a half-read value would let the typo go uncaught forever', () => {
    const s = weeklyScheduleOf('5', '18abc');

    expect(s.hour).toBe(18); // the default, coincidentally the same
    expect(s.ignored).toHaveLength(1);
  });

  it('days outside the range (0 or 8) are rejected', () => {
    expect(weeklyScheduleOf('0').ignored).toHaveLength(1);
    expect(weeklyScheduleOf('8').ignored).toHaveLength(1);
  });
});

describe('weeklyWindow — the last 7 days, by work-zone reckoning', () => {
  it('7 days back including today', () => {
    const w = weeklyWindow(new Date('2026-08-14T12:00:00Z'));

    expect(w).toEqual({ from: '2026-08-08', to: '2026-08-14', days: 7 });
  });

  it('"today" means today in the work zone — even if it is still yesterday in UTC', () => {
    // 12:30 a.m. on 15 August in the work zone (UTC+6), still 6:30 p.m. on 14 August in UTC
    const w = weeklyWindow(new Date('2026-08-14T18:30:00Z'));

    expect(w.to).toBe('2026-08-15');
    expect(w.from).toBe('2026-08-09');
  });

  it('crosses a month boundary', () => {
    expect(weeklyWindow(new Date('2026-09-02T06:00:00Z')).from).toBe(
      '2026-08-27',
    );
  });
});

// ── the week's arithmetic ───────────────────────────────────────────────────

describe("buildWeekly — today's target is left out of the expectation", () => {
  it("the day is not finished, so today's target is not counted", () => {
    const w = buildWeekly(source());
    const row = w.rows[0];

    expect(row.targetHours).toBe(48);
    expect(row.expectedHours).toBe(40); // 48 − today's 8
    expect(row.paceHours).toBe(8); // 48 hours worked − 40 expected
    expect(row.standing).toBe('on_track');
    // The whole window was observed — no gap anywhere
    expect(row.observedDays).toBe(7);
    expect(row.unobservedDays).toBe(0);
    expect(row.countedFrom).toBe('2026-08-08');
  });

  it('counting the target of today would show this employee as "behind" — it does not', () => {
    // The whole week is fine, only today is still running (3 hours so far)
    const w = buildWeekly(
      source(
        fullyObserved([
          week({ creditedHours: 43, workedHours: 43, daysWithWork: 6 }),
        ]),
      ),
    );

    expect(w.rows[0].paceHours).toBe(3);
    expect(w.behind).toHaveLength(0);
  });

  it('if not working today (left yesterday) the whole target is the expectation', () => {
    // F01 has no row for today — the day after leaving does not appear in the report
    const upTo13 = WINDOW_DATES.slice(0, 6);
    const w = buildWeekly(
      source(
        fullyObserved(
          [week({ workdays: 5, targetHours: 40, creditedHours: 40 })],
          upTo13,
        ),
      ),
    );

    expect(w.rows[0].expectedHours).toBe(40);
    expect(w.rows[0].paceHours).toBe(0);
    expect(w.rows[0].unobservedDays).toBe(0);
  });

  it('really being behind is caught', () => {
    const w = buildWeekly(
      source(
        fullyObserved([
          week({ creditedHours: 30, workedHours: 30, daysWithWork: 4 }),
        ]),
      ),
    );

    expect(w.behind).toHaveLength(1);
    expect(w.behind[0].paceHours).toBe(-10);
    expect(w.rows[0].standing).toBe('behind');
  });

  it('a shortfall of a few minutes does not put anyone on the "Behind" list', () => {
    // With a target like 208 ÷ 27, both day-hours and week-hours are rounded
    // to two decimals, and the subtraction can be off by a couple of minutes
    const w = buildWeekly(
      source(
        fullyObserved([
          week({ creditedHours: 39.98, workedHours: 39.98, daysWithWork: 6 }),
        ]),
      ),
    );

    expect(w.rows[0].paceHours).toBe(-0.02);
    // The number stays truthful, but the box is "on track"
    expect(w.rows[0].standing).toBe('on_track');
    expect(w.behind).toHaveLength(0);
  });
});

describe('buildWeekly — a week split across two buckets', () => {
  it('the buckets are added, the last one is not taken', () => {
    // Someone's weekly day off is on another day — the 7-day window falls in two week-buckets
    const w = buildWeekly(
      source({
        ...fullyObserved([week()]),
        week: [
          week({
            bucket: '2026-08-01',
            workdays: 2,
            daysWithWork: 2,
            creditedHours: 16,
            targetHours: 16,
          }),
          week({
            bucket: '2026-08-08',
            workdays: 4,
            daysWithWork: 4,
            creditedHours: 32,
            targetHours: 32,
          }),
        ],
      }),
    );

    expect(w.rows).toHaveLength(1);
    expect(w.rows[0].creditedHours).toBe(48);
    expect(w.rows[0].targetHours).toBe(48);
    expect(w.rows[0].workdays).toBe(6);
    expect(w.rows[0].daysWithWork).toBe(6);
    // Even with two buckets there are seven day rows — so expectation is 48 − today's 8
    expect(w.rows[0].expectedHours).toBe(40);
  });
});

// ══════════ partly-observed week — the main test of this file ══════════

describe('buildWeekly — days before tracking start are not in the expectation', () => {
  /**
   * **This installation's very first message stands here.**
   *
   * Tracking began on 13 August 2026, the default schedule is Friday 6 p.m.,
   * and 14 August is a Friday. So the first window is 8–14 August, of which
   * the 8th–12th nobody observed. Here the weekly day off is **Friday** (as in
   * the original installation's policy), so today's target is 0 — before the fix, exactly that zero
   * was what got left out, and the expectation came to the full 48 hours.
   * Against 8 hours of work the message would say **"40 hours behind"**, by
   * name, in the owner's Telegram — for days when the agent was not even
   * installed. And a Telegram message cannot be taken back.
   */
  const FRIDAY_OFF_DAYS: AttendanceRow[] = WINDOW_DATES.map((date) =>
    att({
      date,
      // Friday 14 August = weekly day off, target 0
      dayType: date === TODAY_DATE ? 'weekly_off' : 'workday',
      targetHours: date === TODAY_DATE ? 0 : DAY_TARGET,
    }),
  );

  /** Tracking began on the 13th — there are no rows for any earlier day */
  const firstWeek = (): WeeklySource =>
    source({
      daily: FRIDAY_OFF_DAYS,
      observed: seenOn(1, ['2026-08-13', '2026-08-14']),
      week: [
        week({
          workdays: 6,
          targetHours: 48,
          daysWithWork: 1,
          workedHours: 8,
          creditedHours: 8,
        }),
      ],
    });

  it('expectation is 8 hours, not 48 — unobserved days are not a shortfall either', () => {
    const row = buildWeekly(firstWeek()).rows[0];

    // The 13th is the only counted day (the 14th is today, and the rest were never observed)
    expect(row.expectedHours).toBe(8);
    expect(row.paceHours).toBe(0);
    expect(row.standing).toBe('on_track');
  });

  it('which day counting began from is kept in the row', () => {
    const row = buildWeekly(firstWeek()).rows[0];

    expect(row.countedFrom).toBe('2026-08-13');
    expect(row.observedDays).toBe(2); // the 13th and 14th
    expect(row.unobservedDays).toBe(5); // the 8th–12th
  });

  it('and it is stated in the message too — otherwise the adjustment is an invisible assumption', () => {
    const m = weeklyMessage(buildWeekly(firstWeek()), 'Acme');

    expect(m.text).toContain('counted from 2026-08-13');
    expect(m.text).toContain('Not every day was observed — 1 of 1 staff');
    expect(m.text).toContain('neither as');
    // The sentence that must never go out
    expect(m.text).not.toContain('behind');
  });

  it('everyone together — not one name lands in the "Behind" box in the first message', () => {
    const rows = staff(4, () => ({
      daysWithWork: 1,
      workedHours: 8,
      creditedHours: 8,
    }));
    const w = buildWeekly(
      source({
        week: rows,
        daily: rows.flatMap((r) =>
          FRIDAY_OFF_DAYS.map((d) => ({
            ...d,
            employeeId: r.employeeId,
            empCode: r.empCode,
          })),
        ),
        observed: rows.flatMap((r) =>
          seenOn(r.employeeId, ['2026-08-13', '2026-08-14']),
        ),
      }),
    );

    expect(w.behind).toHaveLength(0);
    expect(w.onTrack).toHaveLength(4);
    expect(w.totals.withGaps).toBe(4);
  });

  it('a gap in the middle is left out too — the server was down for a day', () => {
    // Every day observed except the 11th; 11 working days, target 8
    const seen = WINDOW_DATES.filter((d) => d !== '2026-08-11');
    const w = buildWeekly(
      source({
        observed: seenOn(1, seen),
        week: [week({ creditedHours: 32, workedHours: 32, daysWithWork: 4 })],
      }),
    );
    const row = w.rows[0];

    // 48 − today's 8 − the unobserved 11th's 8 = 32
    expect(row.expectedHours).toBe(32);
    expect(row.paceHours).toBe(0);
    expect(row.countedFrom).toBe('2026-08-08'); // the start is still right
    expect(row.unobservedDays).toBe(1);

    const m = weeklyMessage(w, 'Acme');
    expect(m.text).toContain('1 day not observed');
    expect(m.text).not.toContain('counted from');
  });

  it('if not a single day can be counted, the expectation is exactly 0 — not "nearly 0"', () => {
    // Tracking began today: today's row exists, but today is not counted
    const w = buildWeekly(
      source({
        observed: seenOn(1, [TODAY_DATE]),
        week: [
          week({ creditedHours: 0, workedHours: 0, daysWithWork: 0 }),
        ],
      }),
    );
    const row = w.rows[0];

    expect(row.countedFrom).toBeNull();
    expect(row.expectedHours).toBe(0);
    expect(row.paceHours).toBe(0);
    // A row exists, so it is not "not observed" — with a zero expectation they are not behind either
    expect(row.recorded).toBe(true);
    expect(w.behind).toHaveLength(0);
  });

  it('without F01 rows the arithmetic is not loosened — the whole target is the expectation', () => {
    // Safeguard: if for some reason the day-by-day rows do not arrive, it goes back to the old behaviour,
    // and does not silently tell everyone "on track"
    const w = buildWeekly(
      source({
        daily: [],
        observed: [],
        week: [week({ creditedHours: 10, workedHours: 10, daysWithWork: 2 })],
      }),
    );

    expect(w.rows[0].expectedHours).toBe(48);
    expect(w.rows[0].standing).toBe('behind');
  });
});

// ══════════ no row vs a row with 0 hours ══════════

describe('buildWeekly — "no row" and "0 hours" are not the same', () => {
  it('not a single row → not "behind", "not observed"', () => {
    const w = buildWeekly(
      source({
        observed: [],
        week: [week({ creditedHours: 0, workedHours: 0, daysWithWork: 0 })],
      }),
    );

    expect(w.rows[0].standing).toBe('no_records');
    expect(w.rows[0].recorded).toBe(false);
    expect(w.behind).toHaveLength(0);
    expect(w.noRecords).toHaveLength(1);
    expect(w.totals.withData).toBe(0);
  });

  it('a row exists but 0 hours → this is observation, so "Behind"', () => {
    // The agent is running fine, daily rows were written — but no work was done.
    // Before the fix this person too would go to the "no record" box, so
    //    real absence would never catch anyone's eye.
    const w = buildWeekly(
      source({
        week: [week({ creditedHours: 0, workedHours: 0, daysWithWork: 0 })],
      }),
    );

    expect(w.rows[0].recorded).toBe(true);
    expect(w.rows[0].observedDays).toBe(7);
    expect(w.rows[0].standing).toBe('behind');
    expect(w.behind[0].paceHours).toBe(-40);
    expect(w.noRecords).toHaveLength(0);
    expect(w.totals.withData).toBe(1);
  });

  it('and the message uses two different words for them', () => {
    const observedZero = weeklyMessage(
      buildWeekly(
        source({
          week: [week({ creditedHours: 0, workedHours: 0, daysWithWork: 0 })],
        }),
      ),
      'Acme',
    );
    const nothingSeen = weeklyMessage(
      buildWeekly(
        source({
          observed: [],
          week: [week({ creditedHours: 0, workedHours: 0, daysWithWork: 0 })],
        }),
      ),
      'Acme',
    );

    expect(observedZero.text).toContain('observed, no work recorded');
    expect(observedZero.text).toContain('Behind (1)');
    expect(observedZero.text).not.toContain('Not observed (');

    expect(nothingSeen.text).toContain('Not observed (1)');
    expect(nothingSeen.text).toContain('does NOT mean zero work');
    expect(nothingSeen.text).not.toContain('observed, no work recorded');
  });

  it("the owner's adjustment counts as observation too — even with no row", () => {
    // worked_sec is zero, but the owner entered 40 hours by hand
    const w = buildWeekly(
      source({
        observed: [],
        week: [
          week({
            workedHours: 0,
            daysWithWork: 0,
            adjustmentHours: 40,
            creditedHours: 40,
          }),
        ],
      }),
    );

    expect(w.rows[0].recorded).toBe(true);
    expect(w.rows[0].standing).toBe('on_track');
    expect(w.noRecords).toHaveLength(0);
  });

  it('"off" if there is no working day in the whole window (a long public holiday)', () => {
    const holidays = WINDOW_DATES.map((date) =>
      att({ date, dayType: 'holiday', targetHours: 0, creditedHours: 0 }),
    );
    const w = buildWeekly(
      source({
        daily: holidays,
        week: [
          week({
            workdays: 0,
            daysWithWork: 0,
            workedHours: 0,
            creditedHours: 0,
            targetHours: 0,
          }),
        ],
      }),
    );

    expect(w.rows[0].standing).toBe('off');
    expect(w.off).toHaveLength(1);
    expect(w.noRecords).toHaveLength(0);
    expect(w.behind).toHaveLength(0);
  });
});

describe('buildWeekly — totals and order', () => {
  it('total hours and whose data exists', () => {
    const rows = [
      week({ employeeId: 1, empCode: 'OX-001', creditedHours: 40 }),
      week({
        employeeId: 2,
        empCode: 'OX-002',
        creditedHours: 0,
        workedHours: 0,
        daysWithWork: 0,
      }),
    ];
    const w = buildWeekly(
      source({
        week: rows,
        daily: rows.flatMap((r) => daysOf(r.employeeId, r.empCode)),
        // The second person has no row at all — nothing is known about them
        observed: seenOn(1),
      }),
    );

    expect(w.totals.employees).toBe(2);
    expect(w.totals.withData).toBe(1);
    expect(w.totals.hoursRecorded).toBe(40);
    expect(w.totals.withGaps).toBe(1);
  });

  it('rows in employee-code order, the "Behind" list with the most behind first', () => {
    const w = buildWeekly(
      source(
        fullyObserved([
          week({ employeeId: 2, empCode: 'OX-002', creditedHours: 30 }),
          week({ employeeId: 1, empCode: 'OX-001', creditedHours: 20 }),
          week({ employeeId: 3, empCode: 'OX-003', creditedHours: 10 }),
        ]),
      ),
    );

    expect(w.rows.map((r) => r.empCode)).toEqual([
      'OX-001',
      'OX-002',
      'OX-003',
    ]);
    // All three are behind (expectation 40), but the order puts the most behind first
    expect(w.behind.map((r) => r.empCode)).toEqual([
      'OX-003',
      'OX-001',
      'OX-002',
    ]);
  });
});

// ══════════ employees dropped from the report ══════════

describe('buildWeekly / weeklyMessage — employees who were dropped', () => {
  it('names go in the message — they do not quietly vanish', () => {
    const w = buildWeekly(
      source({ excludedEmployees: ['Jordan Lee', '山田花子'] }),
    );
    const m = weeklyMessage(w, 'Acme');

    expect(w.totals.excluded).toBe(2);
    expect(m.text).toContain('Not in this report (2)');
    expect(m.text).toContain('Jordan Lee');
    expect(m.text).toContain('山田花子');
    // Both why they were dropped and what to do to bring them back are written
    expect(m.text).toContain('inactive with no leaving date');
  });

  it('even if the whole team is dropped the names go — this is the biggest news here', () => {
    // `employees === 0`, i.e. the "Nobody was on the payroll" branch
    const w = buildWeekly(
      source({
        week: [],
        daily: [],
        observed: [],
        excludedEmployees: ['Jordan Lee', 'Sam Rivera'],
      }),
    );
    const m = weeklyMessage(w, 'Acme');

    expect(m.text).toContain('Nobody was on the payroll');
    expect(m.text).toContain('Not in this report (2)');
    expect(m.text).toContain('Jordan Lee');
  });

  it('when nobody is dropped the box does not exist', () => {
    const m = weeklyMessage(buildWeekly(source()), 'Acme');

    expect(m.text).not.toContain('Not in this report');
    expect(m.text).not.toContain('inactive with no leaving date');
  });

  it('even if names are trimmed the number in the heading stays', () => {
    const w = buildWeekly(
      source({
        ...fullyObserved(staff(15)),
        excludedEmployees: Array.from({ length: 9 }, (_, i) => `Excluded ${i}`),
      }),
    );
    const cut = weeklyMessage(w, 'Acme', 900);

    expect(cut.text).toContain('Not in this report (9)');
    expect(cut.hidden).toBeGreaterThan(0);
  });
});

// ── message ─────────────────────────────────────────────────────────────────

describe('weeklyMessage — empty week', () => {
  it('"0 hours" is not written when nobody was working', () => {
    const m = weeklyMessage(
      buildWeekly(source({ week: [], daily: [], observed: [] })),
      'Acme',
    );

    expect(m.text).toContain('Nobody was on the payroll');
    expect(m.text).not.toContain('0.00h');
    expect(m.hidden).toBe(0);
  });

  it('if nobody has a single row all week, the team is not told "0 hours"', () => {
    // The agent update is stuck, or the server was only just installed — tracking did not exist
    const rows = staff(4, () => ({
      creditedHours: 0,
      workedHours: 0,
      daysWithWork: 0,
    }));
    const w = buildWeekly(
      source({
        week: rows,
        daily: rows.flatMap((r) => daysOf(r.employeeId, r.empCode)),
        observed: [],
      }),
    );
    const m = weeklyMessage(w, 'Acme');

    expect(m.text).toContain('nothing was observed for any of the 4 staff');
    expect(m.text).not.toContain('0.00h recorded');
    expect(m.text).toContain('Not observed (4)');
    // The reason must be written in the message itself — otherwise the reader
    //    would assume "nobody worked", which is the most harmful misreading
    expect(m.text).toContain('does NOT mean zero work');
  });
});

describe('weeklyMessage — one employee', () => {
  it('name, hours, how far ahead, and on how many days work was done', () => {
    const m = weeklyMessage(buildWeekly(source()), 'Acme');

    expect(m.text).toContain('Acme — Weekly summary');
    expect(m.text).toContain('2026-08-08 → 2026-08-14 (GMT-6, 7 days)');
    expect(m.text).toContain('48.00h recorded · 1 of 1 staff have data');
    expect(m.text).toContain('On track (1)');
    expect(m.text).toContain('Jane Doe (OX-001) — 48.00h · +8.00 · 6/6 days');
    expect(m.hidden).toBe(0);
    // The whole week was observed — no extra explanation needed
    expect(m.text).not.toContain('Not every day was observed');
    expect(m.text).not.toContain('counted from');
  });

  it('when behind, how far behind is what is written', () => {
    const w = buildWeekly(
      source(
        fullyObserved([
          week({ creditedHours: 30, workedHours: 30, daysWithWork: 4 }),
        ]),
      ),
    );
    const m = weeklyMessage(w, 'Acme');

    expect(m.text).toContain('Behind (1)');
    expect(m.text).toContain(
      'Jane Doe (OX-001) — 30.00h · 10.00 behind · 4/6 days',
    );
  });

  it('"+-0.02" is never written — the sign is placed separately', () => {
    const w = buildWeekly(
      source(
        fullyObserved([
          week({ creditedHours: 39.98, workedHours: 39.98, daysWithWork: 6 }),
        ]),
      ),
    );
    const m = weeklyMessage(w, 'Acme');

    expect(m.text).not.toContain('+-');
    expect(m.text).toContain('-0.02');
  });

  it('an empty box is not shown — no reason to make people read "Behind (0)"', () => {
    const m = weeklyMessage(buildWeekly(source()), 'Acme');

    expect(m.text).not.toContain('Behind (0)');
    expect(m.text).not.toContain('Not observed (0)');
    expect(m.text).not.toContain('Off all week (0)');
  });

  it('a newline inside a name cannot break the message structure', () => {
    const w = buildWeekly(
      source(fullyObserved([week({ fullName: 'Jane\nDoe' })])),
    );
    const m = weeklyMessage(w, 'Acme');

    expect(m.text).toContain('Jane Doe (OX-001)');
    // Every row is exactly one line — otherwise the trimming arithmetic would break too
    expect(m.text.split('\n').filter((l) => l.includes('OX-001'))).toHaveLength(
      1,
    );
  });
});

describe('weeklyMessage — trimming', () => {
  /**
   * 15 people **do not normally exceed 4096** — even with long non-Latin names
   * the message stays around two thousand. So the trimming machinery is tested
   * here with a small limit; the real 4096 test is in the big-team tests below.
   * Without the limit being a parameter, there would be no way to verify this behaviour.
   */
  it('15 people — when the limit is small, names are trimmed and "… and N more" is added', () => {
    const w = buildWeekly(source(fullyObserved(staff(15))));
    const full = weeklyMessage(w, 'Acme');

    expect(full.hidden).toBe(0);
    expect(full.text.length).toBeLessThan(TELEGRAM_TEXT_LIMIT);

    const cut = weeklyMessage(w, 'Acme', 900);

    expect(cut.text.length).toBeLessThanOrEqual(900);
    expect(cut.hidden).toBeGreaterThan(0);
    expect(cut.text).toContain(`… and ${cut.hidden} more`);
  });

  it('even when trimmed, the **number** in the heading stays the real one', () => {
    const w = buildWeekly(source(fullyObserved(staff(15))));
    const cut = weeklyMessage(w, 'Acme', 700);

    // All 15 are on track — even with names cut, the number never lies
    expect(cut.text).toContain('On track (15)');
    expect(cut.text).toContain('15 of 15 staff have data');
  });

  it('the "behind" box is trimmed last of all — that is the one people read to act on', () => {
    const rows = [
      ...staff(10),
      ...staff(2, () => ({ creditedHours: 10, workedHours: 10 })).map(
        (r, i) => ({
          ...r,
          employeeId: 100 + i,
          empCode: `OX-1${String(i).padStart(2, '0')}`,
        }),
      ),
    ];
    const cut = weeklyMessage(buildWeekly(source(fullyObserved(rows))), 'Acme', 800);

    expect(cut.hidden).toBeGreaterThan(0);
    // Two are behind — both their names survive
    expect(cut.text).toContain('OX-100');
    expect(cut.text).toContain('OX-101');
  });
});

describe('weeklyMessage — the length limit is never exceeded', () => {
  /**
   * If Telegram receives more than 4096 characters the whole call is an HTTP
   * 400 — i.e. the week's summary would reach **nobody**, and the failure
   * would show only in the server log. So the limit is verified for teams of every size.
   *
   * It is measured in `String.length`, not bytes — Telegram counts UTF-16 code
   *    units, and a CJK character is 3 bytes in UTF-8. Counting bytes would
   *    needlessly cut two thirds of the names.
   */
  for (const n of [1, 15, 40, 120, 500]) {
    it(`${n} employees`, () => {
      const rows = staff(n, (i) => ({
        // Some ahead, some behind, some with no record
        creditedHours: i % 3 === 0 ? 48 : i % 3 === 1 ? 20 : 0,
        workedHours: i % 3 === 2 ? 0 : 48,
        daysWithWork: i % 3 === 2 ? 0 : 6,
      }));
      const w = buildWeekly(
        source({
          week: rows,
          daily: rows.flatMap((r) => daysOf(r.employeeId, r.empCode)),
          // Every third person has no row at all, and one person's week
          //    started midway — so every explanation line is in the message at once,
          //    and still the limit is not exceeded
          observed: rows.flatMap((r, i) =>
            i % 3 === 2
              ? []
              : seenOn(
                  r.employeeId,
                  i % 3 === 1 ? WINDOW_DATES.slice(4) : WINDOW_DATES,
                ),
          ),
          excludedEmployees: Array.from(
            { length: Math.min(n, 5) },
            (_, i) => `報告から除外された従業員 ${i}`,
          ),
        }),
      );
      const m = weeklyMessage(w, 'oXeio Monitoring');

      expect(m.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      // The footnote (how to read it) is never lost
      expect(m.text).toContain('How to read this');
    });
  }

  it('even if someone puts a novel in ORG_NAME, the limit is not exceeded', () => {
    const w = buildWeekly(source(fullyObserved(staff(20))));
    const m = weeklyMessage(w, '漢'.repeat(5000));

    expect(m.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });

  it('no domain, app name or screenshot path ever goes into the message', () => {
    const m = weeklyMessage(buildWeekly(source()), 'Acme');

    expect(m.text).not.toMatch(/https?:\/\//);
    expect(m.text).not.toMatch(/\.(com|net|org|exe|png|jpg)\b/);
  });
});

// ── service and job (without a DB) ─────────────────────────────────────────

const meta: ReportMeta = {
  from: '2026-08-08',
  to: TODAY_DATE,
  requestedTo: TODAY_DATE,
  clampedToToday: false,
  days: 7,
  generatedAt: '2026-08-14T12:00:00.000Z',
  excludedEmployees: [],
  targetHoursInRange: {},
  // These two do not read the weekly summary — they only fill `ReportMeta`
  expectedHours: {},
  approximateHolidayDates: [],
  // Nobody in the sample is 'unobserved' — this fixture makes no claim about G110/G111
  observed: {},
  trackedFrom: {},
};

interface Stub {
  service: WeeklyDigestService;
  /** What was sent to Telegram */
  sent: string[];
  /** Which ranges were requested from `ReportsService`, in call order */
  calls: { report: string; from: string; to: string; groupBy?: string }[];
  /** Which range was requested from `daily_summary` */
  observedQueries: { gte: Date; lte: Date }[];
}

function makeService(
  over: {
    outcome?: TelegramOutcome;
    env?: Record<string, string>;
    reports?: Partial<ReportsService>;
    /** Which days have rows (default: all seven) */
    observedDates?: readonly string[];
    excludedEmployees?: string[];
  } = {},
): Stub {
  const sent: string[] = [];
  const calls: Stub['calls'] = [];
  const observedQueries: Stub['observedQueries'] = [];

  const reportMeta: ReportMeta = {
    ...meta,
    excludedEmployees: over.excludedEmployees ?? [],
  };

  const reports = {
    attendance: (q: { from: string; to: string }) => {
      calls.push({ report: 'attendance', from: q.from, to: q.to });
      return Promise.resolve({
        meta: reportMeta,
        rows: daysOf(),
        totals: {
          employees: 1,
          rows: 7,
          workedHours: 48,
          creditedHours: 48,
          targetHours: 48,
          daysWithWork: 6,
        },
      } satisfies AttendanceReport);
    },
    summary: (q: { from: string; to: string; groupBy?: string }) => {
      calls.push({
        report: 'summary',
        from: q.from,
        to: q.to,
        groupBy: q.groupBy,
      });
      return Promise.resolve({
        meta: reportMeta,
        groupBy: 'week',
        overtimeNote: '',
        rows: [week()],
      } satisfies SummaryReport);
    },
    ...over.reports,
  } as unknown as ReportsService;

  const dates = over.observedDates ?? WINDOW_DATES;

  const prisma = {
    dailySummary: {
      findMany: (q: { where: { workDate: { gte: Date; lte: Date } } }) => {
        observedQueries.push(q.where.workDate);
        return Promise.resolve(
          dates.map((date) => ({
            employeeId: 1,
            workDate: new Date(`${date}T00:00:00.000Z`),
          })),
        );
      },
    },
  } as unknown as PrismaService;

  const telegram = {
    send: (text: string) => {
      sent.push(text);
      return Promise.resolve(over.outcome ?? 'sent');
    },
    // Deliberately **absent**: `runOnce()`. Calling it on this stub would break
    //    the test — and that is wanted, because if the digest's `TelegramChannel`
    //    instance ran the alert sweep, every alert would go out twice.
  } as unknown as TelegramChannel;

  /**
   * Teams is assumed not configured — all tests in this file are about
   *    Telegram behaviour, and pulling Teams in would blur the meaning of every
   *    claim. Teams' own shape is pinned in `teams-card.spec.ts`.
   */
  const teams = {
    configured: false,
    send: () => Promise.resolve('not_configured' as const),
  } as unknown as TeamsChannel;

  /**
   * SMTP is assumed not configured — the tests in this file are about
   *    Telegram behaviour. The rule for choosing email recipients is pinned
   *    separately in `recipients.rules.spec.ts`, where it is the only question.
   */
  const mailer = {
    isConfigured: async () => false,
    send: () => Promise.resolve('not_configured' as const),
  } as unknown as Mailer;

  const config = {
    get: (key: string) => over.env?.[key],
  } as unknown as ConfigService;

  const recipients = {
    for: async () => ['owner@x.test'],
  } as unknown as MailRecipients;

  return {
    service: new WeeklyDigestService(reports, prisma, telegram, teams, mailer, recipients, config),
    sent,
    calls,
    observedQueries,
  };
}

/** UTC 12:00 = 6:00 p.m. in the work zone (UTC+6), Friday — the job runs at exactly this time */
const AT_6_PM_FRIDAY = new Date('2026-08-14T12:00:00.000Z');

describe('WeeklyDigestService — which ranges are requested', () => {
  it('F01 and F02 are both for the **whole window**', async () => {
    const { service, calls } = makeService();
    await service.runOnce(AT_6_PM_FRIDAY);

    // F01 used to ask only for today; without day-by-day targets there is no
    //    way to leave out "days that were not observed"
    expect(calls).toEqual([
      { report: 'attendance', from: '2026-08-08', to: '2026-08-14' },
      {
        report: 'summary',
        from: '2026-08-08',
        to: '2026-08-14',
        groupBy: 'week',
      },
    ]);
  });

  it('`daily_summary` is also looked at for exactly those seven days', async () => {
    const { service, observedQueries } = makeService();
    await service.runOnce(AT_6_PM_FRIDAY);

    expect(observedQueries).toHaveLength(1);
    expect(observedQueries[0].gte.toISOString()).toBe(
      '2026-08-08T00:00:00.000Z',
    );
    expect(observedQueries[0].lte.toISOString()).toBe(
      '2026-08-14T00:00:00.000Z',
    );
  });

  it('"today" means today in the work zone — even if it is still yesterday in UTC', async () => {
    const { service, calls, observedQueries } = makeService();
    // UTC 14 August 20:00 = 2 a.m. on 15 August in the work zone
    await service.runOnce(new Date('2026-08-14T20:00:00.000Z'));

    expect(calls[0].from).toBe('2026-08-09');
    expect(calls[1].from).toBe('2026-08-09');
    expect(observedQueries[0].lte.toISOString()).toBe(
      '2026-08-15T00:00:00.000Z',
    );
  });

  it('when tracking has only just started, the service also counts a smaller expectation', async () => {
    const { service } = makeService({
      observedDates: ['2026-08-13', '2026-08-14'],
    });

    const weekly = await service.collect(AT_6_PM_FRIDAY);

    // 48 − today's 8 − unobserved 8/9/10/11/12 (8+0+8+8+8) = 8
    expect(weekly.rows[0].expectedHours).toBe(8);
    expect(weekly.rows[0].countedFrom).toBe('2026-08-13');
    expect(weekly.totals.withGaps).toBe(1);
  });

  it("a dropped employee's name reaches the message from `meta`", async () => {
    const { service, sent } = makeService({
      excludedEmployees: ['Jordan Lee'],
    });
    const result = await service.runOnce(AT_6_PM_FRIDAY);

    expect(result.excluded).toBe(1);
    expect(sent[0]).toContain('Not in this report (1)');
    expect(sent[0]).toContain('Jordan Lee');
  });
});

describe('WeeklyDigestService — where it goes', () => {
  it('this code does not choose the destination — `send()` only takes the text', async () => {
    const { service, sent } = makeService();
    const result = await service.runOnce(AT_6_PM_FRIDAY);

    // This used to say "so it cannot be sent to a group by mistake" — that was
    //    false: not being able to choose the destination does not make the destination safe.
    //    The channel's `TELEGRAM_CHAT_ID` could perfectly well be a team group,
    //    and the ranking would go straight there. The real guard is in the describe below.
    expect(sent).toHaveLength(1);
    expect(result.outcome).toBe('sent');
    expect(sent[0]).toContain('Weekly summary');
  });

  it('ORG_NAME goes at the head of the message', async () => {
    const { service, sent } = makeService({ env: { ORG_NAME: 'Acme Ltd' } });
    await service.runOnce(AT_6_PM_FRIDAY);

    expect(sent[0].startsWith('Acme Ltd — Weekly summary')).toBe(true);
  });
});

// ── guard against group chats ───────────────────────────────────────────────

describe('isPrivateChatId — a group is recognised by its sign alone', () => {
  it('a private chat = a plain positive number', () => {
    expect(isPrivateChatId('123456789')).toBe(true);
    expect(isPrivateChatId('  123456789  ')).toBe(true);
  });

  it('group and supergroup ids are negative', () => {
    expect(isPrivateChatId('-1001234567890')).toBe(false);
    expect(isPrivateChatId('-987654321')).toBe(false);
  });

  it('`@name` only exists for public channels/supergroups', () => {
    expect(isPrivateChatId('@oxeio_team')).toBe(false);
  });

  it('if it cannot be recognised it is not called "private" — not knowing means not knowing', () => {
    expect(isPrivateChatId('abc')).toBe(false);
    expect(isPrivateChatId('+8801700000000')).toBe(false);
    expect(isPrivateChatId('')).toBe(false);
  });
});

describe('weeklyGateOf — when the summary will not go', () => {
  it('goes if it is a private chat', () => {
    expect(weeklyGateOf('123456789', undefined)).toEqual({
      send: true,
      blockedBecause: null,
    });
  });

  it('does not go if it is a group, and the reason is always written', () => {
    const gate = weeklyGateOf('-1001234567890', undefined);

    expect(gate.send).toBe(false);
    expect(gate.blockedBecause).toContain('WEEKLY_DIGEST_ALLOW_GROUP=true');
    // What to do to turn it on is written — both ways — it is not a silent block
    expect(gate.blockedBecause).toContain('TELEGRAM_CHAT_ID');
  });

  it('the chat id itself **never** goes in the reason line', () => {
    const gate = weeklyGateOf('-1009999999999', undefined);

    expect(gate.blockedBecause).not.toContain('9999999999');
  });

  it("`WEEKLY_DIGEST_ALLOW_GROUP=true` lets the owner's decision stand", () => {
    expect(weeklyGateOf('-1001234567890', 'true').send).toBe(true);
    expect(weeklyGateOf('-1001234567890', '  TRUE ').send).toBe(true);
  });

  it('nothing but `true` ever opens the guard', () => {
    for (const raw of ['1', 'yes', 'on', 'True!', '', undefined]) {
      expect(weeklyGateOf('-1001234567890', raw).send).toBe(false);
    }
  });

  it('if the chat id is empty this function makes no decision', () => {
    // The only place to say "not configured" is `TelegramChannel`;
    //    stopping here would log the wrong reason
    expect(weeklyGateOf(undefined, undefined).send).toBe(true);
    expect(weeklyGateOf('   ', undefined).send).toBe(true);
  });
});

describe('WeeklyDigestService — the ranking does not go to a group', () => {
  it('with a group chat id, `send()` is **never called**', async () => {
    const { service, sent } = makeService({
      env: { TELEGRAM_CHAT_ID: '-1001234567890' },
    });
    const logged: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).logger = { log: () => {}, warn: (m: string) => logged.push(m) };

    const result = await service.runOnce(AT_6_PM_FRIDAY);

    expect(sent).toHaveLength(0);
    // Not `not_configured` — token and chat id are both present, the reason is different
    expect(result.outcome).toBe('chat_not_private');
  });

  it('even when blocked the week is not lost — the full message goes to the log', async () => {
    const { service } = makeService({
      env: { TELEGRAM_CHAT_ID: '-1001234567890' },
    });
    const logged: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).logger = { log: () => {}, warn: (m: string) => logged.push(m) };

    await service.runOnce(AT_6_PM_FRIDAY);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('WEEKLY_DIGEST_ALLOW_GROUP=true');
    expect(logged[0]).toContain('48.00h recorded');
  });

  it('the numbers are still counted — the result is as full as before', async () => {
    const { service } = makeService({
      env: { TELEGRAM_CHAT_ID: '-1001234567890' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).logger = { log: () => {}, warn: () => {} };

    await expect(service.runOnce(AT_6_PM_FRIDAY)).resolves.toMatchObject({
      from: '2026-08-08',
      employees: 1,
      withData: 1,
      outcome: 'chat_not_private',
    });
  });

  it('if the owner knowingly allows it, it goes to the group too', async () => {
    const { service, sent } = makeService({
      env: {
        TELEGRAM_CHAT_ID: '-1001234567890',
        WEEKLY_DIGEST_ALLOW_GROUP: 'true',
      },
    });

    const result = await service.runOnce(AT_6_PM_FRIDAY);

    expect(sent).toHaveLength(1);
    expect(result.outcome).toBe('sent');
  });

  it('with a private chat id it goes as before', async () => {
    const { service, sent } = makeService({
      env: { TELEGRAM_CHAT_ID: '123456789' },
    });

    await service.runOnce(AT_6_PM_FRIDAY);

    expect(sent).toHaveLength(1);
  });
});

describe('WeeklyDigestService — when there is no Telegram', () => {
  it('no crash, and the full message goes to the log', async () => {
    const { service } = makeService({ outcome: 'not_configured' });
    const logged: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).logger = {
      log: () => {},
      warn: (m: string) => logged.push(m),
    };

    const result = await service.runOnce(AT_6_PM_FRIDAY);

    expect(result.outcome).toBe('not_configured');
    // A message that goes once a week — without logging it that week would be lost forever
    expect(logged[0]).toContain('Weekly summary');
    expect(logged[0]).toContain('48.00h recorded');
  });

  it('even when sending fails the result is a value, not an exception', async () => {
    const { service } = makeService({ outcome: 'failed' });

    await expect(service.runOnce(AT_6_PM_FRIDAY)).resolves.toMatchObject({
      outcome: 'failed',
      employees: 1,
      withData: 1,
    });
  });
});

describe('WeeklyDigestJob — never throws', () => {
  it('even if the report throws a 500 the job quietly returns null', async () => {
    const { service } = makeService({
      reports: {
        summary: () => Promise.reject(new Error('no active work policy')),
      },
    });
    const job = new WeeklyDigestJob(service);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (job as any).logger = { log: () => {}, error: () => {} };

    await expect(job.runOnce(AT_6_PM_FRIDAY)).resolves.toBeNull();
  });

  it('when it succeeds the result is returned', async () => {
    const { service } = makeService();
    const job = new WeeklyDigestJob(service);

    await expect(job.runOnce(AT_6_PM_FRIDAY)).resolves.toMatchObject({
      from: '2026-08-08',
      to: TODAY_DATE,
      outcome: 'sent',
    });
  });

  it('the scheduler is off in tests — `scheduled()` does nothing', async () => {
    const { service, sent } = makeService();
    const job = new WeeklyDigestJob(service);

    await job.scheduled();

    expect(sent).toHaveLength(0);
  });
});
