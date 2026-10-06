import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EmployeeStatus } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { DepositsService } from '../deposits/deposits.service';
import { FeaturesService } from '../features/features.service';
import { dailyTargetSecOf, hasTarget, REGIME_SELECT } from '../calendar/work-regime';
import { PrismaService } from '../prisma/prisma.service';
import { proratedExpectedSec } from '../summary/summary.math';
import { computePayroll, minorToAmount, payTermsForMonth } from './payroll.math';

// G108: **one** definition of uncertainty, shared with the reports
import { approximateHolidayDates } from '../reports/reports.range';

export interface PayrollRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  /** null = no salary set for this employee: not treated as zero, shown separately */
  monthlySalary: string | null;
  targetHours: string;
  /**
   * **How much of the target was really observed.**
   *
   * The deduction is against this number, not `targetHours` (owner's decision:
   * "no deduction for days that were not observed"). The two are shown
   * separately so the answer to **why it is less** is on the sheet itself.
   */
  observedTargetHours: string;
  /** How many work-day rows were really written */
  observedWorkdays: number;
  /**
   * **G37**: their work days (d) and the month's work days (D).
   *
   * **Essential** to show on the sheet: a prorated row has a salary cell below
   * the full monthly salary, and without showing why, someone would ask every
   * month, or in the worst case assume a mistake.
   */
  workdays: number;
  monthWorkdays: number;
  creditedHours: string;
  shortfallHours: string;
  overtimeHours: string;
  hourlyRate: string | null;
  deduction: string | null;
  payable: string | null;

  /**
   * **R21: that month's deposit instalment** (from `security_deposits`).
   *
   * `null`, not zero, if no instalment was set for that month (a month before
   * the rule started, or they had not yet joined). Writing zero would make
   * "0.00 was deducted" look the same as "nothing was meant to be deducted".
   */
  securityDeposit: string | null;

  /**
   * What goes into their hand: `payable − securityDeposit`.
   *
   * The sheet shows **both numbers**, because they answer two different
   * questions: `payable` = what they are owed by the hours, `netPayable` = what
   * is handed over this month. The deposit does **not reduce** the salary, it
   * is only set aside. With one number that difference would be lost, and the
   * refund could not be explained when they leave.
   */
  netPayable: string | null;
  /** how this person is paid that month: monthly | hourly | none */
  payBasis: 'monthly' | 'hourly' | 'none';
  /** money for overtime (only when the policy pays it); null when not computed */
  overtimePay: string | null;
}

export interface PayrollSheet {
  yearMonth: string;
  rows: PayrollRow[];
  /** Staff with no salary set: named instead of being silently left out */
  missingSalary: string[];
  /** Staff whose rollup for that month has not run yet */
  missingSummary: string[];

  /**
   * **R21**: those whose payable is less than that month's deposit instalment.
   *
   * It happens when someone was absent the whole month. `netPayable` would
   * then be negative, and a negative salary means nothing, so it is stopped at
   * zero and the name is **called out separately** here. Stopping it silently
   * would show an instalment deposited in the ledger while the money was never deducted.
   */
  depositExceedsPayable: string[];

  /**
   * **G108**: this month's **holiday dates that are not final yet**.
   *
   * Why this matters most in payroll: every row's `payable` rests on `d ÷ D`,
   * and `D` is counted from **this month's holiday list**. If a lunar date
   * moves, `D` changes, so the **money** changes, and that would be noticed
   * only after the salary had been paid.
   *
   * The list is built with the **same** `approximateHolidayDates()` from
   * `reports.range.ts`, not with a separate query or a `LIKE`; otherwise there
   * would be a second definition of uncertainty, and one day the report and
   * payroll would show two different lists.
   *
   * An empty list means "all this month's dates are final", not "no holidays".
   */
  approximateHolidayDates: string[];
}

const HOUR = 3600;

/**
 * F03: the monthly payroll sheet ([ADR-023](../../../docs/history/05-Options-Decisions.md)).
 *
 * This service is the only place `monthly_salary` is read. No other endpoint
 * selects that column, so there is no way a manager's or staff member's
 * response can leak a salary by mistake.
 */
@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /**
     * R21: opening the sheet also brings the deposit ledger up to date through
     * today (`ledgerFor`). It is not counted here: the calculation must live in
     * one place, otherwise the employee page and the sheet would show two numbers.
     */
    private readonly deposits: DepositsService,
    private readonly features: FeaturesService,
  ) {}

  async sheet(
    yearMonth: string,
    actorUserId: number,
    ip: string,
  ): Promise<PayrollSheet> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
      throw new BadRequestException('The month must be in YYYY-MM format');
    }

    /**
     * **Those who were employed in that month**, not those who are here today.
     *
     * The filter used to be `status: 'active'`, so when someone left they
     * **vanished from their old months' sheets** even though that salary had
     * been paid. The sheet was printed one way and looked different when opened later.
     *
     * Now the question is just one: **did they leave before the month started?**
     */
    const monthStart = new Date(`${yearMonth}-01T00:00:00Z`);

    const employees = await this.prisma.employee.findMany({
      where: {
        /**
         * **No filtering by `joinedOn`, on purpose** (CI caught this).
         *
         * It was first written as "those employed in that month", with a
         * `joinedOn < monthEnd` condition too. But then **someone who joined
         * later would vanish from an earlier month's sheet**, while the
         * documented behaviour is that they stay in the rows with `payable = 0.00`
         * (`proration.e2e.spec.ts`: "joining after the month gives zero payable").
         *
         * The real bug was about staff who **left**, not who joined, so the
         * condition goes only that way.
         */
        OR: [
          { status: EmployeeStatus.active },
          // Left after the month started: that month's salary was due to them,
          // so they must be on the sheet
          { leftOn: { gte: monthStart } },
        ],
      },
      select: {
        id: true,
        empCode: true,
        fullName: true,
        payBasis: true,
        monthlySalary: true,
        hourlyRate: true,
        // the regime: how the target is stated, overtime and shortfall rules
        policy: { select: { ...REGIME_SELECT, deductShortfall: true, overtimeMultiplier: true } },
        /**
         * Old salary slices: `salaryForMonth()` picks that month's real number
         * from these.
         *
         * Only those that ended in or after that month; earlier ones answer
         * nothing about this month, so there is no point pulling them in.
         */
        salaryPeriods: {
          where: { throughMonth: { gte: yearMonth } },
          select: { throughMonth: true, payBasis: true, monthlySalary: true, hourlyRate: true },
        },
      },
      orderBy: { empCode: 'asc' },
    });

    const summaries = await this.prisma.monthlySummary.findMany({
      where: { yearMonth, employeeId: { in: employees.map((e) => e.id) } },
    });
    const byEmployee = new Map(summaries.map((s) => [s.employeeId, s]));

    /**
     * R21: that month's deposit instalments. `depositsFor()` first brings the
     * ledger up to date through today, so opening the sheet also updates the ledger.
     */
    // deposits switched off in Settings → Modules: nothing is held back
    const depositOf = (await this.features.isOn('deposits'))
      ? await this.deposits.instalmentsFor(yearMonth)
      : new Map<number, number>();

    const rows: PayrollRow[] = [];
    const missingSalary: string[] = [];
    const missingSummary: string[] = [];
    const depositExceedsPayable: string[] = [];

    for (const e of employees) {
      const summary = byEmployee.get(e.id);
      if (!summary) {
        missingSummary.push(e.fullName);
        continue;
      }

      /**
       * **Not the current salary: the one in force that month.**
       *
       * It used to read `e.monthlySalary` directly, so raising someone's salary
       * **also changed closed months' sheets** (R1 had protected only the
       * hours). With an empty history `salaryForMonth()` returns the current
       * value, so nothing changes for those whose salary never changed.
       */
      const terms = payTermsForMonth(
        yearMonth,
        {
          payBasis: e.payBasis,
          monthlySalary: e.monthlySalary === null ? null : String(e.monthlySalary),
          hourlyRate: e.hourlyRate === null ? null : String(e.hourlyRate),
        },
        e.salaryPeriods.map((s) => ({
          throughMonth: s.throughMonth,
          payBasis: s.payBasis,
          monthlySalary: s.monthlySalary === null ? null : String(s.monthlySalary),
          hourlyRate: s.hourlyRate === null ? null : String(s.hourlyRate),
        })),
      );
      const salaryThatMonth = terms.monthlySalary;
      const noTarget = !hasTarget(e.policy);

      /**
       * **How much of the target we really observed** (owner's decision: "no
       * deduction for days that were not observed").
       *
       * The bug this fixes: the shortfall was measured against the whole
       * `targetSec`, while `creditedSec` only comes from days the system was
       * running. In August tracking started on the 13th to 15th, so nearly half
       * the month silently became shortfall: the deduction for 12 people came to
       * **79,788.00**, of which **61,280.00** was for days nobody ever observed.
       *
       * The calculation is not new: `proratedExpectedSec()` already works out
       * "the target for how many billable days". Only the numerator changed:
       * `workdaysElapsed` (calendar) → `observedWorkdays` (days whose rows
       * were really written). A second definition would one day make payroll and
       * Monthly give two numbers.
       */
      const observedTargetSec = proratedExpectedSec({
        targetSec: summary.targetSec,
        expectedWorkdays: summary.expectedWorkdays,
        leaveWorkdays: summary.leaveWorkdays,
        workdaysElapsed: summary.observedWorkdays,
      });

      /**
       * **The sheet's shortfall cell shows the same number**, otherwise the
       * screen would say "shortfall 122 hours" while 34 hours were deducted,
       * and nobody could reconcile them. This is the flip side of this repo's
       * most familiar sin: fixing a number in one place and leaving the old one
       * in another.
       */
      const shortfallSec = Math.max(
        0,
        Math.min(observedTargetSec, summary.targetSec) - summary.creditedSec,
      );

      const base = {
        employeeId: e.id,
        empCode: e.empCode,
        fullName: e.fullName,
        targetHours: hours(summary.targetSec),
        /** How much is really being asked for */
        observedTargetHours: hours(observedTargetSec),
        workdays: summary.expectedWorkdays,
        observedWorkdays: summary.observedWorkdays,
        monthWorkdays: summary.monthWorkdays,
        creditedHours: hours(summary.creditedSec),
        shortfallHours: hours(shortfallSec),
        overtimeHours: hours(Math.max(0, summary.creditedSec - summary.targetSec)),
      };

      const amountMissing =
        terms.payBasis === 'monthly'
          ? salaryThatMonth === null
          : terms.payBasis === 'hourly'
            ? terms.hourlyRate === null
            : false;
      // 'none': not paid through oXeio — hours only, no amounts
      if (amountMissing || terms.payBasis === 'none') {
        // Not treated as zero. "No salary set" is not "salary is zero", and
        // taking the first for the second would quietly put a wrong number on the sheet.
        if (amountMissing) missingSalary.push(e.fullName);
        rows.push({
          ...base,
          payBasis: terms.payBasis,
          monthlySalary: null,
          hourlyRate: terms.hourlyRate === null ? null : Number(terms.hourlyRate).toFixed(2),
          deduction: null,
          overtimePay: null,
          payable: null,
          // The instalment is still shown: whether the money was due does not
          // depend on whether a salary is set. But the net cannot be computed,
          // so `netPayable` is null.
          securityDeposit: amountOrNull(depositOf.get(e.id)),
          netPayable: null,
        });
        continue;
      }

      const line = computePayroll({
        // That month's salary, not the current one (see the note above)
        monthlySalary: Number(salaryThatMonth ?? 0),
        targetSec: summary.targetSec,
        creditedSec: summary.creditedSec,
        // The deduction is only against observed days (see the note above)
        observedTargetSec,
        // G37: d and D are written on the row and not counted again here.
        // Counting again, a changed holiday list would make d and D two
        // calculations from two different times.
        workdays: summary.expectedWorkdays,
        monthWorkdays: summary.monthWorkdays,
        // the regime: how they are paid, and the policy's overtime/shortfall rules
        payBasis: terms.payBasis,
        hourlyRate: terms.hourlyRate === null ? undefined : Number(terms.hourlyRate),
        deductShortfall: e.policy?.deductShortfall ?? true,
        overtimeMultiplier:
          e.policy?.overtimeMultiplier === null || e.policy?.overtimeMultiplier === undefined
            ? null
            : Number(e.policy.overtimeMultiplier),
        noTarget,
        // leave is paid: for an hourly rate, the leave days' hours
        paidLeaveSec: summary.leaveWorkdays * dailyTargetSecOf(e.policy),
      });

      const depositMinor = depositOf.get(e.id) ?? null;

      /**
       * There is no such thing as a negative salary. If someone was absent the
       * whole month, `payable` becomes 0 and there is no room to deduct the
       * instalment. The number is stopped at zero, but the name is **called out
       * separately** in `depositExceedsPayable`; stopped silently, the ledger
       * would show it deposited while the money was never deducted.
       */
      if (depositMinor !== null && depositMinor > line.payableMinor) {
        depositExceedsPayable.push(e.fullName);
      }

      rows.push({
        ...base,
        // Not `Number(...).toFixed(2)` on a number: the string came from Decimal,
        // and going through a number midway could silently round the amount
        payBasis: line.payBasis,
        monthlySalary: salaryThatMonth === null ? null : Number(salaryThatMonth).toFixed(2),
        hourlyRate: minorToAmount(line.hourlyRateMinor),
        deduction: minorToAmount(line.deductionMinor),
        overtimePay: minorToAmount(line.overtimePayMinor),
        payable: minorToAmount(line.payableMinor),
        securityDeposit: amountOrNull(depositMinor),
        netPayable: minorToAmount(
          Math.max(0, line.payableMinor - (depositMinor ?? 0)),
        ),
      });
    }

    // Viewing salaries is an event: who looked, and when, is recorded (I-group, audit log)
    await this.audit.record({
      userId: actorUserId,
      action: 'payroll_view',
      targetType: 'payroll',
      targetId: yearMonth,
      ipAddress: ip,
      meta: { rows: rows.length },
    });

    if (missingSummary.length > 0) {
      this.logger.warn(
        `${yearMonth}: ${missingSummary.length} staff have no monthly rollup — they are missing from the sheet`,
      );
    }

    /**
     * G108: exactly this month's holiday rows, and the decision is made by the
     * **same function** as the report, so there is one definition of "approximate".
     */
    const monthEnd = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0),
    );
    const holidayRows = await this.prisma.holiday.findMany({
      where: { holidayDate: { gte: monthStart, lte: monthEnd } },
      select: { holidayDate: true, approximate: true },
    });

    return {
      yearMonth,
      rows,
      missingSalary,
      missingSummary,
      depositExceedsPayable,
      approximateHolidayDates: approximateHolidayDates(
        holidayRows.map((h) => ({ date: h.holidayDate, approximate: h.approximate })),
      ),
    };
  }
}

function hours(sec: number): string {
  return (sec / HOUR).toFixed(2);
}

/** `null` means "no instalment was set that month", not zero */
function amountOrNull(minor: number | null | undefined): string | null {
  return minor === null || minor === undefined ? null : minorToAmount(minor);
}
