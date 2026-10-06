import { api } from './client';
import { qs } from './query';

/** Staff: people, their portal logins and roles, staff codes. */

/**
 * E10, E11, H05, H06: staff, devices, work policy, leave, audit log.
 *
 * Server source: `server/src/admin/` and `server/src/users/`.
 *
 * The role boundary is the subtlest thing here:
 *   - `GET /employees`, `GET /employees/:id`: owner + manager (a manager's live
 *     view and reports are meaningless without the list of names)
 *   - everything else is owner-only: writing staff, devices, policy, leave,
 *     audit log, password reset, portal accounts
 *
 * Careful: owner-only things must not be shown to managers at all. Hide
 * buttons/tabs by checking `useAuth().user.role`. Catching a 403 and showing a
 * message is the last line of defense, not the first.
 */

export type EmployeeStatus = 'active' | 'inactive';
/**
 * The portal role: which screens a person gets into.
 *
 * Careful: do not confuse it with `receivesTasks` on the staff row: that is
 * whether work is handed to them, this is what they can see.
 *
 * `coordinator` adds and checks tasks but otherwise sees only their own data,
 * like `employee`.
 */
export type Role = 'owner' | 'manager' | 'coordinator' | 'employee';
/**
 * The roles that can be assigned from the dropdown; `owner` is deliberately left out.
 *
 * Owner means the keys to pay, the audit log and settings; that must not change
 * hands with one click (ADR-011d). The server DTO's `@IsIn` blocks the same list.
 *
 * Careful: the name is kept separate so it is not confused with `Role`. That very
 * confusion once broke the web build (TS2345), and three commits went by while it
 * stayed broken.
 */
export type AssignableRole = Exclude<Role, 'owner'>;
/**
 * Careful: `monthlySalary` is optional because the key is absent from a manager's
 * JSON (`undefined`, not `null`; the server deliberately does not set the key,
 * see redact.ts). So writing `emp.monthlySalary ?? '—'` would put a salary cell on
 * the manager's screen too. Do not render the column at all unless
 * `user.role === 'owner'`.
 */
export interface EmployeeView {
  id: number;
  empCode: string;
  fullName: string;
  email: string | null;
  designation: string | null;
  /**
   * Whether tasks are handed to them each morning (the Tasks module).
   *
   * Careful: not a job title — `designation` is that (free text); this is
   * the one switch the hand-out reads.
   */
  receivesTasks: boolean;
  department: string | null;
  /**
   * Their own daily task target; applies only while `receivesTasks`.
   *
   * Careful: `null` = not set, so the policy's number (25) applies. Not zero.
   * Careful: `0` = no target; they still receive tasks, but nobody is "behind".
   * These are two different states, which is why this is `number | null`.
   */
  dailyTaskTarget: number | null;
  policyId: number | null;
  /** `YYYY-MM-DD` */
  joinedOn: string | null;
  leftOn: string | null;
  /**
   * Ready for the agent to be installed? Drives the "Setup" column on the Staff screen.
   */
  hasPortalAccount: boolean;
  hasDevice: boolean;
  /** The portal account's id and login email, for reset and email change. */
  portalUserId: number | null;
  portalEmail: string | null;
  /**
   * Careful: open the dropdown showing the current role. If it showed "Staff" for
   * null, someone who only wanted to change the email and pressed save would
   * silently turn a manager into staff.
   */
  /**
   * Careful: the type is borrowed from `Role`, not a hand-written list. It used to
   * say `'owner' | 'manager' | 'employee'`, and when a fourth role was added it
   * silently fell behind: comparing that role made TypeScript say "these
   * have nothing in common".
   */
  portalRole: Role | null;

  /**
   * The agent was installed but is now switched off; drives "Turn agent on" on the row.
   *
   * Careful: `hasDevice === false` is true in two completely different situations:
   * never installed, and installed but switched off. The first needs a trip to the
   * PC; the second is one click on the row.
   */
  agentSwitchedOff: boolean;
  status: EmployeeStatus;
  policySignedAt: string | null;
  policyDocPath: string | null;
  createdAt: string;
  /** Only present in the owner's response. Read the note above. */
  monthlySalary?: string | null;
  /** How they are paid — owner's response only, like the salary */
  payBasis?: PayBasis;
  hourlyRate?: string | null;
}

/** monthly salary · hourly rate · not paid through oXeio */
export type PayBasis = 'monthly' | 'hourly' | 'none';
export interface EmployeeListQuery {
  /** Default `active`. */
  status?: EmployeeStatus | 'all';
  /** Search by name, code or email. */
  search?: string;
}
export function listEmployees(
  query: EmployeeListQuery = {},
  signal?: AbortSignal,
): Promise<{ rows: EmployeeView[]; total: number }> {
  return api<{ rows: EmployeeView[]; total: number }>(
    `/employees${qs({ ...query })}`,
    { signal },
  );
}
export function getEmployee(
  id: number,
  signal?: AbortSignal,
): Promise<EmployeeView> {
  return api<EmployeeView>(`/employees/${id}`, { signal });
}
/**
 * Careful: `empCode` is deliberately absent; the server assigns it.
 *
 * Careful: sending it gives a 400 (`forbidNonWhitelisted`), it is not silently ignored.
 */
export interface CreateEmployeeBody {
  fullName: string;
  email?: string;
  designation?: string;
  department?: string;
  receivesTasks?: boolean;
  /** Careful: if omitted or `null`, the policy target applies; `0` = no target. */
  dailyTaskTarget?: number | null;
  policyId?: number;
  /**
   * Careful: money must be sent as a string (`'13000'` or `'13000.50'`). As a JSON
   * float, 13000.10 could become 13000.0999..., and a one-cent difference would go
   * unnoticed. Pass the input box's value directly.
   */
  monthlySalary?: string;
  payBasis?: PayBasis;
  hourlyRate?: string;
  joinedOn?: string;
}
/**
 * Careful: `undefined` = "leave it alone", `null` = "delete it"; the server tells
 * them apart. From an empty input box send `null`, not `''`.
 */
/** Careful: `empCode` is absent here too; once set it never changes. */
export type UpdateEmployeeBody = Partial<{
  fullName: string;
  email: string | null;
  designation: string | null;
  department: string | null;
  receivesTasks: boolean;
  /**
   * Careful: `null` = "delete my own number, use the policy"; `0` = no target.
   */
  dailyTaskTarget: number | null;
  policyId: number | null;
  monthlySalary: string | null;
  payBasis: PayBasis;
  hourlyRate: string | null;
  joinedOn: string | null;
}>;
export function createEmployee(
  body: CreateEmployeeBody,
): Promise<EmployeeView> {
  return api<EmployeeView>('/employees', { method: 'POST', body });
}
export function updateEmployee(
  id: number,
  body: UpdateEmployeeBody,
): Promise<EmployeeView> {
  return api<EmployeeView>(`/employees/${id}`, { method: 'PATCH', body });
}
/**
 * Careful: there is no delete, only deactivate. Deleting the row would orphan the
 * employee's monthly figures, screenshots and audit trail. So do not write
 * "Delete" in the UI either.
 *
 * It also revokes all their devices, cancels the enrollment code and disables the
 * portal account at once; the confirmation box should say so.
 *
 * `reason` is required, at least 3 characters.
 */
export function deactivateEmployee(
  id: number,
  reason: string,
  leftOn?: string,
): Promise<EmployeeView> {
  return api<EmployeeView>(`/employees/${id}/deactivate`, {
    method: 'POST',
    body: { reason, ...(leftOn ? { leftOn } : {}) },
  });
}
export function reactivateEmployee(id: number): Promise<EmployeeView> {
  return api<EmployeeView>(`/employees/${id}/reactivate`, { method: 'POST' });
}
export interface EnrollmentCodeResult {
  /** Careful: shown this one time only; the server stores just the sha256. */
  code: string;
  expiresAt: string;
  employee: { id: number; empCode: string; fullName: string };
}
// ── Account (owner-only) ────────────────────────────────────────────────────

/** `tempPassword` comes back only once: show it in the modal, it is stored nowhere. */
export function resetUserPassword(
  userId: number,
  /** When the owner sets it personally there is no forced change. */
  password?: string,
): Promise<{ email: string; tempPassword: string }> {
  return api<{ email: string; tempPassword: string }>(
    `/users/${userId}/reset-password`,
    { method: 'POST', body: password ? { password } : {} },
  );
}
/**
 * Suggestion for the next employee code, used when the new-employee form opens.
 *
 * Careful: this is a suggestion, not a guarantee. The field stays editable, and if
 * two people add at the same time the second gets a 409 from the server.
 */
export function nextEmployeeCode(
  signal?: AbortSignal,
): Promise<{ code: string }> {
  return api<{ code: string }>('/employees/next-code', { signal });
}
/** Change the login email; this is the staff member's "username". */
export function changeLoginEmail(
  userId: number,
  email: string,
): Promise<{ id: number; email: string }> {
  return api<{ id: number; email: string }>(`/users/${userId}/email`, {
    method: 'PATCH',
    body: { email },
  });
}
/**
 * Staff <-> manager.
 *
 * Careful: `owner` cannot be sent; the server returns 400. Owner means the keys to
 * pay, the audit log and settings, which must not change hands with one dropdown click.
 */
/**
 * Turn a switched-off agent back on, per employee, not per device.
 *
 * The owner thinks about "Belal's PC", not "device #61". So the separate Devices
 * screen was removed and the action moved to the Staff row.
 */
export function turnAgentOn(employeeId: number): Promise<{ restored: number }> {
  return api<{ restored: number }>(`/employees/${employeeId}/agent/turn-on`, {
    method: 'POST',
  });
}
/**
 * Careful: the type is `AssignableRole`, not `Role`. `owner` cannot be assigned
 * through here, and the compiler itself blocks it (ADR-011d).
 */
export function changeUserRole(
  userId: number,
  role: AssignableRole,
): Promise<{ id: number; email: string; role: string }> {
  return api<{ id: number; email: string; role: string }>(
    `/users/${userId}/role`,
    { method: 'PATCH', body: { role } },
  );
}
/** A staff member's own-view account (J04/J05); default role `employee`. */
export function createPortalAccount(
  employeeId: number,
  email: string,
  role?: Role,
  /**
   * A password chosen by the owner.
   *
   * Careful: if left empty, the old behavior applies: the system generates a random
   * password and asks for a change at first login. If given, it is used as is and
   * no change screen appears.
   */
  password?: string,
): Promise<{ userId: number; email: string; tempPassword: string }> {
  return api<{ userId: number; email: string; tempPassword: string }>(
    `/employees/${employeeId}/portal-account`,
    {
      method: 'POST',
      body: {
        email,
        ...(role ? { role } : {}),
        ...(password ? { password } : {}),
      },
    },
  );
}
