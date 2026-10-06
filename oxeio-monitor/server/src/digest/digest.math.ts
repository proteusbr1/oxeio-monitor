import { WORK_TIMEZONE_LABEL } from '../agent/util/dhaka-time';
import type { AttendanceRow, SummaryRow } from '../reports/reports.types';

/**
 * F07 — all calculations and wording of the daily digest email. Pure
 * functions, no I/O.
 *
 * **There is no new definition here.** Hours, target, leave, work day — all
 * come from the F01/F02 rows built by `ReportsService`. This file could have
 * read `daily_summary` and the work policy directly to work out the target,
 * but that would create a **third implementation** of the holiday calendar and
 * daily target — and one day the email would say a target of 8.00 hours while
 * the report said 7.94, and nobody could say which was true. The digest is
 * therefore the report's own voice.
 *
 * **"How much should have been done so far" now also comes from the report's
 * meta** (`expectedHours`). It used to be counted here — month target minus
 * today's target — and that was a separate definition of the expectation
 * window which did not know the "when did tracking start" idea. So the email
 * and the dashboard gave two different shortfalls for the same employee.
 *
 * Careful: **no screenshot, app name or domain ever goes into this email** —
 * only hours. Emails get forwarded, archived, and float up in phone
 * notifications; sending someone's browsing there would effectively remove the
 * dashboard's role wall. No type in this file has room for a domain or a file
 * name — that is not an accident.
 *
 * Careful: **no money** — salary is owner-only and audited (ADR-023).
 */

/** Hours to two decimals — every number in the email looks the same */
function h(hours: number): string {
  return hours.toFixed(2);
}

/** Round to two decimals (the report's hours are already two decimals) */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface DigestRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  /** Today's `credited` hours — work plus the owner's corrections */
  todayHours: number;
  /** Today's target; 0 on a day off */
  todayTargetHours: number;
  /** Not a work day today (weekly off day or calendar holiday) */
  offToday: boolean;
  /** A work day, yet no work at all today */
  idleToday: boolean;
  /** Total `credited` this month up to today */
  monthHours: number;
  /**
   * **How many hours should have been done up to yesterday.**
   *
   * Careful: the number is **not calculated** here — it comes straight from
   * `ReportMeta.expectedHours`, i.e. exactly the window that `elapsedWindow()`
   * in `summary.math.ts` decides. The tray, the Live Board and the Monthly page
   * show the same number.
   *
   * Careful: it used to be worked out as `month target (1st → today) − today's
   * target`. **Today is excluded** — that part was right, and the reason
   * matters: `monthly_summary.pace_sec` then counted today too, so at 6:30 pm
   * the expectation held today's whole 8 hours although the day was not over —
   * everyone would sit on the "behind" list every day and it would stop being
   * read within three days.
   *
   * Careful: but **the start was wrong**: counting began on the 1st of the
   * month, while on this installation the agent was installed on 13 August.
   * The days before the agent silently became "0 hours worked", and the email
   * showed everyone ~94 hours behind. **Not being observed is not a failure.**
   *
   * The calculation is still deliberately **generous**: today's work is
   * counted in full, today's claim is not. So a name on this list means a real
   * shortfall from days that have ended and were **observed** — not a false alarm.
   */
  expectedHours: number;
  /** `monthHours − expectedHours`; negative = behind */
  paceHours: number;
  behind: boolean;
}

export interface Digest {
  /** Today's date in Dhaka, YYYY-MM-DD */
  workDate: string;
  /** The part of the month that was counted */
  monthFrom: string;
  monthTo: string;
  /** Sorted by employee code — the same order as the report */
  rows: DigestRow[];
  /** Furthest behind first */
  behind: DigestRow[];
  /** A work day, yet zero today */
  idle: DigestRow[];
  totals: {
    employees: number;
    /** Who did some work today */
    workedToday: number;
    /** Today's total credited hours */
    hoursToday: number;
  };
}

export interface DigestSource {
  workDate: string;
  monthFrom: string;
  monthTo: string;
  /** F01, rows for exactly one day (today) */
  today: readonly AttendanceRow[];
  /** F02 `groupBy=month`, from the 1st of the month → today */
  month: readonly SummaryRow[];
  /**
   * F02's `meta.expectedHours` — per employee, "how much should have been done
   * up to yesterday", from **the server's single definition**.
   *
   * Careful: it could be counted here (month target minus today's target), and
   * it used to be — but that would create a **second definition** of the
   * window, one that did not know the day tracking started. The email and the
   * dashboard would then give two shortfalls for the same employee, with no
   * answer to which is true.
   *
   * Careful: if someone has no entry, it is taken as `0`, meaning "no claim
   * against them". The direction is deliberate: counting the unknown as a
   * **shortfall** would turn into an accusation against a person.
   */
  expectedHours: Readonly<Record<number, number>>;
}

/**
 * F01 + F02 → the digest's rows.
 *
 * Careful: the base is **today's attendance rows**, not the employee list.
 * Someone not employed today (not yet joined, or left) has no row in F01 and
 * should not be in the email — otherwise an employee who left would sit in the
 * list every day with "0 hours".
 *
 * Careful: **no attempt is made to say "why zero".** Agent off, PC off, or
 * really no work — the answer is in the alerts (G01 · G06), which look at both
 * heartbeat and tamper. Guessing again here would create a second, weaker
 * agent-down detector that sometimes said something different.
 */
export function buildDigest(source: DigestSource): Digest {
  const monthBy = new Map<number, SummaryRow>();
  for (const row of source.month) {
    // Careful: even with `groupBy=month`, a range spanning two months would
    //    give one person two rows. The digest wants the 1st of the current month,
    //    so there is one — still, the last is kept so that if a larger range
    //    arrives by mistake, at least the **most recent** month wins.
    monthBy.set(row.employeeId, row);
  }

  const rows: DigestRow[] = source.today.map((day) => {
    const month = monthBy.get(day.employeeId);

    const monthHours = month?.creditedHours ?? 0;

    /**
     * The window the server calculated — from tracking start to yesterday.
     * Careful: `Math.max(0, …)` is kept: the server does not send negatives,
     *    but "expectation −3 hours" means nothing, and a wrong number would
     *    get printed in the email.
     */
    const expectedHours = Math.max(
      0,
      round2(source.expectedHours[day.employeeId] ?? 0),
    );
    const paceHours = round2(monthHours - expectedHours);
    const offToday = day.dayType !== 'workday';

    return {
      employeeId: day.employeeId,
      empCode: day.empCode,
      fullName: day.fullName,
      todayHours: day.creditedHours,
      todayTargetHours: day.targetHours,
      offToday,
      idleToday: !offToday && day.status === 'no_activity',
      monthHours,
      expectedHours,
      paceHours,
      /**
       * Careful: no tolerance (such as `< -0.5 hours`) is assumed. "How far
       * behind before we tell" is a business decision nobody has made; putting
       * a number in would silently become policy. Instead the email states the
       * actual hours, and the reader decides how serious it is.
       */
      behind: paceHours < 0,
    };
  });

  rows.sort((a, b) => (a.empCode < b.empCode ? -1 : a.empCode > b.empCode ? 1 : 0));

  const behind = rows
    .filter((r) => r.behind)
    // Furthest behind first; ties by code — so two runs on the same day give the same email
    .sort((a, b) => a.paceHours - b.paceHours || (a.empCode < b.empCode ? -1 : 1));

  return {
    workDate: source.workDate,
    monthFrom: source.monthFrom,
    monthTo: source.monthTo,
    rows,
    behind,
    idle: rows.filter((r) => r.idleToday),
    totals: {
      employees: rows.length,
      workedToday: rows.filter((r) => r.todayHours > 0).length,
      hoursToday: round2(rows.reduce((sum, r) => sum + r.todayHours, 0)),
    },
  };
}

// ── Email text ───────────────────────────────────────────────────────────────

/**
 * Careful: no one's name in the subject.
 *
 * The email subject floats on the phone lock screen, in the preview pane and
 * at the top of forwarded threads — "Karim 3 hours behind" there means one
 * employee's figures in front of someone who did not open the email.
 * Numbers are safe, names are not.
 */
export function digestSubject(digest: Digest): string {
  const behind =
    digest.behind.length > 0 ? ` · ${digest.behind.length} behind` : '';
  return `[oXeio] Daily summary ${digest.workDate} · ${h(digest.totals.hoursToday)}h${behind}`;
}

/**
 * The plain-text body.
 *
 * Careful: no attempt is made to lay out printed-style columns (`padEnd`
 * etc.). Bengali glyph widths differ from font to font and conjuncts are
 * several code units — so aligned columns would look straight in some clients
 * and ragged in others. Simple bullets read the same everywhere.
 */
export function digestBody(digest: Digest, orgName: string): string {
  const { totals } = digest;
  const lines: string[] = [
    `${orgName} — Daily summary · ${digest.workDate} (${WORK_TIMEZONE_LABEL})`,
    '',
    `Hours today — ${h(totals.hoursToday)} total, ` +
      `${totals.workedToday}/${totals.employees} staff worked`,
  ];

  if (digest.rows.length === 0) {
    lines.push('  (no staff are active today)');
  }

  for (const r of digest.rows) {
    const target = r.offToday ? 'Off' : `${h(r.todayTargetHours)} target`;
    lines.push(
      `  • ${r.fullName} (${r.empCode}) — ${h(r.todayHours)}h · ${target}`,
    );
  }

  lines.push('', `Behind the monthly target — ${digest.behind.length} staff`);

  if (digest.behind.length === 0) {
    lines.push('  • Nobody.');
  }

  for (const r of digest.behind) {
    lines.push(
      `  • ${r.fullName} (${r.empCode}) — ${h(Math.abs(r.paceHours))}h behind ` +
        `(counted ${h(r.monthHours)} · expected ${h(r.expectedHours)})`,
    );
  }

  if (digest.idle.length > 0) {
    lines.push('', `Workday today, but no work at all — ${digest.idle.length} staff`);
    for (const r of digest.idle) {
      lines.push(`  • ${r.fullName} (${r.empCode})`);
    }
  }

  lines.push(
    '',
    'How to read these numbers',
    `  • Period covered: ${digest.monthFrom} — ${digest.monthTo}.`,
    '  • "Hours" means credited — work plus adjustments made by the owner.',
    "  • The behind figures leave out today's target, because the day is not over",
    '    yet. So the shortfall listed here is from days that have already ended.',
    // This line is needed: without it the reader would assume the expectation is
    // counted from the 1st of the month, and days before the agent was installed
    // would silently become someone's shortfall.
    '  • They also leave out any day before tracking started for that person —',
    '    days nobody was measuring are not counted as a shortfall.',
    '  • Why someone has zero hours (agent down, PC off, or a day off) is not',
    '    answered by this email; that answer is in the alerts and on the dashboard.',
    '  • Details (which app, which site, screenshots) are on the dashboard only —',
    '    never in email.',
  );

  return lines.join('\n');
}
