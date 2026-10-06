import type { AttendanceReport, AttendanceRow, DayType } from '../../api/reports';
import { monthEndOf, parseWorkDate } from '../../lib/format';

/**
 * Arranges the flat rows of `GET /reports/attendance` into a staff x date grid.
 * There is **deliberately no JSX** here: the calculation is subtle enough (leave,
 * days outside employment, the future, the month's target) that mixing it with
 * rendering would make it impossible to tell later which rule lives where.
 *
 * Careful: the server returns one row per day, and **no row at all for days outside
 *    employment** (`employedOn` in reports.service.ts). So "no row" can mean three
 *    different things: the future, outside employment, or a genuinely zero day.
 *    Showing all three alike would make someone who joined on the 20th look like
 *    they skipped 19 days.
 */

export type CellKind =
  /** A row exists; the hours may still be zero */
  | 'day'
  /** The day after `meta.to`; has not happened yet */
  | 'future'
  /** The employee was not at this office that day (before joining / after leaving) */
  | 'outside'
  /**
   * **Not yet tracked**: a workday, within employment, but **they were not being
   * watched yet** (before `meta.trackedFrom`).
   *
   * Careful: before this state was separated, such days got the reddish "nothing
   * happened on a workday" tint. So on one page **the number said "no claim"** (the
   * expectation ignores those days) while **the picture said "slacking"**, and people
   * look at the picture first. On this installation the agent went in on 13 August,
   * so days 1-12 of August were reddish on every page.
   *
   * Important: the Live Board's seven-day strip got a dotted outline for exactly this
   * reason; Monthly was missed. So the look is deliberately **the same**.
   */
  | 'untracked';

export interface DayCell {
  /** `YYYY-MM-DD` */
  date: string;
  /** Day of the month (1...31) */
  day: number;
  kind: CellKind;
  /** `null` unless `kind === 'day'` */
  dayType: DayType | null;
  /**
   * **Whether that day was the employee's approved leave.**
   *
   * Careful — the bug this fixes: the server sent `onLeave` but the heatmap cell
   * never read it. On a leave day `dayType` is `workday` (that is the **office**
   * calendar, not one person's) and hours are 0, so the cell fell into the "nothing
   * happened on a workday" branch and approved leave got a **reddish slacking tint**.
   *
   * Careful: not to be mixed with `dayType`: that says what the day is in the office
   * calendar; this says what it is for **this one person**.
   */
  onLeave: boolean;
  workedHours: number;
  adjustmentHours: number;
  creditedHours: number;
  targetHours: number;
  /**
   * 0-4: steps of the grey-to-black ramp.
   * Important: the steps are **relative to that employee's daily target**, not
   *   absolute hours. If policy changes from 208 to 180, the ramp adjusts at once;
   *   hardcoded absolute numbers would silently falsify "black = a full day".
   */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface EmployeeGridRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  department: string | null;
  /** One per date of the month; the length is always `days.length` */
  cells: DayCell[];

  /** Counted so far (worked + the owner's adjustments) */
  creditedHours: number;
  /** Pure work so far, without adjustments */
  workedHours: number;
  /**
   * How much was expected by now (`expected_sec`).
   * Careful: **a number from the server** (`meta.expectedHours`), not built up by
   *    summing here. See the note inside `buildMonthGrid()` for why.
   */
  expectedHours: number;
  /** `credited - expected`. Negative = behind */
  paceHours: number;
  daysWithWork: number;

  /** One workday's target; constant across the month. `null` if unknown */
  dailyTargetHours: number | null;
  /** The whole month's target (usually 208). `null` if it cannot be worked out */
  targetHoursInRange: number | null;
  /** Careful: when true the number is an estimate; show it with `≈` on screen */
  monthTargetEstimated: boolean;

  /** First and last effective day if employment covers part of the month, else `null` */
  partial: { from: string; to: string } | null;

  /**
   * Whether **at least one finished** workday of theirs has been observed.
   *
   * Careful: when `false`, `expectedHours` above is 0, so `paceHours` is 0 too, and
   * on screen that looks **exactly like someone who met the target**. The row then
   * shows a sentence instead of numbers.
   *
   * Careful: this is the server's verdict (`meta.observed`), not counted here:
   * `expectedHours === 0` could also mean "every day was leave", and then the
   * sentence would be false.
   */
  observed: boolean;
}

export interface MonthGrid {
  /** Every date of the month, from the 1st to the last day */
  days: string[];
  rows: EmployeeGridRow[];
  /** Dates that are a day off for **everyone**; used to grey the column header */
  officeOffDays: Set<string>;
  /** Days after `meta.to` */
  futureDays: Set<string>;
  totals: {
    employees: number;
    creditedHours: number;
    expectedHours: number;
    targetHoursInRange: number | null;
    monthTargetEstimated: boolean;
    /** Those behind `expected` */
    behind: number;
    /**
     * How many people have not been counted yet.
     *
     * Careful: `expectedHours` above **leaves them out**, so the footer total
     * silently looks lower, and the page looks better than the team really is behind.
     * The number is not dropped; it is **stated**.
     */
    notObserved: number;
  };
}

/** Neither negative nor positive: a gap this small counts as "equal" (about 3 minutes) */
export const PACE_EPSILON = 0.05;

/**
 * Sort order.
 * Important: the default is `pace`; this screen has one question, "who is behind".
 *   The answer should be in the top row, not something to scroll and find.
 */
export type GridSort = 'pace' | 'name';

export function buildMonthGrid(
  report: AttendanceReport,
  monthKey: string,
  sort: GridSort = 'pace',
): MonthGrid {
  const days = daysOfMonth(monthKey);
  const lastCovered = report.meta.to;
  const futureDays = new Set(days.filter((d) => d > lastCovered));

  // employeeId -> (date -> row)
  const byEmployee = new Map<number, Map<string, AttendanceRow>>();
  const identity = new Map<number, AttendanceRow>();

  for (const row of report.rows) {
    let dates = byEmployee.get(row.employeeId);
    if (!dates) {
      dates = new Map();
      byEmployee.set(row.employeeId, dates);
      identity.set(row.employeeId, row);
    }
    dates.set(row.date, row);
  }

  const rows: EmployeeGridRow[] = [];

  for (const [employeeId, dates] of byEmployee) {
    const who = identity.get(employeeId)!;

    // Careful: the daily target must be known **before** placing the ramp, hence two
    //    passes. A day off has target 0, so the largest value is the workday target.
    let dailyTargetHours = 0;
    for (const row of dates.values()) {
      if (row.targetHours > dailyTargetHours) dailyTargetHours = row.targetHours;
    }
    const dailyTarget = dailyTargetHours > 0 ? dailyTargetHours : null;

    /**
     * Since when they have been watched. Careful: **only for drawing the cell**;
     * the expectation still comes from the server's `expectedHours`. Adding it up
     * from this date would also require writing the "today is excluded" rule here,
     * and that is exactly how the earlier bug was born.
     *
     * Careful: `null` = they were **never** watched, so every workday in the month is
     *    unobserved. `undefined` is the same: absent from meta means no information.
     */
    const seenFrom = report.meta.trackedFrom[employeeId] ?? null;

    const cells: DayCell[] = [];
    let creditedHours = 0;
    let workedHours = 0;
    let daysWithWork = 0;
    let weeklyOffWeekday: number | null = null;
    let firstDay: string | null = null;
    let lastDay: string | null = null;

    for (const date of days) {
      const row = dates.get(date);

      if (!row) {
        // No row: either the day has not come yet, or the employee was not there that day
        cells.push(blankCell(date, date > lastCovered ? 'future' : 'outside'));
        continue;
      }

      firstDay ??= date;
      lastDay = date;

      creditedHours += row.creditedHours;
      workedHours += row.workedHours;
      if (row.workedHours > 0) daysWithWork += 1;
      if (row.dayType === 'weekly_off') weeklyOffWeekday ??= weekdayIndexOf(date);

      /**
       * **An unobserved workday is not the same as a slacked workday.**
       *
       * Careful: all three conditions are needed, each with its own reason:
       *   1. **Workday**: a day off already has its own look, and there is no reason
       *      to change it.
       *   2. **Zero hours**: the owner can enter hours by adjustment even on an
       *      unobserved day; if so the day did show something, and covering it with
       *      the dotted cell would make those hours vanish from the screen.
       *   3. **Before tracking started**: this is the real question.
       */
      const untracked =
        row.dayType === 'workday' &&
        row.creditedHours === 0 &&
        (seenFrom === null || date < seenFrom);

      cells.push({
        date,
        day: dayNumber(date),
        kind: untracked ? 'untracked' : 'day',
        dayType: row.dayType,
        onLeave: row.onLeave,
        workedHours: row.workedHours,
        adjustmentHours: row.adjustmentHours,
        creditedHours: row.creditedHours,
        targetHours: row.targetHours,
        level: levelOf(row.creditedHours, dailyTarget),
      });
    }

    // The server **knows** the whole month's target, the number written in policy
    //    (208). It used to be guessed here: sum of elapsed days + the daily target of
    //    the remaining days. Careful: counting the remaining days excluded only weekly
    //    offs, **not public holidays**, so in August 2026 it showed 216 instead of
    //    208, as if everyone were 8 hours further behind. Payroll meanwhile used 208;
    //    when dashboard and pay say two different numbers, neither is believable.
    const monthTarget = report.meta.targetHoursInRange[employeeId] ?? null;

    /**
     * **The expectation comes from the server; it is not summed here.**
     *
     * Careful: this used to read `expectedHours += row.targetHours`, the sum of every
     *    day's target from the 1st of the month to today. The browser does not know
     *    two things, and both made it wrong:
     *
     *      1. **Since when the employee has been watched.** On this installation the
     *         agent went in on 13 August 2026; before that we do not know how much
     *         anyone worked. Counting from the 1st would silently turn those
     *         unobserved days into "0 hours worked", and the page would show everyone
     *         about 94 hours behind, for a time when the measuring tool was not even
     *         installed. **Absent observation is not failure.**
     *
     *      2. **Today is not counted in the expectation.** If it were, at 6am the
     *         whole team would show "114 hours behind" and by evening the number
     *         would fix itself: the same team would get two verdicts a day, purely
     *         from the clock.
     *
     * Important: there is one definition of the window, on the server
     *    (`summary.math.ts` -> `elapsedWindow()`). The Live Board, tray, `/me` and the
     *    daily email use it too. Sending only the tracking-start date and summing
     *    here would have put the "exclude today" rule in this file **again**, and
     *    that is exactly how the bug was born. The client now has no rules, only
     *    reads.
     *
     * Careful: `?? 0`: a row existing but missing from meta should not happen (both
     *    come from the same employee list). If it does, it counts as "no claim", not
     *    "behind": calling the unknown a shortfall is an accusation against a person.
     */
    const expectedHours = report.meta.expectedHours[employeeId] ?? 0;

    rows.push({
      employeeId,
      empCode: who.empCode,
      fullName: who.fullName,
      department: who.department,
      cells,
      creditedHours,
      workedHours,
      expectedHours,
      paceHours: creditedHours - expectedHours,
      daysWithWork,
      dailyTargetHours: dailyTarget,
      targetHoursInRange: monthTarget,
      // A number from the server, no longer an estimate
      monthTargetEstimated: false,
      // Important: someone who joined or left mid-month has a lower target anyway;
      //   without saying so, "only 104 hours" would lead to a wrong decision
      partial:
        firstDay && lastDay && (firstDay !== days[0] || lastDay < lastCovered)
          ? { from: firstDay, to: lastDay }
          : null,
      /**
       * Careful: `?? true`: if absent from meta, treat as **"observed"**; otherwise
       *    against an older server the whole page would show "nobody has a figure".
       *    The numbers would still be right, only the explanation would be false.
       */
      observed: report.meta.observed[employeeId] ?? true,
    });
  }

  rows.sort(
    sort === 'name'
      ? (a, b) => a.fullName.localeCompare(b.fullName, 'bn')
      : (a, b) => a.paceHours - b.paceHours,
  );

  return {
    days,
    rows,
    officeOffDays: officeOffDaysOf(days, rows),
    futureDays,
    totals: totalsOf(rows),
  };
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Careful: a **ratio**, not absolute hours. The fallback is needed only when the
 *    employee's daily target was never known (e.g. the whole region was on holiday);
 *    then the mockup's steps are used, or every cell would be the same colour.
 */
function levelOf(hours: number, dailyTarget: number | null): 0 | 1 | 2 | 3 | 4 {
  if (!(hours > 0)) return 0;

  if (dailyTarget === null || dailyTarget <= 0) {
    if (hours < 4) return 1;
    if (hours < 6.5) return 2;
    if (hours < 8.5) return 3;
    return 4;
  }

  const ratio = hours / dailyTarget;
  if (ratio < 0.4) return 1;
  if (ratio < 0.7) return 2;
  if (ratio < 1) return 3;
  return 4;
}

function blankCell(date: string, kind: CellKind): DayCell {
  return {
    date,
    day: dayNumber(date),
    kind,
    dayType: null,
    // Careful: an empty cell (future / outside employment); leave does not apply
    onLeave: false,
    workedHours: 0,
    adjustmentHours: 0,
    creditedHours: 0,
    targetHours: 0,
    level: 0,
  };
}

/**
 * The dates on which **every** employee is off; used to grey the column header.
 * Careful: if only some are off, the column must not be greyed: with different
 *    policies one person's Friday is another's workday, and a grey column would
 *    mislead.
 */
function officeOffDaysOf(
  days: string[],
  rows: EmployeeGridRow[],
): Set<string> {
  const off = new Set<string>();
  if (rows.length === 0) return off;

  days.forEach((date, index) => {
    let sawDay = false;
    for (const row of rows) {
      const cell = row.cells[index];
      if (cell.kind !== 'day') continue;
      sawDay = true;
      if (cell.dayType === 'workday') return;
    }
    if (sawDay) off.add(date);
  });

  return off;
}

function totalsOf(rows: EmployeeGridRow[]): MonthGrid['totals'] {
  let creditedHours = 0;
  let expectedHours = 0;
  let targetHoursInRange = 0;
  let monthTargetKnown = false;
  let monthTargetEstimated = false;
  let behind = 0;
  let notObserved = 0;

  for (const row of rows) {
    creditedHours += row.creditedHours;
    expectedHours += row.expectedHours;
    if (row.targetHoursInRange !== null) {
      targetHoursInRange += row.targetHoursInRange;
      monthTargetKnown = true;
      if (row.monthTargetEstimated) monthTargetEstimated = true;
    }
    /**
     * Careful: **before counting "behind", check "observed".** Someone not yet
     * observed has `paceHours` of exactly 0, so they are not "behind", but not
     * "fine" either. They are counted separately, in neither list.
     */
    if (!row.observed) {
      notObserved += 1;
      continue;
    }
    if (row.paceHours < -PACE_EPSILON) behind += 1;
  }

  return {
    employees: rows.length,
    creditedHours,
    expectedHours,
    targetHoursInRange: monthTargetKnown ? targetHoursInRange : null,
    monthTargetEstimated,
    behind,
    notObserved,
  };
}

// ── Small date helpers ──────────────────────────────────────────────────────

/** `'2026-08'` → `['2026-08-01', … '2026-08-31']` */
export function daysOfMonth(monthKey: string): string[] {
  const total = dayNumber(monthEndOf(`${monthKey}-01`));
  const days: string[] = [];
  for (let d = 1; d <= total; d += 1) {
    days.push(`${monthKey}-${String(d).padStart(2, '0')}`);
  }
  return days;
}

function dayNumber(date: string): number {
  return Number(date.slice(8, 10));
}

/**
 * Sunday = 0 ... Saturday = 6.
 * Careful: `parseWorkDate()` returns UTC midnight, hence `getUTCDay()`; with
 *    `getDay()` the weekday would shift by one in the browser's timezone.
 */
function weekdayIndexOf(date: string): number {
  return parseWorkDate(date)?.getUTCDay() ?? -1;
}
