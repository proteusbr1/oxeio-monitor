import { describe, expect, it } from 'vitest';

import {
  buildDigest,
  digestBody,
  digestSubject,
  type DigestSource,
} from '../src/digest/digest.math';
import type { AttendanceRow, SummaryRow } from '../src/reports/reports.types';

/**
 * F07 — the daily digest.
 *
 * Every mistake here is silent: the email would still go out, only what was
 * inside would be wrong. The two biggest are (1) putting everyone on the
 * "behind" list every day, and (2) leaking domains or screenshots in the email.
 */

function day(over: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    employeeId: 1,
    empCode: 'OX-001',
    fullName: 'Jane Doe',
    receivesTasks: false,
    department: null,
    date: '2026-08-11',
    dayType: 'workday',
    status: 'worked',
    // Nobody in the sample is on leave — this fixture makes no claim about G130
    onLeave: false,
    workedHours: 7.5,
    idleHours: 0.5,
    adjustmentHours: 0,
    tasksDone: null,
    creditedHours: 7.5,
    targetHours: 8,
    ...over,
  };
}

function month(over: Partial<SummaryRow> = {}): SummaryRow {
  return {
    employeeId: 1,
    empCode: 'OX-001',
    fullName: 'Jane Doe',
    bucket: '2026-08',
    bucketStart: '2026-08-01',
    bucketEnd: '2026-08-11',
    workdays: 9,
    daysWithWork: 9,
    workedHours: 72,
    adjustmentHours: 0,
    creditedHours: 72,
    // 9 work days x 8 hours — including today
    targetHours: 72,
    shortfallHours: 0,
    overtimeHours: 0,
    ...over,
  };
}

function source(over: Partial<DigestSource> = {}): DigestSource {
  return {
    workDate: '2026-08-11',
    monthFrom: '2026-08-01',
    monthTo: '2026-08-11',
    today: [day()],
    month: [month()],
    /**
     * F02's `meta.expectedHours` — the window computed by the server
     * (tracking start -> yesterday). 8 work days x 8 hours.
     *
     * This is now an input to the digest, not an output. The number used to be
     * built here (month target minus today's target), which was a second
     * definition of the window — and it did not recognise the day tracking
     * started.
     */
    expectedHours: { 1: 64 },
    ...over,
  };
}

describe('buildDigest — expectation comes from the server\'s single definition', () => {
  it('the digest takes what the server says — it does not count itself', () => {
    const digest = buildDigest(source());

    expect(digest.rows[0].expectedHours).toBe(64);
    expect(digest.rows[0].paceHours).toBe(8);
    expect(digest.rows[0].behind).toBe(false);
  });

  /**
   * This is the real trap, and it is now closed on the server.
   * `monthly_summary.pace_sec` used to count today too, so at 6:30 PM even
   * someone exactly on target showed 0.5 hours "behind" — everyone was on the
   * list every day, and within three days the email stopped being read.
   */
  it('someone exactly on target is not "behind" at 6:30 PM', () => {
    const digest = buildDigest(
      source({
        today: [day({ creditedHours: 7.5 })],
        month: [month({ creditedHours: 71.5, targetHours: 72 })],
      }),
    );

    expect(digest.behind).toHaveLength(0);
    expect(digest.rows[0].paceHours).toBe(7.5);
  });

  it('the real shortfall of earlier days is caught', () => {
    // Should have 64 up to yesterday, has 50 -> 14 hours behind
    const digest = buildDigest(
      source({
        today: [day({ creditedHours: 0, status: 'no_activity' })],
        month: [month({ creditedHours: 50 })],
      }),
    );

    expect(digest.rows[0].paceHours).toBe(-14);
    expect(digest.behind).toHaveLength(1);
  });

  /**
   * The most important test in this file — the days before tracking started.
   *
   * The month row's target is 72 hours (from the 1st to today), but the agent
   * was installed yesterday, so the server says the expectation is only 8
   * hours. The digest follows that. The old code
   * (`month.targetHours - day.targetHours`) would put 64 here, turning 56
   * hours of days with no measuring instrument into a shortfall for the
   * staff member. Absent observation is not failure.
   */
  it('days before the agent was installed do not become a shortfall', () => {
    const digest = buildDigest(
      source({
        today: [day({ creditedHours: 6 })],
        month: [month({ creditedHours: 6, targetHours: 72 })],
        expectedHours: { 1: 8 },
      }),
    );

    expect(digest.rows[0].expectedHours).toBe(8);
    expect(digest.rows[0].paceHours).toBe(-2);
    // With the old formula this would be -58 and sit at the top of the list
    expect(digest.behind).toHaveLength(1);
  });

  it('with no finished day observed, the expectation is 0, not negative', () => {
    const digest = buildDigest(
      source({
        today: [day({ targetHours: 8, creditedHours: 3 })],
        month: [month({ targetHours: 8, creditedHours: 3, workdays: 1 })],
        // Empty window — today is the first day of the month/tracking
        expectedHours: { 1: 0 },
      }),
    );

    expect(digest.rows[0].expectedHours).toBe(0);
    expect(digest.rows[0].paceHours).toBe(3);
    expect(digest.behind).toHaveLength(0);
  });

  it('even when today is a holiday, the expectation up to yesterday stays intact', () => {
    const digest = buildDigest(
      source({
        today: [day({ dayType: 'weekly_off', targetHours: 0, creditedHours: 0, status: 'no_activity' })],
        month: [month({ targetHours: 64, creditedHours: 64 })],
      }),
    );

    expect(digest.rows[0].offToday).toBe(true);
    expect(digest.rows[0].expectedHours).toBe(64);
    // Not working on a holiday does not put anyone on the "nothing to do" list
    expect(digest.rows[0].idleToday).toBe(false);
    expect(digest.idle).toHaveLength(0);
  });
});

describe('buildDigest — list and order', () => {
  it('the row stays even without a month row, counted as zero', () => {
    // The expectation is unknown too — and unknown must not be called a
    // shortfall, otherwise whenever the rollup lagged the email would accuse everyone
    const digest = buildDigest(source({ month: [], expectedHours: {} }));

    expect(digest.rows).toHaveLength(1);
    expect(digest.rows[0].monthHours).toBe(0);
    expect(digest.rows[0].expectedHours).toBe(0);
  });

  it('the basis is today\'s attendance rows — someone in the month but not today does not enter', () => {
    // Someone who left yesterday has no row for today in F01, yet the month
    // row exists. The email must not sit there every day with "0 hours".
    const digest = buildDigest(
      source({
        today: [],
        month: [month({ employeeId: 9, empCode: 'OX-009' })],
      }),
    );

    expect(digest.rows).toHaveLength(0);
    expect(digest.totals.employees).toBe(0);
  });

  it('rows in staff-code order, the behind list with the furthest behind first', () => {
    const digest = buildDigest(
      source({
        today: [
          day({ employeeId: 3, empCode: 'OX-003', fullName: 'C', creditedHours: 0, status: 'no_activity' }),
          day({ employeeId: 1, empCode: 'OX-001', fullName: 'A', creditedHours: 8 }),
          day({ employeeId: 2, empCode: 'OX-002', fullName: 'B', creditedHours: 0, status: 'no_activity' }),
        ],
        month: [
          month({ employeeId: 3, empCode: 'OX-003', creditedHours: 40 }), // -24
          month({ employeeId: 1, empCode: 'OX-001', creditedHours: 72 }), // +8
          month({ employeeId: 2, empCode: 'OX-002', creditedHours: 60 }), // -4
        ],
        expectedHours: { 1: 64, 2: 64, 3: 64 },
      }),
    );

    expect(digest.rows.map((r) => r.empCode)).toEqual([
      'OX-001',
      'OX-002',
      'OX-003',
    ]);
    expect(digest.behind.map((r) => r.empCode)).toEqual(['OX-003', 'OX-002']);
    expect(digest.idle.map((r) => r.empCode)).toEqual(['OX-002', 'OX-003']);
    expect(digest.totals).toEqual({
      employees: 3,
      workedToday: 1,
      hoursToday: 8,
    });
  });

  it('today\'s total hours add up, without floating-point tails', () => {
    const digest = buildDigest(
      source({
        today: [
          day({ employeeId: 1, empCode: 'OX-001', creditedHours: 0.1 }),
          day({ employeeId: 2, empCode: 'OX-002', creditedHours: 0.2 }),
        ],
        month: [],
      }),
    );

    // 0.1 + 0.2 = 0.30000000000000004 — without rounding, that is what would go in the email
    expect(digest.totals.hoursToday).toBe(0.3);
  });
});

describe('digestSubject', () => {
  it('no one\'s name in the subject — it floats on the lock screen', () => {
    const digest = buildDigest(
      source({
        today: [day({ fullName: 'Jane Doe', creditedHours: 0, status: 'no_activity' })],
        month: [month({ creditedHours: 10 })],
      }),
    );

    const subject = digestSubject(digest);
    expect(subject).not.toContain('Jane');
    expect(subject).not.toContain('OX-001');
    expect(subject).toContain('2026-08-11');
    expect(subject).toContain('1 behind');
  });

  it('when nobody is behind, that part is absent from the subject', () => {
    expect(digestSubject(buildDigest(source()))).not.toContain('behind');
  });
});

describe('digestBody', () => {
  const digest = buildDigest(
    source({
      today: [
        day({ employeeId: 1, empCode: 'OX-001', fullName: 'মামুনুর রশিদ', creditedHours: 7.5 }),
        day({ employeeId: 2, empCode: 'OX-002', fullName: 'Jane Doe', creditedHours: 0, status: 'no_activity' }),
      ],
      month: [
        month({ employeeId: 1, empCode: 'OX-001', creditedHours: 72 }),
        month({ employeeId: 2, empCode: 'OX-002', creditedHours: 40 }),
      ],
      expectedHours: { 1: 64, 2: 64 },
    }),
  );
  const body = digestBody(digest, 'oXeio Office');

  it('Bengali names are intact — email is UTF-8, no limit like a PDF', () => {
    expect(body).toContain('মামুনুর রশিদ');
  });

  it('everyone\'s hours today and target are present', () => {
    expect(body).toContain('মামুনুর রশিদ (OX-001) — 7.50h · 8.00 target');
  });

  it('the behind line has both the counted and the expected', () => {
    expect(body).toContain('Jane Doe (OX-002) — 24.00h behind');
    expect(body).toContain('counted 40.00');
    expect(body).toContain('expected 64.00');
  });

  it('both ends of the window are written in the email', () => {
    // Without this the reader would think the number was the full pace from
    // the 1st of the month, and, finding it did not match the dashboard,
    // would assume one of the two was "broken"
    expect(body).toContain("leave out today's target");
    // And without this line the days before the agent was installed would silently look like a shortfall
    expect(body).toContain('before tracking started');
  });

  it('no domain, process name or URL is sent', () => {
    // This test documents the intent: emails get forwarded and archived, so
    // nobody's browsing may be sent there. `DigestRow` has no field for any
    // of it, but if someone one day wants to add a "top app" column, this
    // line is where they will first stumble.
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toMatch(/\.(com|net|org|io|exe)\b/i);
  });

  it('no mention of money — salary is owner-only and audited (ADR-023)', () => {
    expect(body).not.toMatch(/\$|salary|বেতন/i);
  });

  it('when nobody is behind it says "Nobody", not an empty section', () => {
    expect(digestBody(buildDigest(source()), 'oXeio')).toContain('Nobody');
  });

  it('the body is still meaningful when nobody is working', () => {
    const empty = digestBody(
      buildDigest(source({ today: [], month: [] })),
      'oXeio',
    );
    expect(empty).toContain('no staff are active today');
  });
});
