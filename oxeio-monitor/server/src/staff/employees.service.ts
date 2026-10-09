import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { workDateOf } from '../agent/util/work-time';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { supersededThrough } from '../payroll/payroll.math';
import { PrismaService } from '../prisma/prisma.service';
import { nextEmployeeCode } from './next-code';
import { ADMIN_TARGET } from '../audit/admin-audit';
import { parseCalendarDate } from '../calendar/calendar-date';
import { MEASURE_SELECT, sameMeasure } from '../calendar/work-regime';
import { SCHEDULE_SELECT, sameSchedule, schedulePolicyOf } from '../schedule/schedule-policy';
import { markDirty, policyRecountDates } from '../summary/recount';
import type { CreateEmployeeDto, DeactivateEmployeeDto, EmployeeListQueryDto, UpdateEmployeeDto } from './staff.dto';
import {
  canSeeSalary,
  toEmployeeView,
  toEmployeeViews,
  type EmployeeRow,
  type EmployeeView,
} from './redact';

/**
 * Maximum attempts to assign an employee code (see `createWithGeneratedCode`).
 *
 * Careful: five, because each failure means another owner added an employee
 * at that very moment. Five times in a row is practically impossible in a
 * 15-person office; a higher number would hide a real problem.
 */
const CODE_ATTEMPTS = 5;

/**
 * Is this P2002 a conflict on the **code**, or on the email?
 *
 * Careful: both UNIQUE columns raise the same error code. Without telling
 * them apart, a duplicate email would still trigger five attempts at a new
 * code: the same 409, only five times slower.
 */
function isEmpCodeConflict(err: unknown): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2002'
  ) {
    return false;
  }

  const raw: unknown = err.meta?.target;
  const target = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');

  return target.includes('emp_code') || target.includes('empCode');
}

/**
 * Careful: one select, the same everywhere. If columns were picked in
 * different places, `monthlySalary` would leak in somewhere and `redact`
 * would not notice, since it would never have been handed a field it should
 * have filtered out.
 */
const EMPLOYEE_SELECT = {
  id: true,
  empCode: true,
  fullName: true,
  email: true,
  designation: true,
  department: true,
  receivesTasks: true,
  /** Their own daily task target; `null` means the policy's value applies. */
  dailyTaskTarget: true,
  policyId: true,
  monthlySalary: true,
  payBasis: true,
  hourlyRate: true,
  joinedOn: true,
  leftOn: true,
  status: true,
  policySignedAt: true,
  policyDocPath: true,
  createdAt: true,

  /**
   * **How far setup has got.** Before the agent can be installed, two things
   * are needed: a login for the person, then an enrolled device.
   *
   * Careful: neither used to appear in the list, so the owner had to click
   * through 15 rows to see whose account was opened and whose was not. If one
   * was missed, it showed only at that PC, when the person could not sign in.
   *
   * It uses `_count` rather than fetching rows: the user's email or the
   * device token has no reason to be in this response.
   */
  /**
   * Careful: `_count` was there, but it **cannot do two kinds of counting**;
   * Prisma gives only one filtered count per relation. Both are needed: is
   * there an active device, and is there a revoked device. Otherwise "an agent
   * was never installed" and "the agent was switched off" cannot be told
   * apart, yet the first needs a visit to the PC and the second needs just a
   * button on the row.
   *
   * So rows are fetched, but **only `status`**: no hostname, token or
   * machineGuid. The main promise of `_count` (a whitelist) still holds; only
   * the shape changed.
   */
  devices: { select: { status: true } },

  /**
   * The portal account: **id and email**, not just "exists or not".
   *
   * Careful: without the id, the screen could not reset a password or change
   * the email (both `/users/:id/...` routes need the id). `resetUserPassword()`
   * was already written in the web API but **nobody called it**, because the
   * response did not carry an id to call it with.
   *
   * Careful: `passwordHash` and `totpSecret` are **not selected**: a
   * whitelist, same reasoning as `redact.ts`.
   */
  portalUsers: {
    // Careful: `role` is needed too. The screen's dropdown must open showing
    // the **current** role, otherwise pressing "save" without changing it would set a wrong role.
    select: { id: true, email: true, role: true },
    orderBy: { id: 'asc' },
    take: 1,
  },
} satisfies Prisma.EmployeeSelect;

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -- Reads (owner + manager) ---------------------------------------------------

  /**
   * To **show the next employee code in advance**, in the new-employee form.
   *
   * Careful: this is a **forecast**, not a promise. The real code is assigned
   * in `create()` at save time; if two owners add at once, one gets the next
   * one. That is why the screen text says "next", not "your code will be".
   *
   * Careful: there is deliberately **no `where`**; active and inactive are
   * both needed. With only active ones, a departed employee's code would be
   * suggested again and saving would give 409, while nobody with that code
   * shows on screen (active filter), so the cause would be unclear.
   *
   * Only `empCode` is selected: name or salary have no reason to enter this
   * call, and managers call it too.
   */
  async nextCode(): Promise<{ code: string }> {
    const rows = await this.prisma.employee.findMany({
      select: { empCode: true },
    });

    return { code: nextEmployeeCode(rows.map((r) => r.empCode)) };
  }


  async list(
    actor: SessionUser,
    query: EmployeeListQueryDto,
    ip: string,
  ): Promise<{ rows: EmployeeView[]; total: number }> {
    const status = query.status ?? 'active';
    const search = query.search?.trim();

    const where: Prisma.EmployeeWhereInput = {
      ...(status === 'all' ? {} : { status }),
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: 'insensitive' } },
              { empCode: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.employee.findMany({
      where,
      select: EMPLOYEE_SELECT,
      orderBy: { empCode: 'asc' },
    });

    // Careful: targetId here is not one person's id; the whole list is the
    // target. With `list` written there, the audit log can tell "who viewed
    // everyone's salary" from "who viewed one person's".
    await this.recordSalaryRead(actor, ip, rows, 'list');

    return { rows: toEmployeeViews(rows, actor.role), total: rows.length };
  }

  async get(actor: SessionUser, id: number, ip: string): Promise<EmployeeView> {
    const row = await this.prisma.employee.findUnique({
      where: { id },
      select: EMPLOYEE_SELECT,
    });
    if (!row) throw new NotFoundException('Staff member not found');

    await this.recordSalaryRead(actor, ip, [row], String(id));

    return toEmployeeView(row, actor.role);
  }

  // -- Writes (owner only) ------------------------------------------------------

  async create(
    actor: SessionUser,
    dto: CreateEmployeeDto,
    ip: string,
  ): Promise<EmployeeView> {
    this.assertMaySetPay(actor, dto);
    await this.assertPolicyExists(dto.policyId);

    const row = await this.createWithGeneratedCode(dto);

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: ADMIN_TARGET.employee,
      targetId: row.id,
      ipAddress: ip,
      meta: { op: 'create', empCode: row.empCode, fullName: row.fullName },
    });

    if (dto.monthlySalary !== undefined || dto.hourlyRate !== undefined || dto.payBasis !== undefined) {
      await this.recordPayChange(actor, ip, row.id, null, termsOf(row));
    }

    return toEmployeeView(row, actor.role);
  }

  async update(
    actor: SessionUser,
    id: number,
    dto: UpdateEmployeeDto,
    ip: string,
  ): Promise<EmployeeView> {
    this.assertMaySetPay(actor, dto);

    const before = await this.prisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        empCode: true,
        monthlySalary: true,
        payBasis: true,
        hourlyRate: true,
        joinedOn: true,
        policy: { select: { ...MEASURE_SELECT, ...SCHEDULE_SELECT } },
      },
    });
    if (!before) throw new NotFoundException('Staff member not found');

    if (dto.policyId !== undefined && dto.policyId !== null) {
      await this.assertPolicyExists(dto.policyId);
    }

    // Careful: `undefined` = "leave alone", `null` = "clear"; they differ.
    // Assigning every field at once would turn unsent fields into null.
    // `empCode` is deliberately absent: the code is set once, in `create()`.
    const data: Prisma.EmployeeUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.designation !== undefined) data.designation = dto.designation;
    if (dto.department !== undefined) data.department = dto.department;
    // Careful: `undefined` = leave alone; `null` is not accepted (it is a yes/no)
    if (dto.receivesTasks !== undefined && dto.receivesTasks !== null) {
      data.receivesTasks = dto.receivesTasks;
    }
    if (dto.monthlySalary !== undefined) data.monthlySalary = dto.monthlySalary;
    if (dto.payBasis !== undefined) data.payBasis = dto.payBasis;
    if (dto.hourlyRate !== undefined) data.hourlyRate = dto.hourlyRate;
    // Careful: `null` is valid too: "clear their own number and fall back to the policy".
    if (dto.dailyTaskTarget !== undefined) {
      data.dailyTaskTarget = dto.dailyTaskTarget;
    }
    if (dto.joinedOn !== undefined) {
      data.joinedOn =
        dto.joinedOn === null ? null : this.calendarDate(dto.joinedOn, 'joinedOn');
    }
    if (dto.policyId !== undefined) {
      data.policy =
        dto.policyId === null
          ? { disconnect: true }
          : { connect: { id: dto.policyId } };
    }

    // `empCode` can no longer arrive here (the DTO has no such field), so
    // the only remaining UNIQUE is the email.
    const row = await this.prisma.employee
      .update({ where: { id }, data, select: EMPLOYEE_SELECT })
      .catch((err: unknown) => {
        throw this.translateUniqueViolation(
          err,
          undefined,
          dto.email ?? undefined,
        );
      });

    // Careful: in Prisma's update input the relation is named `policy`, not the
    // column name. Passing the key straight would write `policy` into the audit
    // log, which would not match the API's `policyId`.
    const changed = Object.keys(data)
      // pay changes get their own audit rows (recordPayChange)
      .filter((k) => !PAY_FIELDS.has(k))
      .map((k) => (k === 'policy' ? 'policyId' : k));
    if (changed.length > 0) {
      await this.audit.record({
        userId: actor.userId,
        action: 'change_setting',
        targetType: ADMIN_TARGET.employee,
        targetId: id,
        ipAddress: ip,
        meta: { op: 'update', fields: changed, empCode: row.empCode },
      });
    }

    if (dto.monthlySalary !== undefined || dto.hourlyRate !== undefined || dto.payBasis !== undefined) {
      await this.recordPayChange(actor, ip, id, termsOf(before), termsOf(row));
    }

    if (dto.policyId !== undefined) {
      const after =
        dto.policyId === null
          ? null
          : await this.prisma.workPolicy.findUnique({
              where: { id: dto.policyId },
              select: { ...MEASURE_SELECT, ...SCHEDULE_SELECT },
            });
      // another measure (or presence gap) credits their days differently, and
      // another schedule rewrites their checked days: count the open months
      // again, as a change on a policy does
      if (!sameMeasure(before.policy, after) || !sameSchedule(before.policy, after)) {
        await this.recountOpenMonths();
      }
    }
    // days before the first day are not checked: a new first day adds or removes rows
    if (
      dto.joinedOn !== undefined &&
      row.joinedOn?.getTime() !== before.joinedOn?.getTime() &&
      schedulePolicyOf(before.policy) !== null
    ) {
      await this.recountOpenMonths();
    }

    return toEmployeeView(row, actor.role);
  }

  /**
   * Careful: **deactivate, not delete.** Deleting a row would orphan that
   * person's monthly totals, screenshots and audit trail (the FKs would also block it).
   *
   * Changing only the status is not enough. If someone has left but the agent
   * is still running on their PC, screenshots of a person who quit would keep
   * coming. So in the same transaction:
   *   - all their active devices are revoked,
   *   - unused enrollment codes are expired (otherwise the agent could be
   *     installed on a new PC in their name),
   *   - their portal account is disabled.
   */
  async deactivate(
    actor: SessionUser,
    id: number,
    dto: DeactivateEmployeeDto,
    ip: string,
  ): Promise<EmployeeView> {
    const before = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, empCode: true, status: true, policy: { select: SCHEDULE_SELECT } },
    });
    if (!before) throw new NotFoundException('Staff member not found');
    if (before.status === 'inactive') {
      // Careful: running it again silently would overwrite the earlier `leftOn` with today.
      throw new ConflictException(
        'This staff member has already been deactivated',
      );
    }

    const now = new Date();
    const leftOn = dto.leftOn
      ? this.calendarDate(dto.leftOn, 'leftOn')
      : workDateOf(now);

    const { row, devicesRevoked, codesExpired, portalDisabled } =
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.employee.update({
          where: { id },
          data: { status: 'inactive', leftOn },
          select: EMPLOYEE_SELECT,
        });

        const devices = await tx.device.updateMany({
          where: { employeeId: id, status: 'active' },
          data: { status: 'revoked' },
        });

        // Set the expiry to "now" instead of deleting, since when each code
        // was issued is part of the history.
        const codes = await tx.enrollmentCode.updateMany({
          where: { employeeId: id, usedAt: null, expiresAt: { gt: now } },
          data: { expiresAt: now },
        });

        const portal = await tx.user.updateMany({
          where: { employeeId: id, isActive: true },
          data: { isActive: false },
        });

        return {
          row: updated,
          devicesRevoked: devices.count,
          codesExpired: codes.count,
          portalDisabled: portal.count,
        };
      });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: ADMIN_TARGET.employee,
      targetId: id,
      ipAddress: ip,
      meta: {
        op: 'deactivate',
        empCode: before.empCode,
        reason: dto.reason,
        leftOn: leftOn.toISOString().slice(0, 10),
        devicesRevoked,
        codesExpired,
        portalDisabled,
      },
    });

    this.logger.log(
      `${before.empCode} deactivated — ${devicesRevoked} devices revoked, ${codesExpired} codes cancelled`,
    );

    // days after the last one are not checked: a last day in the past leaves rows to remove
    if (schedulePolicyOf(before.policy) !== null) await this.recountOpenMonths();

    return toEmployeeView(row, actor.role);
  }

  /**
   * Careful: devices are deliberately **not** switched back on. For a
   * returning employee the normal path is a new enrollment code; letting old
   * tokens wake up by themselves would assume that machine is still theirs.
   */
  async reactivate(
    actor: SessionUser,
    id: number,
    ip: string,
  ): Promise<EmployeeView> {
    const before = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, empCode: true, status: true, policy: { select: SCHEDULE_SELECT } },
    });
    if (!before) throw new NotFoundException('Staff member not found');
    if (before.status === 'active') {
      throw new ConflictException('This staff member is already active');
    }

    /**
     * Careful: **the portal login must be restored too. This was missed at first.**
     *
     * `deactivate()` sets `is_active = false` on the employee's `users` row.
     * Without restoring it here, this happened:
     *
     *   1. The Staff screen showed the employee as **Active**
     *   2. "Reset password" **succeeded** and showed a new password
     *   3. But login always said *"Email or password is incorrect"*
     *
     * Careful: `login()` checks `user.isActive` along with the password, and
     * the failure message is deliberately the same (to prevent user
     * enumeration). So there was **no way to learn the cause**: the owner
     * would reset again and again and get the same message every time.
     *
     * Devices deliberately stay off (see the comment above), but login and
     * device are not the same thing: without a login the employee **cannot
     * even sign in to the agent**, so the way back stays closed.
     */
    const [row, portal] = await this.prisma.$transaction([
      this.prisma.employee.update({
        where: { id },
        data: { status: 'active', leftOn: null },
        select: EMPLOYEE_SELECT,
      }),
      this.prisma.user.updateMany({
        where: { employeeId: id, isActive: false },
        data: { isActive: true },
      }),
    ]);

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: ADMIN_TARGET.employee,
      targetId: id,
      ipAddress: ip,
      // Careful: also record how many logins were restored. `deactivate` records
      // `portalDisabled`, so the pair can be matched up in the audit log.
      meta: {
        op: 'reactivate',
        empCode: before.empCode,
        portalRestored: portal.count,
      },
    });

    // the last day is cleared: the days after it are checked again
    if (schedulePolicyOf(before.policy) !== null) await this.recountOpenMonths();

    return toEmployeeView(row, actor.role);
  }

  /**
   * **Turn this employee's agent back on**: restore devices that were switched off.
   *
   * Careful: why per employee, not per device: the owner thinks of "Bruno's
   * PC", not "device #61". A separate Devices screen would mean looking in two
   * places for the answer to one question, and make the whole system more complicated.
   *
   * Careful: this is needed because `deactivate()` revokes all of an
   * employee's devices and `reactivate()` deliberately does not bring them
   * back (a returning employee's old token must not wake up by itself). So
   * on the board they would stay "Offline" forever while the agent runs fine on their PC.
   *
   * Careful: **do not run this for a lost laptop.** Revoking does not erase
   * `token_hash`, it only closes the door. Restoring makes **the old token
   * itself live again**, so whoever holds that laptop comes back too. In
   * that case keep the employee inactive and have them sign in fresh on a new machine.
   */
  async turnAgentOn(
    actor: SessionUser,
    id: number,
    ip: string,
  ): Promise<{ restored: number }> {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, empCode: true, status: true },
    });
    if (!employee) throw new NotFoundException('Staff member not found');

    /**
     * Careful: an inactive employee's devices cannot be restored, otherwise
     * a departed person's machine would start sending hours again while the
     * Staff screen says "Inactive". Reactivate them first, then the agent.
     */
    if (employee.status !== 'active') {
      throw new ConflictException(
        'This staff member is inactive — reactivate them first, then turn the agent on',
      );
    }

    const { count } = await this.prisma.device.updateMany({
      where: { employeeId: id, status: 'revoked' },
      data: { status: 'active' },
    });

    // Careful: nothing changed, so no audit event is written; otherwise the
    // history would collect rows where nothing actually happened.
    if (count === 0) return { restored: 0 };

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: ADMIN_TARGET.employee,
      targetId: id,
      ipAddress: ip,
      meta: { op: 'turn_agent_on', empCode: employee.empCode, restored: count },
    });

    this.logger.warn(
      `employee ${employee.empCode}: ${count} device(s) turned back on by user ${actor.userId}`,
    );
    return { restored: count };
  }

  // -- Internal helpers -------------------------------------------------------

  /**
   * **Viewing salary** is an event (ADR-023): as on the payroll sheet, it is
   * recorded who viewed it and when.
   *
   * Careful: recorded only when a number was really disclosed. Otherwise
   * every manager page load, and lists with no salary set, would flood
   * audit_log and bury the real events.
   */
  private async recordSalaryRead(
    actor: SessionUser,
    ip: string,
    rows: readonly { monthlySalary: unknown }[],
    targetId: string,
  ): Promise<void> {
    if (!canSeeSalary(actor.role)) return;
    const disclosed = rows.filter((r) => r.monthlySalary !== null).length;
    if (disclosed === 0) return;

    await this.audit.record({
      userId: actor.userId,
      action: 'payroll_view',
      targetType: ADMIN_TARGET.employee,
      targetId,
      ipAddress: ip,
      meta: { via: 'employees', disclosed },
    });
  }

  /**
   * **Keep the old value when a salary changes.**
   *
   * Careful: previously only "from X to Y" went into the audit log, while
   * payroll read salary live from `employees.monthly_salary`. So raising
   * someone's salary **silently changed closed months' payroll too**, and it
   * no longer matched the paper the salary was paid on. The audit log said
   * the change happened, but the sheet was printed with the new number.
   *
   * Careful: no row is written when `from === null`: there was no salary
   * before, so there is no "old value" (a new employee).
   */
  /**
   * A change of pay terms (basis, salary, hourly rate): the old terms are kept
   * as history up to last month (or this one, if it is closed), so a month
   * already paid is never recomputed with the new terms.
   */
  private async recordPayChange(
    actor: SessionUser,
    ip: string,
    employeeId: number,
    before: PayTerms | null,
    after: PayTerms,
  ): Promise<void> {
    if (before !== null && sameTerms(before, after)) return;
    const from = before;
    const to = after;

    if (from !== null && (from.monthlySalary !== null || from.hourlyRate !== null)) {
      const yearMonth = workDateOf(new Date()).toISOString().slice(0, 7);
      const closed = await this.prisma.monthClosure.findUnique({
        where: { yearMonth },
        select: { yearMonth: true },
      });

      await this.prisma.salaryPeriod.upsert({
        where: {
          employeeId_throughMonth: {
            employeeId,
            throughMonth: supersededThrough(yearMonth, closed !== null),
          },
        },
        // Careful: if changed twice in one month, the **first** value should
        // stay; it is what really applied up to that month. Hence an empty `update`.
        update: {},
        create: {
          employeeId,
          throughMonth: supersededThrough(yearMonth, closed !== null),
          payBasis: from.payBasis,
          monthlySalary: from.monthlySalary,
          hourlyRate: from.hourlyRate,
          changedById: actor.userId,
        },
      });
    }

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: ADMIN_TARGET.employeeSalary,
      targetId: employeeId,
      ipAddress: ip,
      // The audit log is itself owner-only, so storing the real amount here is
      // safe, and without "from X to Y" half the audit would lose its meaning.
      meta: { op: 'update_salary', from: from === null ? null : { ...from }, to: { ...to } },
    });
  }

  /** Count the open months again (never a frozen pay period's days): what this person's days were checked against changed */
  private async recountOpenMonths(): Promise<void> {
    await markDirty(this.prisma, await policyRecountDates(this.prisma, workDateOf(new Date())));
  }

  private async assertPolicyExists(policyId?: number): Promise<void> {
    if (policyId === undefined) return;
    const policy = await this.prisma.workPolicy.findUnique({
      where: { id: policyId },
      select: { id: true },
    });
    // Careful: a broken FK would make Prisma throw P2003 and become a 500; caught here instead.
    if (!policy) {
      throw new BadRequestException('There is no work policy with this policyId');
    }
  }

  /**
   * Record the signed monitoring policy: **the one rollout precondition**.
   *
   * Careful: this path used to be missing. The column existed, the API read
   * it, the web had the type, but there was **no way to set it**. So the rule
   * "no agent goes on anyone's PC without a signature" could not be recorded
   * in the system, and six months later the answer would live only in a paper file.
   */
  async setPolicySigned(
    actor: SessionUser,
    id: number,
    signedOn: string | undefined,
    ip: string,
  ): Promise<EmployeeView> {
    const before = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, empCode: true, policySignedAt: true },
    });
    if (!before) throw new NotFoundException('Staff member not found');

    /**
     * Careful: the date is stored as **local midnight**, not the moment of
     * entry. The column is `timestamptz`, so storing the moment would make a
     * record of "signed 3 August" show 2 or 4 August when the time zone
     * changes, which is unacceptable for the date of a legal document.
     */
    const when = signedOn
      ? this.calendarDate(signedOn, 'signedOn')
      : workDateOf(new Date());

    // Careful: no future dates. If it could be recorded before the paper is
    // signed, the whole precondition would mean nothing.
    if (when.getTime() > workDateOf(new Date()).getTime()) {
      throw new BadRequestException('The signing date cannot be in the future');
    }

    const row = await this.prisma.employee.update({
      where: { id },
      data: { policySignedAt: when },
      select: EMPLOYEE_SELECT,
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'policy_signed',
      targetType: ADMIN_TARGET.employee,
      targetId: id,
      ipAddress: ip,
      meta: {
        empCode: before.empCode,
        signedOn: when.toISOString().slice(0, 10),
        // Careful: keep the previous value too; a second signing is either a
        // correction or a mistake.
        previous: before.policySignedAt?.toISOString().slice(0, 10) ?? null,
      },
    });

    this.logger.log(`${before.empCode} — monitoring policy signed on ${when.toISOString().slice(0, 10)}`);

    return toEmployeeView(row, actor.role);
  }

  /**
   * Undo a wrongly entered signature.
   *
   * Careful: it **clears** the value rather than deleting, and the event
   * stays in the audit log. "The signature existed and was then withdrawn" and
   * "there never was one" are completely different things, especially if the
   * agent has already been installed on that PC.
   */
  async clearPolicySigned(
    actor: SessionUser,
    id: number,
    ip: string,
  ): Promise<EmployeeView> {
    const before = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, empCode: true, policySignedAt: true },
    });
    if (!before) throw new NotFoundException('Staff member not found');

    const row = await this.prisma.employee.update({
      where: { id },
      data: { policySignedAt: null },
      select: EMPLOYEE_SELECT,
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'policy_signed_cleared',
      targetType: ADMIN_TARGET.employee,
      targetId: id,
      ipAddress: ip,
      meta: {
        empCode: before.empCode,
        cleared: before.policySignedAt?.toISOString().slice(0, 10) ?? null,
      },
    });

    return toEmployeeView(row, actor.role);
  }

  private calendarDate(value: string, field: string): Date {
    const parsed = parseCalendarDate(value);
    if (!parsed) throw new BadRequestException(`${field} is not a valid date`);
    return parsed;
  }

  /**
   * The employee code is assigned **here**; the client says nothing and
   * cannot (`CreateEmployeeDto` has no such field).
   *
   * Careful: "read the max code" and "insert the new row" are two separate
   * calls, and the gap between them is real. If two owners add at once, both
   * may read the same `OX-13`; the second INSERT breaks the `emp_code` UNIQUE
   * and raises P2002. Then **count again and retry**: the conflict is the signal.
   *
   * Careful: wrapping it in a transaction would not remove the problem. Under
   * Postgres's default READ COMMITTED two transactions can read the same
   * maximum, and the conflict would surface at COMMIT, i.e. right here, only later.
   *
   * Careful: attempts are limited. An endless loop would turn a broken UNIQUE
   * or an odd code format into a hang, and the owner would only see a spinner.
   */
  private async createWithGeneratedCode(
    dto: CreateEmployeeDto,
  ): Promise<EmployeeRow> {
    const base = {
      fullName: dto.fullName,
      email: dto.email ?? null,
      designation: dto.designation ?? null,
      department: dto.department ?? null,
      receivesTasks: dto.receivesTasks ?? false,
      // Careful: null = "no own number", so the policy's target applies, not zero.
      dailyTaskTarget: dto.dailyTaskTarget ?? null,
      policyId: dto.policyId ?? null,
      // The string goes straight into Decimal; no float on the way.
      monthlySalary: dto.monthlySalary ?? null,
      payBasis: dto.payBasis ?? 'monthly',
      hourlyRate: dto.hourlyRate ?? null,
      joinedOn: dto.joinedOn
        ? this.calendarDate(dto.joinedOn, 'joinedOn')
        : null,
    };

    for (let attempt = 1; attempt <= CODE_ATTEMPTS; attempt++) {
      const { code: empCode } = await this.nextCode();

      try {
        return await this.prisma.employee.create({
          data: { ...base, empCode },
          select: EMPLOYEE_SELECT,
        });
      } catch (err: unknown) {
        // Careful: retry only on a **code** conflict. Retrying on an email
        // conflict would return the same 409 five times, only five times slower.
        if (attempt < CODE_ATTEMPTS && isEmpCodeConflict(err)) continue;
        throw this.translateUniqueViolation(err, empCode, dto.email);
      }
    }

    // Careful: reaching here means losing several times in a row, which is
    // abnormal, so a clear message instead of silence.
    throw new ConflictException(
      'Could not assign an employee code — too many staff were added at the same moment. Please try again.',
    );
  }

  /**
   * **Salary belongs to the owner alone**
   * ([ADR-023](../../../docs/history/05-Options-Decisions.md), spec section 4.3).
   * Managers can add and edit employees, but not salary.
   *
   * Careful: without this guard the situation would be worse than either
   * option: `redact.ts` filters salary **out of the manager's response**, but
   * anyone can still **send** `monthlySalary`. A manager could write to a
   * field they cannot even read, and if they entered it wrongly they could not
   * notice it themselves.
   *
   * Careful: 403, not a silent drop. Quietly discarding the field would make
   * the manager think the salary was saved, and the mistake would surface at
   * month-end in payroll.
   *
   * Careful: `undefined` and `null` differ. **Not sending** the field is
   * normal (they are not touching it), but sending `null` means "clear the
   * salary", which is also touching salary, so it is equally forbidden.
   */
  private assertMaySetPay(
    actor: SessionUser,
    dto: { monthlySalary?: string | null; payBasis?: string; hourlyRate?: string | null },
  ): void {
    const touchesPay =
      dto.monthlySalary !== undefined || dto.payBasis !== undefined || dto.hourlyRate !== undefined;
    if (!touchesPay || canSeeSalary(actor.role)) return;

    throw new ForbiddenException(
      'Only the owner can set or clear salary. Save the rest without the salary field.',
    );
  }

  private translateUniqueViolation(
    err: unknown,
    empCode?: string,
    email?: string,
  ): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const raw: unknown = err.meta?.target;
      const target = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');

      // Careful: both UNIQUE columns give the same P2002. Without saying which
      // one conflicted, the user would see "duplicate" and keep changing
      // empCode when the email is at fault.
      if (target.includes('email')) {
        return new ConflictException(
          `The email "${email}" is already registered to someone else`,
        );
      }
      return new ConflictException(`The code "${empCode}" is already in use`);
    }
    return err;
  }
}

/** The fields that make up someone's pay — owner-only, with their own audit rows */
const PAY_FIELDS = new Set(['monthlySalary', 'payBasis', 'hourlyRate']);

interface PayTerms {
  payBasis: 'monthly' | 'hourly' | 'none';
  monthlySalary: string | null;
  hourlyRate: string | null;
}

function termsOf(row: {
  payBasis: 'monthly' | 'hourly' | 'none';
  monthlySalary: { toFixed(d: number): string } | null;
  hourlyRate: { toFixed(d: number): string } | null;
}): PayTerms {
  return {
    payBasis: row.payBasis,
    monthlySalary: row.monthlySalary === null ? null : row.monthlySalary.toFixed(2),
    hourlyRate: row.hourlyRate === null ? null : row.hourlyRate.toFixed(2),
  };
}

function sameTerms(a: PayTerms, b: PayTerms): boolean {
  return a.payBasis === b.payBasis && a.monthlySalary === b.monthlySalary && a.hourlyRate === b.hourlyRate;
}
