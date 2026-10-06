import type { EmployeeStatus, UserRole } from '@prisma/client';

/**
 * Turns an employee DB row into an API response.
 *
 * This file has one hard duty: **`monthlySalary` must never reach anyone but
 * the owner** ([ADR-023](../../../docs/05-Options-Decisions.md), spec
 * section 4.3).
 *
 * It is kept pure (no I/O) because "can a manager see salary?" needs to be
 * proved by a test that runs without a database. Mixed into the service, the
 * proof would need the whole HTTP stack, and then nobody would write the test.
 */

/**
 * Only the part of Prisma's `Decimal` that is actually needed.
 *
 * Careful: Prisma's Decimal is deliberately not imported, otherwise this file
 * would no longer be quietly pure and tests would need a real Decimal. A plain
 * `number` also satisfies this shape, so tests can simply write `13000`.
 */
export interface Decimalish {
  toFixed(digits: number): string;
}

/** Exactly the columns the service selects; nothing more enters here. */
export interface EmployeeRow {
  id: number;
  empCode: string;
  fullName: string;
  email: string | null;
  designation: string | null;
  department: string | null;
  /** Kind of work. Managers see it too; it is not secret, unlike salary. */
  staffType: 'designer' | 'researcher' | 'manager' | null;
  /**
   * **The designer's own daily target.**
   *
   * Careful: this field used to be **missing** here, while the screen type
   * (`EmployeeView`) always claimed it was sent. The failure was silent: the
   * owner saved a target, and on reopening the form the field was **empty**,
   * as if nothing had been saved. Empty means "the policy's 25 applies", so
   * someone could retype 25 when 0 (target off) had been set.
   *
   * That is the cost of forgetting a field in a whitelist-style function:
   * not a leak but an **absence**, and it is noticed very late.
   */
  dailyDesignTarget: number | null;
  policyId: number | null;
  monthlySalary: Decimalish | null;
  payBasis: 'monthly' | 'hourly' | 'none';
  hourlyRate: Decimalish | null;
  joinedOn: Date | null;
  leftOn: Date | null;
  status: EmployeeStatus;
  policySignedAt: Date | null;
  policyDocPath: string | null;
  createdAt: Date;
  /** Setup status, from `EMPLOYEE_SELECT`. */
  devices?: { status: 'active' | 'revoked' }[];
  portalUsers?: { id: number; email: string; role: UserRole }[];
}

/** What managers and the owner both see. */
export interface EmployeeBaseView {
  id: number;
  empCode: string;
  fullName: string;
  email: string | null;
  designation: string | null;
  department: string | null;
  /** Kind of work. Managers see it too; it is not secret, unlike salary. */
  staffType: 'designer' | 'researcher' | 'manager' | null;
  /**
   * **The designer's own daily target.**
   *
   * Careful: this field used to be **missing** here, while the screen type
   * (`EmployeeView`) always claimed it was sent. The failure was silent: the
   * owner saved a target, and on reopening the form the field was **empty**,
   * as if nothing had been saved. Empty means "the policy's 25 applies", so
   * someone could retype 25 when 0 (target off) had been set.
   *
   * That is the cost of forgetting a field in a whitelist-style function:
   * not a leak but an **absence**, and it is noticed very late.
   */
  dailyDesignTarget: number | null;
  policyId: number | null;
  /** 'YYYY-MM-DD' */
  joinedOn: string | null;
  leftOn: string | null;
  status: EmployeeStatus;
  policySignedAt: string | null;
  policyDocPath: string | null;
  createdAt: string;

  /**
   * **Is the employee ready for the agent to be installed?** At a glance.
   *
   * Careful: a `boolean`, not a count. How many devices someone has is not
   * this screen's question; the question is "is their setup finished?". A
   * number would be one more thing to read and would not help.
   */
  hasPortalAccount: boolean;
  hasDevice: boolean;
  /** Has devices but all are switched off; the basis for showing "Turn agent on" on the row. */
  agentSwitchedOff: boolean;

  /**
   * Id and login email of the portal account; the screen needs both for
   * password reset and email change. Both are `null` when there is no account.
   */
  portalUserId: number | null;
  portalEmail: string | null;

  /**
   * Role, so the screen's dropdown opens showing the **current** value.
   *
   * Careful: if it were not sent, the dropdown would always show "Staff", and
   * someone who only wanted to change an email and pressed save would silently
   * turn a manager into staff.
   */
  /**
   * Careful: the type is **borrowed** from `UserRole`, not a hand-written
   * list. It used to say `'owner' | 'manager' | 'employee'`, and when
   * `researcher` was added to the enum, this was **the only place in the whole
   * codebase** that raised a compile error. Every other condition would have
   * silently gone the wrong way. Borrowing the enum means this cannot go
   * silent next time; it stays in step by itself.
   */
  portalRole: UserRole | null;
}

/** Only the owner's response **contains** the salary field. */
export interface OwnerEmployeeView extends EmployeeBaseView {
  /** Whole currency units, two decimals. `null` when not set, not zero (see payroll). */
  monthlySalary: string | null;
  /** how they are paid — pay is the owner's alone, so this is too */
  payBasis: 'monthly' | 'hourly' | 'none';
  hourlyRate: string | null;
}

export type EmployeeView = EmployeeBaseView | OwnerEmployeeView;

/** Spec section 4.3: salary belongs to the owner alone. */
export function canSeeSalary(role: UserRole): boolean {
  return role === 'owner';
}

/**
 * The row is **never spread** (`{ ...row }`). Every field is picked by hand,
 * so this is a whitelist, not a blacklist.
 *
 * The difference matters for the future: if a `bankAccount` or `nid` column
 * is added to the schema tomorrow, a blacklist (`delete copy.monthlySalary`)
 * would quietly send it to managers. With a whitelist, a forgotten field
 * **does not appear**: an absence, not a leak. The error is deliberately
 * made to fall on that side.
 */
export function toEmployeeView(row: EmployeeRow, role: UserRole): EmployeeView {
  const base: EmployeeBaseView = {
    id: row.id,
    empCode: row.empCode,
    fullName: row.fullName,
    email: row.email,
    designation: row.designation,
    department: row.department,
    staffType: row.staffType,
    dailyDesignTarget: row.dailyDesignTarget,
    policyId: row.policyId,
    joinedOn: toDateOnly(row.joinedOn),
    leftOn: toDateOnly(row.leftOn),
    status: row.status,
    policySignedAt: row.policySignedAt?.toISOString() ?? null,
    policyDocPath: row.policyDocPath,
    createdAt: row.createdAt.toISOString(),

    // Careful: `false` when `_count` is missing. "Unknown" is treated as
    // "none", because this screen exists to show work **still to do**; if
    // wrong, it should show extra work, not less.
    hasPortalAccount: (row.portalUsers?.length ?? 0) > 0,
    hasDevice: (row.devices ?? []).some((d) => d.status === 'active'),

    /**
     * The agent was installed but is now off.
     *
     * Careful: deactivating an employee revokes all their devices, and
     * reactivating them does **not** bring them back (deliberate: old tokens
     * must not wake up on their own). So on the board they stay "Offline"
     * forever while the agent runs fine on their PC. This field lets the
     * screen show the "Turn agent on" button.
     */
    agentSwitchedOff:
      !(row.devices ?? []).some((d) => d.status === 'active') &&
      (row.devices ?? []).some((d) => d.status === 'revoked'),
    portalUserId: row.portalUsers?.[0]?.id ?? null,
    portalEmail: row.portalUsers?.[0]?.email ?? null,
    portalRole: row.portalUsers?.[0]?.role ?? null,
  };

  if (!canSeeSalary(role)) {
    // Careful: it is tempting to write `monthlySalary: undefined` here. It
    // looks right because JSON.stringify drops the field. But the key stays on
    // the object (`'monthlySalary' in emp` is true), and an interceptor, a
    // logger or `JSON.stringify(obj, replacer)` could send it out as `null`.
    // So the key is **never set**.
    return base;
  }

  return {
    ...base,
    // Decimal -> string. Careful: never go through `Number(...)`. Money must
    // never come back as a binary float; 13000.10 must not become 13000.0999...
    monthlySalary: row.monthlySalary === null ? null : row.monthlySalary.toFixed(2),
    payBasis: row.payBasis,
    hourlyRate: row.hourlyRate === null ? null : row.hourlyRate.toFixed(2),
  };
}

export function toEmployeeViews(
  rows: readonly EmployeeRow[],
  role: UserRole,
): EmployeeView[] {
  return rows.map((row) => toEmployeeView(row, role));
}

/**
 * A `@db.Date` column comes from Prisma as UTC midnight, so the first ten
 * characters of the ISO string are the calendar date.
 *
 * Careful: the work-zone offset is **not** added here. This is not an instant but
 * a plain calendar date, like a birthday or joining date. Applying a time
 * zone would sometimes turn the 1st into the 31st.
 */
function toDateOnly(date: Date | null): string | null {
  return date === null ? null : date.toISOString().slice(0, 10);
}
