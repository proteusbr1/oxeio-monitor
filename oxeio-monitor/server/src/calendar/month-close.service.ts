import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { workDateOf } from '../agent/util/dhaka-time';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { MonthDeliveryService } from '../reports/month-delivery.service';

export interface MonthClosureView {
  yearMonth: string;
  closedAt: string;
  closedBy: string;
  note: string | null;
}

/**
 * **R1: closing a month (payroll lock).**
 *
 * Careful: the problem this fixes, and why it comes "first of all":
 * `refreshMonth()` **recounts the `monthly_summary` numbers every time**, and
 * when counting it reads the `holidays` table **as of that moment**. So if a
 * holiday date moved, or a time adjustment for an old month was approved or
 * revoked, last month's `target_sec`, `expected_sec`, d and D would all
 * change retroactively. Payroll reads d and D from that row, so **the figures
 * would move even after pay was given**, silently.
 *
 * Closing does not **copy** the numbers anywhere: they stay in
 * `monthly_summary`, and are just no longer touched. One number, one place.
 */
@Injectable()
export class MonthCloseService {
  private readonly logger = new Logger(MonthCloseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly delivery: MonthDeliveryService,
  ) {}

  async list(): Promise<{ rows: MonthClosureView[] }> {
    const rows = await this.prisma.monthClosure.findMany({
      orderBy: { yearMonth: 'desc' },
    });
    return { rows: rows.map(toView) };
  }

  /**
   * Careful: **the current and future months cannot be closed.**
   *
   * The current month is still running: closing it would stop today's hours
   * being added, and the screen's numbers would freeze by midday. Careful: the
   * failure would be **silent**: someone would complain "today's hours are not
   * showing up", and nobody would think to look here. A future month has
   * nothing to count anyway.
   */
  async close(
    actor: SessionUser,
    yearMonth: string,
    note: string | undefined,
    ip: string,
  ): Promise<MonthClosureView> {
    assertYearMonth(yearMonth);

    const current = workDateOf(new Date()).toISOString().slice(0, 7);
    if (yearMonth >= current) {
      throw new BadRequestException(
        yearMonth === current
          ? `${yearMonth} is still running — a month can only be closed once it is over`
          : `${yearMonth} is in the future — there is nothing to close`,
      );
    }

    const existing = await this.prisma.monthClosure.findUnique({
      where: { yearMonth },
    });
    if (existing) {
      // Careful: 409, and **the first closer's name and date stay**. If a second
      // close overwrote the record, the answer to "when was it frozen" would be lost.
      throw new ConflictException(
        `${yearMonth} was already closed on ${existing.closedAt.toISOString().slice(0, 10)} by ${existing.closedBy}`,
      );
    }

    /**
     * Careful: **no final recount right before closing**, deliberately. The
     * numbers are fresh every 15 minutes anyway (K06), and recounting here
     * would make "closing" itself a **change**: the number the owner saw when
     * deciding to close could differ after closing.
     */
    const row = await this.prisma.monthClosure.create({
      data: { yearMonth, closedBy: actor.email, note: note?.trim() || null },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'month_closed',
      targetType: 'month',
      targetId: yearMonth,
      ipAddress: ip,
      meta: { note: row.note },
    });

    /**
     * **R26: the calculation file goes out by itself.**
     *
     * Careful: `void` + `.catch()`, and never `await`, for three reasons:
     *  1. The row was **already committed above** (`create` in its own
     *     transaction), so a failure here cannot touch the month closing.
     *  2. With `await` the owner's HTTP request would hang for the whole
     *     upload (several MB, up to 60 seconds), and if it threw, a
     *     **successful** month close would come back as 500, and they would
     *     retry and get a 409.
     *  3. Without `.catch()` a floating promise becomes an unhandled rejection
     *     and takes down the whole API process (the same lesson as in
     *     `alerts.scheduler.ts`).
     *
     * Careful: if someone later wraps `close()` in a `$transaction`, this call
     *    must be moved **outside** the callback; otherwise a running upload
     *    would exceed Prisma's 5-second limit and roll back the real month close.
     */
    void this.delivery
      .deliverClosedMonth(yearMonth)
      .catch((err: unknown) =>
        this.logger.error(
          `Auto-delivery for ${yearMonth} failed (the month is closed regardless)`,
          err instanceof Error ? err.stack : undefined,
        ),
      );

    this.logger.log(`${yearMonth} closed by ${actor.email}`);
    return toView(row);
  }

  /**
   * Careful: it can be reopened, but **the trace stays**: two rows in the
   * audit (`month_closed`, `month_reopened`). If someone reopens a month after
   * pay and changes the numbers, that can be shown with proof; there is no way
   * back in silently.
   *
   * Reopening does not change the numbers **by itself**: the next rollup
   * (K06, 15 minutes) or an adjustment will. So reopening is not harm in
   * itself, it means "may move again".
   */
  async reopen(
    actor: SessionUser,
    yearMonth: string,
    ip: string,
  ): Promise<{ yearMonth: string; reopened: true }> {
    assertYearMonth(yearMonth);

    const existing = await this.prisma.monthClosure.findUnique({
      where: { yearMonth },
    });
    if (!existing) throw new NotFoundException(`${yearMonth} is not closed`);

    await this.prisma.monthClosure.delete({ where: { yearMonth } });

    await this.audit.record({
      userId: actor.userId,
      action: 'month_reopened',
      targetType: 'month',
      targetId: yearMonth,
      ipAddress: ip,
      meta: {
        closedAt: existing.closedAt.toISOString(),
        closedBy: existing.closedBy,
      },
    });

    this.logger.warn(`${yearMonth} reopened by ${actor.email} — figures can move again`);
    return { yearMonth, reopened: true };
  }
}

function toView(row: {
  yearMonth: string;
  closedAt: Date;
  closedBy: string;
  note: string | null;
}): MonthClosureView {
  return {
    yearMonth: row.yearMonth,
    closedAt: row.closedAt.toISOString(),
    closedBy: row.closedBy,
    note: row.note,
  };
}

/**
 * Careful: silently accepting `2026-8` or `2026-13` would put a key that
 * never matches into the DB, and the month would look "closed" while no
 * guard worked, because `refreshMonth()` looks for the `2026-08` form.
 */
function assertYearMonth(value: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new BadRequestException('yearMonth must look like 2026-08');
  }
}
