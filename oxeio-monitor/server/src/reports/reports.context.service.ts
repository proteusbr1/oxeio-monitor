import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { EmployeeStatus } from '@prisma/client';

import { workDateOf } from '../agent/util/work-time';
import { REGIME_SELECT, targetSpreadOf } from '../calendar/work-regime';
import { PrismaService } from '../prisma/prisma.service';
import {
  countLeaveWorkdays,
  elapsedWindow,
  elapsedWorkdays,
  isObserved,
} from '../summary/summary.math';
import { trackedFromBy } from '../summary/tracking-start';
import type { ReportRangeQuery } from './dto';
/**
 * `countWorkdays` and `monthBoundsOf` are **deliberately not imported here.**
 * The denominator of the daily target is the policy's `expected_workdays`, not
 * a number counted from the calendar, and it was exactly because those two
 * functions were at hand that the denominator once slid back to the calendar.
 * If counting work days is needed, `targetSecIn()` does it itself (that is the
 * numerator, not the denominator).
 */
import {
  approximateHolidayDates,
  dailyTargetSec,
  isWorkday,
  monthsIn,
  overlapOf,
  parseReportRange,
  secondsToHours,
  targetSecIn,
  toIsoDate,
  type DateSpan,
  type ReportRange,
  type WorkdayRule,
} from './reports.range';
import type { ReportMeta } from './reports.types';

// ── Internal helper types ───────────────────────────────────────────────────

export interface ResolvedEmployee {
  id: number;
  empCode: string;
  fullName: string;
  department: string | null;
  /** Gets tasks handed out (Tasks module) */
  receivesTasks: boolean;
  joinedOn: Date | null;
  leftOn: Date | null;
  monthlyTargetSec: number;
  weeklyOffDays: readonly number[];
  /**
   * One work day's target = monthly ÷ the policy's `expected_workdays`.
   *
   * Worked out **once** per employee and does not change when the month
   * changes: this very constancy is what keeps it in line with `prorate()`. It
   * used to vary by month (the denominator was that month's calendar work
   * days), so for the same employee in the same month the report said 7.70
   * hours and the tray said 8.00.
   */
  dailyTargetSec: number;
}

export interface ReportContext {
  range: ReportRange;
  employees: ResolvedEmployee[];
  excluded: string[];
  /**
   * Of the holiday dates this report's denominator rests on, those that are not
   * final yet ('YYYY-MM-DD'). They come from exactly the rows the work days
   * were counted with: one number, one definition.
   */
  approximateHolidayDates: string[];
  /**
   * Per employee, "how much was due so far", in hours: `ReportMeta.expectedHours`.
   * The definition, and why it is on the server, are both in that type's note.
   */
  expectedHours: Record<number, number>;
  /**
   * Per employee, **the total target of this span**, in hours: office days ×
   * daily target, minus weekly days off, public holidays and their own leave. The
   * definition is in the note on `ReportMeta.targetHoursInRange`.
   */
  targetHoursInRange: Record<number, number>;
  /** G111: per employee, whether at least one finished work day has been observed */
  observed: Record<number, boolean>;
  /** G110: per employee, the day tracking started, **only for drawing** */
  trackedFrom: Record<number, string | null>;
  /** That employee's target for that day, in seconds (0 on a leave day) */
  targetSecOf(employee: ResolvedEmployee, date: Date): number;
  /**
   * The span's **expectation**, in seconds: the target of only that part of
   * the span that falls inside `elapsedWindow()`.
   *
   * It is **less than or equal to** the sum of `targetSecOf()`, and the
   * difference is deliberate: the days before tracking started and today's
   * unfinished day are in the target but not the expectation. A shortfall is
   * measured **only** against this number; an unobserved day is nobody's failure.
   */
  expectedSecOf(employee: ResolvedEmployee, span: DateSpan): number;
  /**
   * **G130 (R2)**: whether that day is approved leave for that employee.
   *
   * Leave reached the numbers long ago (target 0, expectation 0) but **did not
   * reach the label**, so a leave day looked exactly like a zero-hour work day.
   * The number was not lying, but it **did not give the reason**, and to answer
   * "why did they not work that day" you had to go to Settings → Leave.
   *
   * It comes from exactly **the same** `leaveBy` set that zeroes the target
   * (`targetSecOf`): one definition. With a separate query, one day the badge
   * would be there while the target was not cut, or the reverse.
   */
  onLeaveOn(employee: ResolvedEmployee, date: Date): boolean;
  ruleOf(employee: ResolvedEmployee): WorkdayRule;
  employedOn(employee: ResolvedEmployee, date: Date): boolean;
}

/**
 * The common part of F01/F02/F04: the validated range, the employees, the
 * holiday calendar, each day's target and the expectation, plus the `meta`
 * block every report carries.
 *
 * Every report goes through this one class, so the three can never disagree
 * on who is in the report or what was due.
 */
@Injectable()
export class ReportsContextService {
  private readonly logger = new Logger(ReportsContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Common part ────────────────────────────────────────────────────────────

  /**
   * The basis of all three reports: the validated range, the list of employees,
   * the holiday calendar and each day's target.
   */
  async context(q: ReportRangeQuery): Promise<ReportContext> {
    let range: ReportRange;
    try {
      range = parseReportRange(q.from, q.to);
    } catch (err) {
      // The pure function throws RangeError (like payroll.math); translation
      // into HTTP language happens only here
      if (err instanceof RangeError) throw new BadRequestException(err.message);
      throw err;
    }

    const [employeeRows, defaultPolicy] = await Promise.all([
      this.prisma.employee.findMany({
        where: {
          ...(q.employeeId === undefined ? {} : { id: q.employeeId }),
          AND: [
            { OR: [{ joinedOn: null }, { joinedOn: { lte: range.to } }] },
            { OR: [{ leftOn: null }, { leftOn: { gte: range.from } }] },
          ],
        },
        select: {
          id: true,
          empCode: true,
          fullName: true,
          department: true,
          receivesTasks: true,
          status: true,
          joinedOn: true,
          leftOn: true,
          // `monthlySalary` is **not** here and must never be added: managers
          // call this endpoint too
          policy: {
            // `expectedWorkdays` is the **denominator** of the daily target.
            // Without fetching it, the calendar-counted work days would creep in
            // here again, which was exactly the source of the two numbers in
            // the report and the tray.
            select: REGIME_SELECT,
          },
        },
        orderBy: { empCode: 'asc' },
      }),
      this.prisma.workPolicy.findFirst({
        where: { isActive: true },
        orderBy: { id: 'asc' },
        select: REGIME_SELECT,
      }),
    ]);

    const employees: ResolvedEmployee[] = [];
    const excluded: string[] = [];

    for (const e of employeeRows) {
      // Inactive yet `left_on` empty: it is not known since when they were gone,
      // so putting zero rows across the range would give a wrong picture. They
      // are left out, but the name goes in meta.
      if (e.status === EmployeeStatus.inactive && e.leftOn === null) {
        excluded.push(e.fullName);
        continue;
      }

      const policy = e.policy ?? defaultPolicy;
      if (!policy) {
        // 208 is not assumed. With no policy the target is **unknown**, and
        // printing a shortfall against an unknown target would silently invent a policy.
        throw new InternalServerErrorException(
          'There is no active work policy — the target cannot be worked out',
        );
      }

      // per month, per week, per day or none — as seconds over workdays
      const spread = targetSpreadOf(policy);
      const monthlyTargetSec = spread.periodTargetSec;

      employees.push({
        id: e.id,
        empCode: e.empCode,
        fullName: e.fullName,
        department: e.department,
        receivesTasks: e.receivesTasks,
        joinedOn: e.joinedOn,
        leftOn: e.leftOn,
        monthlyTargetSec,
        weeklyOffDays: policy.weeklyOffDays,
        dailyTargetSec: dailyTargetSec(
          spread.periodTargetSec,
          spread.periodWorkdays,
        ),
      });
    }

    if (excluded.length > 0) {
      this.logger.warn(
        `${excluded.length} inactive staff have no left_on — they are missing from the report`,
      );
    }

    // Holidays are fetched for the **whole months**, not just the range, for two
    // reasons, and neither is the daily target's denominator (that is the
    // policy constant): see the note on `monthsIn()`.
    const months = monthsIn(range.from, range.to);
    const holidayRows = await this.prisma.holiday.findMany({
      where: {
        holidayDate: {
          gte: months[0].first,
          lte: months[months.length - 1].last,
        },
      },
      // `approximate` feeds the "dates not final yet" note (`approximateHolidayDates()`)
      select: { holidayDate: true, approximate: true },
    });
    const holidays = new Set(holidayRows.map((h) => h.holidayDate.getTime()));

    const ruleOf = (employee: ResolvedEmployee): WorkdayRule => ({
      weeklyOffDays: employee.weeklyOffDays,
      holidays,
    });

    /**
     * **R2: leave, per employee.**
     *
     * Leave days are **not** poured into the `holidays` set, though the two
     * functions below would then come out right anyway. The reason is that the
     * same set feeds `approximateHolidayDates()`, so one person's personal leave
     * would appear in the report's footnote as a "public holiday" for everyone to see.
     */
    const leaveRows = await this.prisma.leave.findMany({
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        leaveDate: {
          gte: months[0].first,
          lte: months[months.length - 1].last,
        },
      },
      select: { employeeId: true, leaveDate: true },
    });
    const leaveBy = new Map<number, Set<number>>();
    for (const l of leaveRows) {
      let set = leaveBy.get(l.employeeId);
      if (!set) leaveBy.set(l.employeeId, (set = new Set()));
      set.add(l.leaveDate.getTime());
    }

    /**
     * **One rate.** If the day is a work day, its target is the employee's own
     * `dailyTargetSec`, whatever the month and however many holidays it has.
     *
     * The denominator here used to be **that month's calendar work days**, and
     * that was the source of two different daily targets for the same employee
     * in the same month: the tray and `monthly_summary` said 208 ÷ 26 = 8.00
     * hours, the report said 208 ÷ 27 = 7.70. Worse, more holidays **raised**
     * the report's daily target, so a holiday gave the employee no benefit at all.
     * Why the policy constant is right is in the note on `dailyTargetSec()`.
     */
    /**
     * G130: the badge and the target deduction read **the same set**, so the two
     * can never disagree. The `leaves` table is read directly and nothing is
     * written to any column: delete a leave and the badge goes at once.
     */
    const onLeaveOn = (employee: ResolvedEmployee, date: Date): boolean =>
      leaveBy.get(employee.id)?.has(date.getTime()) ?? false;

    const targetSecOf = (employee: ResolvedEmployee, date: Date): number => {
      if (!isWorkday(date, ruleOf(employee))) return 0;
      // R2: a leave day has target 0, just like a weekly off day
      if (onLeaveOn(employee, date)) return 0;
      return employee.dailyTargetSec;
    };

    /**
     * **"How much was due so far": here, once.**
     *
     * The window is **not** built by hand: `elapsedWindow()` from
     * `summary.math.ts` is called, exactly as the monthly rollup and the tray
     * call it. Writing `today − 1` again here would be a fourth definition, and
     * that is exactly how the previous three were born.
     *
     * **That employee's own** tracking start (their oldest `daily_summary` row),
     * not the organisation's first day; otherwise for someone whose record was
     * created later, the days before it would also become their shortfall.
     *
     * **What this does not fix** (see the same note in `summary.math.ts` and
     * `progress.service.ts`): someone active from 1 October who got the agent on
     * 8 October. `refreshDate()` writes a row for every active employee, with
     * data or without, so their tracking start also lands on 1 October, and the
     * seven agentless days are **still a full shortfall**. This window covers
     * the gap of the first install, not of an employee who joined later (G120).
     *
     * The total uses `targetSecIn()`: **work days × daily target**, exactly how
     * `prorate()` works out the month's target. The daily target is now the same
     * in every month, so this product and the day-by-day sum give the same
     * hours, i.e. the number is the sum of the cells seen on the page. **Both**
     * are guarded by `test/reports.target.spec.ts`; if the denominator varied by
     * month that equality would break, and multiplying would be wrong.
     */
    const trackedFrom = await trackedFromBy(
      this.prisma,
      employees.map((e) => e.id),
    );

    // Today in the work zone: `parseReportRange()` finds the clamping limit exactly this way
    const today = workDateOf(new Date());

    const windowBy = new Map(
      employees.map((employee) => [
        employee.id,
        elapsedWindow({
          periodStart: range.from,
          periodEnd: range.to,
          today,
          joinedOn: employee.joinedOn,
          leftOn: employee.leftOn,
          // `?? today`: the window of an unseen employee is empty, expectation 0 (G120)
          trackingStartedOn: trackedFrom.get(employee.id) ?? today,
        }),
      ]),
    );

    /**
     * **The only place the expectation is measured**: the number in meta and the
     * row's shortfall both go through here. Adding up the buckets' expectations
     * returns exactly `meta.expectedHours`, because the buckets split the range.
     *
     * A `null` window = empty (today is the range's first day, or they have not
     * yet been seen on even one finished day); then the expectation is 0, and
     * nobody can have a shortfall against 0. That is what we want.
     */
    /**
     * **Office days × daily target − leave**: the project's only target
     * formula, written **once** here.
     *
     * The formula used to be written in two places, and that is exactly how G117
     * was born: leave was subtracted on one side and not the other. Now the two
     * callers (the expectation and the span's target) only pass a **different
     * window**, not a different calculation.
     *
     * R2: leave has to be subtracted separately, because `targetSecIn()`
     * multiplies (it does not add day by day). Without it the number in meta and
     * the sum of the rows would not match; `test/reports.target.spec.ts` guards that equality.
     */
    const netTargetSecIn = (
      employee: ResolvedEmployee,
      span: DateSpan,
    ): number => {
      const onLeave = countLeaveWorkdays(
        leaveBy.get(employee.id),
        span.from,
        span.to,
        employee.weeklyOffDays,
        holidays,
      );
      return (
        targetSecIn(span, ruleOf(employee), employee.dailyTargetSec) -
        onLeave * employee.dailyTargetSec
      );
    };

    const expectedSecOf = (
      employee: ResolvedEmployee,
      span: DateSpan,
    ): number => {
      const window = windowBy.get(employee.id) ?? null;
      if (window === null) return 0;

      const seen = overlapOf(window, span);
      if (seen === null) return 0;

      return netTargetSecIn(employee, seen);
    };

    const expectedHours: Record<number, number> = {};
    for (const employee of employees) {
      expectedHours[employee.id] = secondsToHours(
        expectedSecOf(employee, { from: range.from, to: range.to }),
      );
    }

    /**
     * **G111: which kind of 0 the 0 above is, is decided here.**
     *
     * `expectedHours === 0` can come from two completely different causes: they
     * have **not yet been seen on even one finished work day**, or they have
     * been seen but had no target at all on those days (all leave). On screen
     * both show as "0 shortfall", i.e. they look like a met target.
     *
     * The flag comes **from `workdaysElapsed`**, not from `expectedHours`. The
     * tray and Live Board read this same number (`isObserved`), so the three
     * screens can never give three different verdicts.
     *
     * Leave days are removed from the numerator (`leaveBy`), exactly as when
     * counting the expectation. Otherwise someone back from leave would show as
     * "observed" with an expectation of 0, the same two stories again.
     */
    const observed: Record<number, boolean> = {};
    const trackedFromMeta: Record<number, string | null> = {};
    for (const employee of employees) {
      observed[employee.id] = isObserved({
        workdaysElapsed: elapsedWorkdays(
          {
            periodStart: range.from,
            periodEnd: range.to,
            today,
            joinedOn: employee.joinedOn,
            leftOn: employee.leftOn,
            // `?? today`: exactly the same borrowing as `windowBy` above (G120)
            trackingStartedOn: trackedFrom.get(employee.id) ?? today,
            weeklyOffDays: employee.weeklyOffDays,
            holidays,
          },
          leaveBy.get(employee.id),
        ),
      });

      /**
       * G110: **the date, not the rule.** The page uses it only to draw cells
       * ("we were not watching on this day"); the expectation still comes from
       * `expectedHours`.
       */
      const seenFrom = trackedFrom.get(employee.id);
      trackedFromMeta[employee.id] =
        seenFrom === undefined ? null : toIsoDate(seenFrom);
    }

    /**
     * **Their total target in this span**, the owner's rule: 8 hours a day,
     * excluding holidays and weekly days off, counting office days, not months.
     *
     * So **office days are counted, not the month**: the span's work days ×
     * the daily target, weekly days off and public holidays excluded.
     *
     * This fixed G117: the policy's **flat 208** used to go here, yet in
     * October there are 24 office days (= 192h). The report showed a **phantom
     * shortfall** of 16 hours, while the tray said a different number for the same month.
     *
     * Because the month is not what is counted, the question "which month's
     * target" no longer arises: for one month, half a month or three, the
     * number means the same.
     *
     * **Personal leave is also subtracted** (`netTargetSecIn`); otherwise paid
     * leave days would become shortfall, and there would again be two numbers
     * against the tray, `monthly_summary` and payroll, just with the opposite sign.
     *
     * Trimmed to the employment period: the days before joining or after leaving
     * are nobody's target. If the overlap is empty the answer is **0**, and 0 is
     * a valid answer ("they have no office days").
     *
     * **The window is `requestedTo`, not `to`, and that is not a casual choice.**
     *
     * `range.to` is clamped to today (`clampedToToday`). Using it, on 23 August
     * August's target would come out as **160h** (20 office days), yet August's
     * target is 208: a target does not shrink because the month has not ended.
     *
     * Clamped, the number would also become effectively a **copy** of
     * `expectedHours`, though the two do different jobs: this is "how much is due
     * in total" (the denominator of progress), and that is "how much is due so
     * far" (the yardstick of shortfall). Making one equal the other would leave
     * the Monthly page's progress bar sitting near 100% all day.
     *
     * Caught in CI by a red test in this file's tests; `to` was used at first.
     */
    const targetHoursInRange: Record<number, number> = {};
    const targetSpan = { from: range.from, to: range.requestedTo };
    for (const employee of employees) {
      const employed = overlapOf(targetSpan, {
        from: employee.joinedOn ?? targetSpan.from,
        to: employee.leftOn ?? targetSpan.to,
      });
      targetHoursInRange[employee.id] = secondsToHours(
        employed === null ? 0 : Math.round(netTargetSecIn(employee, employed)),
      );
    }

    return {
      range,
      employees,
      excluded,
      expectedHours,
      targetHoursInRange,
      observed,
      trackedFrom: trackedFromMeta,
      onLeaveOn,
      expectedSecOf,
      /**
       * **Exactly the rows** from which the `holidays` set above was built, and
       * so the month's work days and the daily target's denominator. A separate
       * query would bring the two numbers from two places, and one day (if the
       * range or filter changed a little) they would say different things.
       */
      approximateHolidayDates: approximateHolidayDates(
        holidayRows.map((h) => ({ date: h.holidayDate, approximate: h.approximate })),
      ),
      ruleOf,
      employedOn: (employee, date) =>
        (employee.joinedOn === null ||
          date.getTime() >= employee.joinedOn.getTime()) &&
        (employee.leftOn === null ||
          date.getTime() <= employee.leftOn.getTime()),
      targetSecOf,
    };
  }
}

export function metaOf(ctx: ReportContext): ReportMeta {
  return {
    from: toIsoDate(ctx.range.from),
    to: toIsoDate(ctx.range.to),
    requestedTo: toIsoDate(ctx.range.requestedTo),
    clampedToToday: ctx.range.clampedToToday,
    days: ctx.range.days,
    generatedAt: new Date().toISOString(),
    excludedEmployees: ctx.excluded,

    // The uncertainty reaches the number: which of these months' holiday dates
    // are not final yet. If they move, work days move, the target moves, and
    // payroll's fraction moves, so we cannot stay silent.
    approximateHolidayDates: ctx.approximateHolidayDates,

    // Their **real** target in this span: office days × daily target (G117).
    // It used to be the policy's flat 208 here, which was only right for a
    // month with 26 office days; October has 24 days = 192h, a phantom 16-hour shortfall.
    // The calculation is in `context()`, on **the same formula** as `expectedHours`.
    targetHoursInRange: ctx.targetHoursInRange,

    // "How much was due so far": the window is `elapsedWindow()`'s, i.e. exactly
    // the same definition as the tray and Live Board.
    expectedHours: ctx.expectedHours,

    // G111: whether the 0 above is "target met" or "not observed yet". A
    // **state**, not a number; otherwise the page would have to guess.
    observed: ctx.observed,

    // G110: since when we have been watching. **Only for drawing**; do not
    // compute the expectation from it, which is how the earlier bug was born.
    trackedFrom: ctx.trackedFrom,
  };
}
