import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import { ProgressService, type EmployeeProgress } from '../agent/progress.service';
import { workDateOf } from '../agent/util/work-time';
import {
  designTargetOf,
  designView,
  type DesignView,
} from '../summary/design.rules';
import { DepositsService } from '../deposits/deposits.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseWorkDate, toIsoDate } from '../reports/reports.range';
import { SCREENSHOT_RETENTION_DAYS } from '../summary/retention.job';
import { isWorkday } from '../summary/summary.math';
import type { SessionUser } from '../auth/types';

/** The top section of the employee's own page */
export interface MySummary {
  employee: {
    empCode: string;
    fullName: string;
    designation: string | null;
    joinedOn: string | null;
  };
  progress: EmployeeProgress;
  /**
   * Date the policy was signed. The staff member sees it **on purpose**: the
   * answer to "since when, and on what terms" should be in their own hands.
   */
  policySignedAt: string | null;
  /** "How long screenshots are kept": the promise, with the number, on the page itself */
  screenshotRetentionDays: number;
  /**
   * **Today's designs**: `null` when there is nothing to show.
   *
   * Staff see this themselves **on purpose**: the number they are measured by
   * should be available to them too. By the same logic `policySignedAt` and
   * the retention are on this page.
   * `null` means "this measure does not apply to you", not zero.
   */
  designs: DesignView | null;
}

/** One day's row in the employee's own list */
export interface MyDay {
  workDate: string;
  /** Seconds counted that day (sum of ACTIVE) */
  workedSec: number;
  /** The owner's correction, ± */
  adjustmentSec: number;
  /** worked + adjustment; this is what goes toward the month's target */
  creditedSec: number;
  /** Weekly off day or calendar holiday */
  isOffDay: boolean;
}

const MS_PER_DAY = 86_400_000;

/** How many days at once. Without a ceiling someone could pull the whole table
 * with `from=2000-01-01`. */
export const MY_DAYS_MAX = 92;

/**
 * **J04 · J05 · J08** — the employee's **own** data.
 *
 * <b>There is no `employeeId` parameter here, and that is the core design.</b>
 * With an id in the path a staff member could change the number and see a
 * colleague's whole day; the doc of `employee-activity.controller.ts` states
 * the same worry (the staff's own view must go on a separate path). The id
 * comes **from the session**, so there is no way to get it wrong.
 *
 * <b>The numbers come from `ProgressService`; they are not recomputed.</b>
 * It also feeds the agent's tray. A separate calculation would one day have
 * the tray say "5:42" and the web say "5:39", and staff would ask "which one
 * is true?", breaking trust, the whole point of this feature.
 */
@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly progress: ProgressService,
    private readonly deposits: DepositsService,
  ) {}

  /**
   * **R21: how much of their own deposit has built up.**
   *
   * The employee page shows no salary figures, and this does not break that
   * rule: the deposited amount is **their own money**, not a salary
   * calculation. What the owner pays cannot be derived from it.
   *
   * The month-by-month list is returned too, not just the total. The answer to
   * "which month was it deducted" should be on their own page; otherwise they
   * would have to go to the owner to cross-check, defeating the feature.
   */
  myDeposit(actor: SessionUser) {
    return this.deposits.forEmployee(this.employeeIdOf(actor));
  }

  /**
   * The `employeeId` of an owner or manager is usually `null`: they are not
   * bound to an employee row. This page does not exist for them, and that is not
   * a bug: they see everyone's data under `staff/:id`.
   */
  private employeeIdOf(actor: SessionUser): number {
    if (actor.employeeId === null) {
      throw new ForbiddenException(
        'This account is not linked to a staff record, so there is no personal data to show.',
      );
    }
    return actor.employeeId;
  }

  async summary(actor: SessionUser, now = new Date()): Promise<MySummary> {
    const employeeId = this.employeeIdOf(actor);

    const [employee, progress, designsDone] = await Promise.all([
      this.prisma.employee.findUniqueOrThrow({
        where: { id: employeeId },
        select: {
          empCode: true,
          fullName: true,
          designation: true,
          joinedOn: true,
          policySignedAt: true,
          staffType: true,
          dailyDesignTarget: true,
          policy: { select: { dailyDesignTarget: true } },
        },
      }),
      this.progress.forEmployee(employeeId, now),
      // Designs claimed today (indexed on employee_id, first_work_date)
      this.prisma.designCredit.count({
        where: { employeeId, firstWorkDate: workDateOf(now) },
      }),
    ]);

    return {
      employee: {
        empCode: employee.empCode,
        fullName: employee.fullName,
        designation: employee.designation,
        joinedOn: isoDate(employee.joinedOn),
      },
      progress,
      policySignedAt: isoDate(employee.policySignedAt),
      screenshotRetentionDays: SCREENSHOT_RETENTION_DAYS,
      /**
       * The rule lives in one place (`designView`) and has three states: with a
       * target, a bare count without a target, and nothing. All four screens call
       * the same function, so two screens can never disagree.
       */
      designs: designView(
        employee.staffType,
        designsDone,
        designTargetOf(
          employee.dailyDesignTarget,
          employee.policy?.dailyDesignTarget,
        ),
      ),
    };
  }

  async days(
    actor: SessionUser,
    from: string,
    to: string,
    now = new Date(),
  ): Promise<MyDay[]> {
    const employeeId = this.employeeIdOf(actor);

    /**
     * The DTO only checks the **shape** (regex); 31 February is caught here, by
     * the round-trip check in `parseWorkDate()`.
     *
     * The pure function knows nothing about HTTP, so it throws `RangeError`, and
     * it must be turned into a 400 right here (no global filter does it;
     * `activity.service.ts` does exactly the same). Otherwise a user's typo would
     * come back as a 500 and pile up needless stack traces in the log.
     */
    let start: Date;
    let end: Date;
    try {
      start = parseWorkDate(from);
      end = parseWorkDate(to);
    } catch (err) {
      if (err instanceof RangeError) throw new BadRequestException(err.message);
      throw err;
    }

    if (start > end) return [];

    // A future day is clamped to today; a long tail of empty rows would only
    // give the impression of "you did nothing".
    const today = workDateOf(now);
    const last = end > today ? today : end;

    const span = Math.floor((last.getTime() - start.getTime()) / MS_PER_DAY) + 1;
    if (span < 1) return [];

    const first =
      span > MY_DAYS_MAX
        ? new Date(last.getTime() - (MY_DAYS_MAX - 1) * MS_PER_DAY)
        : start;

    const [segments, adjustments, employee, holidayRows] = await Promise.all([
      /**
       * Raw `activity_segments`, not `daily_summary`, for the same reason
       * `ProgressService` does it: the rollup runs every 15 minutes, and a staff
       * member checking today's hours and seeing "0" would assume data was lost.
       */
      this.prisma.activitySegment.groupBy({
        by: ['workDate'],
        where: {
          employeeId,
          countsAsWork: true,
          workDate: { gte: first, lte: last },
        },
        _sum: { durationSec: true },
      }),
      // `revokedAt: null`: a revoked adjustment does not give hours back
      this.prisma.timeAdjustment.groupBy({
        by: ['workDate'],
        where: {
          employeeId,
          revokedAt: null,
          workDate: { gte: first, lte: last },
        },
        _sum: { deltaSec: true },
      }),
      this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { policy: { select: { weeklyOffDays: true } } },
      }),
      this.prisma.holiday.findMany({
        where: { holidayDate: { gte: first, lte: last } },
        select: { holidayDate: true },
      }),
    ]);

    const workedBy = new Map(
      segments.map((s) => [s.workDate.getTime(), s._sum.durationSec ?? 0]),
    );
    const adjustBy = new Map(
      adjustments.map((a) => [a.workDate.getTime(), a._sum.deltaSec ?? 0]),
    );
    const holidays = new Set(holidayRows.map((h) => h.holidayDate.getTime()));
    const off = employee?.policy?.weeklyOffDays ?? [];

    const rows: MyDay[] = [];

    /**
     * **A row is created for every day, not only the days with work.** With gaps,
     * the 9th and 11th would sit side by side and the 10th would look like it
     * never existed, yet that is the day the agent was off, which is exactly the
     * day staff have questions about.
     */
    for (let t = first.getTime(); t <= last.getTime(); t += MS_PER_DAY) {
      const worked = workedBy.get(t) ?? 0;
      const adjustment = adjustBy.get(t) ?? 0;
      const date = new Date(t);

      rows.push({
        workDate: toIsoDate(date),
        workedSec: worked,
        adjustmentSec: adjustment,
        creditedSec: worked + adjustment,
        // `isWorkday()` is the same function used to compute the month's target.
        // Writing a separate "is it Friday?" check would skip the `holidays`
        // table, and Eid days would show up as ordinary work days.
        isOffDay: !isWorkday(date, off, holidays),
      });
    }

    // Newest day first: people look for today's row first
    return rows.reverse();
  }
}

/** `@db.Date` → `YYYY-MM-DD`, null stays null */
function isoDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}
