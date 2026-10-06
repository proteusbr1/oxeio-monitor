import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { workDateOf } from '../agent/util/work-time';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { paisaToTaka } from '../payroll/payroll.math';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkNotice,
  effectiveDepositStart,
  isYearMonth,
  monthsBetween,
  type YearMonth,
} from './deposit.math';
import type { SettleDepositDto, UpdateDepositPolicyDto } from './dto';

export interface DepositPolicyView {
  amount: string;
  amountPaisa: number;
  startYearMonth: string;
  noticeDays: number;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface DepositMonth {
  yearMonth: string;
  amount: string;
}

export interface DepositSettlementView {
  outcome: 'refunded' | 'forfeited';
  amount: string;
  noticeGivenOn: string | null;
  lastWorkingDay: string | null;
  noticeDaysGiven: number | null;
  noticeDaysRule: number;
  note: string | null;
  settledAt: string;
  settledBy: string;
}

export interface DepositBalance {
  employeeId: number;
  empCode: string;
  fullName: string;
  status: string;
  months: number;
  balance: string;
  balancePaisa: number;
  /** Once settled the ledger is closed — `balance` is then only history */
  settlement: DepositSettlementView | null;

  /**
   * The start month the owner picked for this employee — `null` if none.
   *
   * Careful: `effectiveStart` is sent too, because the screen needs **the
   * month deductions really start from** — that depends on which of the
   * override, the joining month and the policy month won. Sending only the
   * override would leave an empty cell, and the owner would not know which
   * month is actually in force.
   */
  startYearMonth: string | null;
  effectiveStart: string | null;
}

/**
 * **Security money (deposit).**
 *
 * The owner's rule: 500 taka is held back from salary each month, and anyone
 * who leaves after giving 30 days' notice gets the whole amount back.
 *
 * **The ledger is written down, not calculated** — the money held is the
 * history of an event, not the result of today's rule. If the amount became 600
 * tomorrow, the last six months' deposits would grow backwards, and the ledger
 * would claim money nobody ever paid.
 *
 * Careful: instalments are posted **lazily** (`ensureLedger`) — there is no
 * cron. With a cron, one day of server downtime would silently skip a month
 * and nobody would notice. Here, whoever opens the ledger fills it up to
 * today at that moment.
 */
@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The current month in the Dhaka calendar — `2026-08` */
  private currentMonth(): YearMonth {
    return workDateOf(new Date()).toISOString().slice(0, 7);
  }

  async policy(): Promise<DepositPolicyView> {
    const row = await this.prisma.depositPolicy.findUnique({ where: { id: 1 } });

    /**
     * Careful: the row is inserted by the migration. If it is still missing, an
     * error is **thrown**, no empty default is made up — otherwise, with the
     * database half set up, the system would start deducting employees' pay
     * under a rule of its own invention.
     */
    if (!row) {
      throw new NotFoundException(
        'The deposit rule has not been set up — run the database migrations.',
      );
    }

    return {
      amount: paisaToTaka(row.amountPaisa),
      amountPaisa: row.amountPaisa,
      startYearMonth: row.startYearMonth,
      noticeDays: row.noticeDays,
      active: row.active,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }

  async updatePolicy(
    actor: SessionUser,
    dto: UpdateDepositPolicyDto,
    ip: string,
  ): Promise<DepositPolicyView> {
    const before = await this.policy();

    if (dto.startYearMonth && !isYearMonth(dto.startYearMonth)) {
      throw new BadRequestException('The start month must be in YYYY-MM format');
    }

    /**
     * Careful: moving the start month **back** will post new instalments in the
     * earlier months, and that is right — the owner is deliberately adding old
     * months. But moving it **forward** does not remove the earlier instalments
     * by itself: that money has already been deducted. If it was a mistake, the
     * row has to be deleted by hand — better than money silently vanishing.
     */
    await this.prisma.depositPolicy.update({
      where: { id: 1 },
      data: {
        amountPaisa: dto.amountPaisa ?? undefined,
        startYearMonth: dto.startYearMonth ?? undefined,
        noticeDays: dto.noticeDays ?? undefined,
        active: dto.active ?? undefined,
        updatedBy: actor.email,
      },
    });

    const after = await this.policy();

    await this.audit.record({
      userId: actor.userId,
      action: 'deposit_policy_update',
      targetType: 'deposit_policy',
      targetId: 1,
      ipAddress: ip,
      // Careful: `{ ...before }` — `DepositPolicyView` is an interface, and
      // Prisma's `InputJsonValue` wants an index signature. Spreading satisfies
      // that, so no `as any` is needed to silence the type.
      meta: { before: { ...before }, after: { ...after } },
    });

    return after;
  }

  /**
   * Fill the ledger up to today — **idempotent**.
   *
   * Careful: without `skipDuplicates`, opening two tabs at once would post an
   * instalment twice. The key (`employee_id`, `year_month`) is also UNIQUE in
   * the database, so the last safeguard against the race is there too.
   */
  private async ensureLedger(): Promise<void> {
    const policy = await this.prisma.depositPolicy.findUnique({
      where: { id: 1 },
    });
    if (!policy || !policy.active) return;

    const now = this.currentMonth();
    if (policy.startYearMonth > now) return;

    const employees = await this.prisma.employee.findMany({
      select: {
        id: true,
        joinedOn: true,
        leftOn: true,
        status: true,
        depositStartYearMonth: true,
      },
    });

    // Careful: a settled employee's ledger gets no more instalments — the money
    // has been refunded (or forfeited), the ledger is closed.
    const settled = new Set(
      (
        await this.prisma.depositSettlement.findMany({
          select: { employeeId: true },
        })
      ).map((s) => s.employeeId),
    );

    const rows: { employeeId: number; yearMonth: string; amountPaisa: number }[] =
      [];

    for (const e of employees) {
      if (settled.has(e.id)) continue;

      /**
       * Careful: no instalment is posted for months **before** joining. If
       * `joined_on` is missing, the policy's start month is used — safer than
       * guessing and going back, because going back would make the ledger claim
       * money from a time when they were not here.
       */
      // The rule is in `deposit.math.ts`, one definition — so the screen and the
      // ledger never name different months
      const from = effectiveDepositStart({
        override: e.depositStartYearMonth,
        joinedMonth: e.joinedOn ? e.joinedOn.toISOString().slice(0, 7) : null,
        policyStart: policy.startYearMonth,
      });

      // Careful: if they left, only up to their last month — no salary after that.
      const leftMonth = e.leftOn ? e.leftOn.toISOString().slice(0, 7) : null;
      const to = leftMonth && leftMonth < now ? leftMonth : now;

      if (from > to) continue;

      for (const yearMonth of monthsBetween(from, to)) {
        rows.push({ employeeId: e.id, yearMonth, amountPaisa: policy.amountPaisa });
      }
    }

    if (rows.length === 0) return;

    /**
     * **No new instalments in a closed month.**
     *
     * Careful: **the bug this fixes:** every money path refuses to touch a
     * closed month — `correctInstalment()`, time corrections, leave, rollup,
     * payroll history — only `ensureLedger()` did not. Yet it runs the most:
     * Deposits page, the employee's own `/me/deposit`, **and the payroll sheet itself**.
     *
     * Careful: so if a closed month had a gap (a late joiner, the rule paused
     * and resumed, or the start month moved back), the next page load would
     * push ৳500 into that month — **after the paper had gone out**. The ledger
     * would say the money was deducted, but the payslip would not show it.
     *
     * Careful: **it is filtered out, not thrown** — this runs on every page
     * load, so throwing would break the Deposits page, the employee portal and
     * the payroll sheet all at once.
     *
     * Careful: **it is filtered out, not thrown** — this runs on every page
     * load, so throwing would break the Deposits page, the employee portal and
     * the payroll sheet all at once.
     *
     * Careful: **filtered by month, not by range** — closed months are not
     * contiguous (a month in the middle can be open, and `month-close` can
     * reopen one). A "skip up to the newest closed month" rule would miss gaps
     * and lock later months forever.
     */
    const months = [...new Set(rows.map((r) => r.yearMonth))];
    const shut = new Set(
      (
        await this.prisma.monthClosure.findMany({
          where: { yearMonth: { in: months } },
          select: { yearMonth: true },
        })
      ).map((m) => m.yearMonth),
    );

    const open = rows.filter((r) => !shut.has(r.yearMonth));
    const skipped = rows.length - open.length;

    if (skipped > 0) {
      // Careful: not dropped silently — this gap survived for so long thanks to silence
      this.logger.warn(
        `${skipped} deposit installments were not inserted — closed months (${[...shut].join(', ')}). ` +
          'If needed, reopen the month first.',
      );
    }

    if (open.length === 0) return;

    const { count } = await this.prisma.securityDeposit.createMany({
      data: open,
      skipDuplicates: true,
    });

    if (count > 0) {
      this.logger.log(`${count} new installments added to the deposit ledger`);
    }
  }

  /**
   * **From which month this employee's deposit deductions start** — set by the
   * owner by hand.
   *
   * Careful: **old instalments are removed, and that is the real job of this
   * feature.** Moving the start month back posts new instalments; **moving it
   * forward deletes the earlier wrong instalments**. Without deleting, even
   * after "correcting the mistake" the ledger would keep it, and the owner
   * would think it had not saved.
   *
   * Careful: the deleted rows are **automatically posted** instalments, nothing
   * written by hand — so this is correcting a wrong calculation, not erasing
   * history. How many were removed is written to the audit log.
   *
   * Careful: a settled employee's ledger is **closed** — the money has been
   * refunded or forfeited, so touching it would disturb a finished account.
   */
  async setStartMonth(
    actor: SessionUser,
    employeeId: number,
    yearMonth: string | null,
    ip: string,
  ): Promise<{ removed: number; added: number }> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, depositStartYearMonth: true },
    });
    if (!employee) throw new NotFoundException('Staff member not found');

    if (yearMonth !== null && !isYearMonth(yearMonth)) {
      throw new BadRequestException('Month must be in YYYY-MM format');
    }

    /**
     * Careful: future months are refused — otherwise the ledger would quietly go
     *    empty (no instalment would ever be posted), and the screen would not say why.
     */
    if (yearMonth !== null && yearMonth > this.currentMonth()) {
      throw new BadRequestException('That month has not started yet');
    }

    const settled = await this.prisma.depositSettlement.findFirst({
      where: { employeeId },
      select: { employeeId: true },
    });
    if (settled) {
      throw new ConflictException(
        'This deposit is already settled — the ledger is closed, so the start month cannot change',
      );
    }

    // Careful: nothing changed — no event is written to the audit log
    if ((employee.depositStartYearMonth ?? null) === yearMonth) {
      return { removed: 0, added: 0 };
    }

    await this.prisma.employee.update({
      where: { id: employeeId },
      data: { depositStartYearMonth: yearMonth },
    });

    /**
     * Careful: earlier months' instalments are removed **only when a new start
     *    is set**. With `null` (back to the policy's general month) nothing is
     *    deleted — the ledger will fill up again by itself, and there is no
     *    point risking deleting rows for nothing.
     */
    let removed = 0;
    if (yearMonth !== null) {
      /**
       * Careful: **rows of closed months cannot be deleted either**.
       *
       * Blocking only the posting would be half the job: moving the start month
       * forward would make this `deleteMany` remove a closed month's instalment
       * too, and money already on paper would vanish from the ledger. The rule
       * applies both ways: a closed month **does not move**.
       */
      const closed = (
        await this.prisma.monthClosure.findMany({ select: { yearMonth: true } })
      ).map((m) => m.yearMonth);

      const gone = await this.prisma.securityDeposit.deleteMany({
        where: {
          employeeId,
          yearMonth: { lt: yearMonth, ...(closed.length > 0 ? { notIn: closed } : {}) },
        },
      });
      removed = gone.count;
    }

    const before = await this.prisma.securityDeposit.count({ where: { employeeId } });
    await this.ensureLedger();
    const after = await this.prisma.securityDeposit.count({ where: { employeeId } });

    await this.audit.record({
      userId: actor.userId,
      action: 'deposit_policy_update',
      targetType: 'employee',
      targetId: employeeId,
      ipAddress: ip,
      meta: {
        op: 'deposit_start_month',
        from: employee.depositStartYearMonth,
        to: yearMonth,
        removed,
        added: after - before,
      },
    });

    this.logger.log(
      `${employee.fullName}: deposit start ${employee.depositStartYearMonth ?? 'default'} → ` +
        `${yearMonth ?? 'default'} (${removed} removed, ${after - before} added)`,
    );

    return { removed, added: after - before };
  }

  /**
   * **Correcting the amount of an instalment already posted.**
   *
   * Careful: **why it was needed:** once an instalment was posted with a wrong
   * amount there was **no way at all** to fix it. `ensureLedger()` runs with
   * `createMany({ skipDuplicates: true })`, so an existing row is never
   * updated — and that is deliberate (when the rule's amount changes, old
   * months are not rewritten). As a result a ৳0 row sat in the field for two
   * weeks, and the page showed *"2 months held · ৳500"*.
   *
   * It was eventually fixed with a **trick**: move the start month forward to
   * delete the row, then set it back to the rule so it was re-posted. It worked
   * **only because the wrong month was at the beginning**; for a month in the
   * middle the trick would have deleted all the earlier months too. The trick
   * was not written down anywhere.
   *
   * Careful: **this is "correcting a mistake", not "changing the rule"** — so
   * `reason` is mandatory, just like `time_adjustments`. Six months later the
   * ledger itself has to answer "why 300 for this person when others got 500
   * that month".
   *
   * Careful: **zero cannot be entered** — the database `CHECK` blocks it too.
   * A waiver means there is **no** instalment that month, not an instalment of
   * ৳0; merging the two ruins the answer to "how many months have been paid".
   * To skip early months there is `setStartMonth()`.
   * TODO: there is **still no way to waive a month in the middle** — if needed
   *    it is a separate decision (keep the row with a `waived` flag, or delete
   *    it), and if deleted, `ensureLedger()` would post it again.
   */
  async correctInstalment(
    actor: SessionUser,
    employeeId: number,
    yearMonth: string,
    amountPaisa: number,
    reason: string,
    ip: string,
  ): Promise<{ from: number; to: number }> {
    if (!isYearMonth(yearMonth)) {
      throw new BadRequestException('Month must be in YYYY-MM format');
    }

    /**
     * Careful: 0 or negative is stopped here, not left to the database `CHECK` —
     *    otherwise the message would be a raw Postgres error, and the owner
     *    would not understand what they did wrong.
     */
    if (!Number.isInteger(amountPaisa) || amountPaisa <= 0) {
      throw new BadRequestException(
        'The instalment must be more than zero — to skip the early months use the start month instead',
      );
    }

    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(
        'Write why — six months from now this line is the only answer',
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, empCode: true },
    });
    if (!employee) throw new NotFoundException('Staff member not found');

    /**
     * Careful: once settled the ledger is closed — the money has been refunded
     *    or forfeited, so changing the amount now would disturb a finished account.
     *    The condition is exactly the same as in `setStartMonth()`.
     */
    const settled = await this.prisma.depositSettlement.findFirst({
      where: { employeeId },
      select: { employeeId: true },
    });
    if (settled) {
      throw new ConflictException(
        'This deposit is already settled — the ledger is closed',
      );
    }

    /**
     * Careful: **no correction in a closed month** (R1) — exactly the same rule
     *    as for leave and corrections. A closed month means that month's paper
     *    has gone out; changing the ledger would make paper and ledger say two
     *    things, and nobody would notice.
     */
    const closed = await this.prisma.monthClosure.findUnique({
      where: { yearMonth },
      select: { yearMonth: true },
    });
    if (closed) {
      throw new ConflictException(
        `${yearMonth} is closed — reopen the month first`,
      );
    }

    /**
     * Careful: the row **must exist**. If it does not, this is not a correction
     *    but posting a new instalment — and that is `ensureLedger()`'s job,
     *    following the rule. Allowing it here would put a month in the ledger
     *    that came from no rule.
     */
    const row = await this.prisma.securityDeposit.findUnique({
      where: { employeeId_yearMonth: { employeeId, yearMonth } },
    });
    if (!row) {
      throw new NotFoundException(
        `No instalment for ${yearMonth} — the ledger only holds months the rule created`,
      );
    }

    // Careful: nothing changed — no event is written to the ledger (same rule as setStartMonth)
    if (row.amountPaisa === amountPaisa) return { from: row.amountPaisa, to: amountPaisa };

    await this.prisma.securityDeposit.update({
      where: { employeeId_yearMonth: { employeeId, yearMonth } },
      data: { amountPaisa },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'deposit_policy_update',
      targetType: 'employee',
      targetId: employeeId,
      ipAddress: ip,
      meta: {
        op: 'deposit_instalment_corrected',
        empCode: employee.empCode,
        yearMonth,
        fromPaisa: row.amountPaisa,
        toPaisa: amountPaisa,
        why: trimmed,
      },
    });

    this.logger.warn(
      `${employee.fullName}: ${yearMonth} installment ${row.amountPaisa} → ${amountPaisa} paisa · ${trimmed}`,
    );

    return { from: row.amountPaisa, to: amountPaisa };
  }

  /**
   * One month's instalments, per employee — the payroll sheet calls this.
   *
   * Careful: in the map, **an employee with no instalment has no key**, not
   * zero. On the sheet "৳0 deducted" and "was never meant to be deducted" are
   * different things, and a zero would show both the same.
   */
  async instalmentsFor(yearMonth: string): Promise<Map<number, number>> {
    await this.ensureLedger();

    const rows = await this.prisma.securityDeposit.findMany({
      where: { yearMonth },
      select: { employeeId: true, amountPaisa: true },
    });

    return new Map(rows.map((r) => [r.employeeId, r.amountPaisa]));
  }

  /** One person's month-by-month list and total — staff call this to see their own */
  async forEmployee(employeeId: number): Promise<{
    months: DepositMonth[];
    total: string;
    totalPaisa: number;
    settlement: DepositSettlementView | null;
    noticeDays: number;
  }> {
    await this.ensureLedger();

    const [rows, settlement, policy] = await Promise.all([
      this.prisma.securityDeposit.findMany({
        where: { employeeId },
        orderBy: { yearMonth: 'asc' },
      }),
      this.prisma.depositSettlement.findUnique({ where: { employeeId } }),
      this.policy(),
    ]);

    const totalPaisa = rows.reduce((sum, r) => sum + r.amountPaisa, 0);

    return {
      months: rows.map((r) => ({
        yearMonth: r.yearMonth,
        amount: paisaToTaka(r.amountPaisa),
      })),
      total: paisaToTaka(totalPaisa),
      totalPaisa,
      settlement: settlement ? toSettlementView(settlement) : null,
      noticeDays: policy.noticeDays,
    };
  }

  /** Everyone's deposits — the list for the owner's screen */
  async balances(): Promise<{ rows: DepositBalance[]; policy: DepositPolicyView }> {
    await this.ensureLedger();

    const [employees, sums, settlements, policy] = await Promise.all([
      this.prisma.employee.findMany({
        select: {
          id: true,
          empCode: true,
          fullName: true,
          status: true,
          joinedOn: true,
          depositStartYearMonth: true,
        },
        orderBy: { empCode: 'asc' },
      }),
      this.prisma.securityDeposit.groupBy({
        by: ['employeeId'],
        _sum: { amountPaisa: true },
        _count: { _all: true },
      }),
      this.prisma.depositSettlement.findMany(),
      this.policy(),
    ]);

    const sumOf = new Map(sums.map((s) => [s.employeeId, s]));
    const settledOf = new Map(settlements.map((s) => [s.employeeId, s]));

    return {
      policy,
      rows: employees.map((e) => {
        const agg = sumOf.get(e.id);
        const balancePaisa = agg?._sum.amountPaisa ?? 0;
        const settlement = settledOf.get(e.id);

        // The same function `ensureLedger()` calls, used here too
        const effectiveStart = effectiveDepositStart({
          override: e.depositStartYearMonth,
          joinedMonth: e.joinedOn ? e.joinedOn.toISOString().slice(0, 7) : null,
          policyStart: policy.startYearMonth,
        });

        return {
          startYearMonth: e.depositStartYearMonth,
          effectiveStart,
          employeeId: e.id,
          empCode: e.empCode,
          fullName: e.fullName,
          status: e.status,
          months: agg?._count._all ?? 0,
          balance: paisaToTaka(balancePaisa),
          balancePaisa,
          settlement: settlement ? toSettlementView(settlement) : null,
        };
      }),
    };
  }

  /**
   * **Settlement — the owner decides, the system does the arithmetic.**
   *
   * Careful: whether or not the rule is met, the owner sends `outcome`. The
   * system only works out `noticeDaysGiven` and records it on the row — so
   * that if someone asks six months later "on what basis", the answer is in
   * the ledger. There are always exceptions (hospital, family reasons), and
   * no `if` can capture them.
   */
  async settle(
    actor: SessionUser,
    employeeId: number,
    dto: SettleDepositDto,
    ip: string,
  ): Promise<DepositSettlementView> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, empCode: true, fullName: true },
    });
    if (!employee) throw new NotFoundException('No such employee');

    const existing = await this.prisma.depositSettlement.findUnique({
      where: { employeeId },
    });
    if (existing) {
      // Careful: 409, not silently a second row — nowhere would record that the
      // money was refunded twice.
      throw new ConflictException(
        `The deposit of ${employee.empCode} is already settled (${existing.outcome}).`,
      );
    }

    await this.ensureLedger();

    const agg = await this.prisma.securityDeposit.aggregate({
      where: { employeeId },
      _sum: { amountPaisa: true },
    });
    const amountPaisa = agg._sum.amountPaisa ?? 0;

    const policy = await this.policy();
    const notice = checkNotice(
      dto.noticeGivenOn ? new Date(dto.noticeGivenOn) : null,
      dto.lastWorkingDay ? new Date(dto.lastWorkingDay) : null,
      policy.noticeDays,
    );

    const row = await this.prisma.depositSettlement.create({
      data: {
        employeeId,
        outcome: dto.outcome,
        amountPaisa,
        noticeGivenOn: dto.noticeGivenOn ? new Date(dto.noticeGivenOn) : null,
        lastWorkingDay: dto.lastWorkingDay ? new Date(dto.lastWorkingDay) : null,
        noticeDaysGiven: notice.daysGiven,
        noticeDaysRule: notice.daysRule,
        note: dto.note ?? null,
        settledBy: actor.email,
      },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'deposit_settle',
      targetType: 'employee',
      targetId: employeeId,
      ipAddress: ip,
      meta: {
        empCode: employee.empCode,
        outcome: dto.outcome,
        amount: paisaToTaka(amountPaisa),
        // What the rule said and what the owner did — both are kept, because
        // for an exception that very pair is what has to be looked at later
        noticeDaysGiven: notice.daysGiven,
        noticeDaysRule: notice.daysRule,
        followedRule: notice.meetsRule === (dto.outcome === 'refunded'),
      },
    });

    return toSettlementView(row);
  }
}

function toSettlementView(row: {
  outcome: string;
  amountPaisa: number;
  noticeGivenOn: Date | null;
  lastWorkingDay: Date | null;
  noticeDaysGiven: number | null;
  noticeDaysRule: number;
  note: string | null;
  settledAt: Date;
  settledBy: string;
}): DepositSettlementView {
  return {
    outcome: row.outcome as 'refunded' | 'forfeited',
    amount: paisaToTaka(row.amountPaisa),
    noticeGivenOn: row.noticeGivenOn?.toISOString().slice(0, 10) ?? null,
    lastWorkingDay: row.lastWorkingDay?.toISOString().slice(0, 10) ?? null,
    noticeDaysGiven: row.noticeDaysGiven,
    noticeDaysRule: row.noticeDaysRule,
    note: row.note,
    settledAt: row.settledAt.toISOString(),
    settledBy: row.settledBy,
  };
}
