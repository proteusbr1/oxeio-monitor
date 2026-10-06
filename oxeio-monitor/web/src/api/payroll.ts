import { api } from './client';
import { qs } from './query';

/** Payroll: the pay sheet, leave, month closing and security deposits. */

/** One person's month-by-month ledger, for the owner's correction screen. */
export interface DepositMonths {
  months: { yearMonth: string; amount: string }[];
  total: string;
  totalPaisa: number;
  settlement: unknown | null;
  noticeDays: number;
}
/**
 * Careful: the months used to be visible only on the employee's own page
 * (`/me/deposit`). The owner's page had only the total, e.g. "2 months held
 * ৳500", and those two numbers read together can be meaningless. That is exactly
 * what happened in the field: one month sat at ৳0 and nobody could tell why the
 * total did not add up.
 */
export function depositMonths(
  employeeId: number,
  signal?: AbortSignal,
): Promise<DepositMonths> {
  return api<DepositMonths>(`/deposits/${employeeId}/months`, { signal });
}
/**
 * Correct the amount of an installment that has already been recorded.
 *
 * Careful: there used to be no way to do this. `ensureLedger()` never updates an
 * existing row (intentionally), so a wrong amount stayed forever. `reason` is
 * required, and `amountPaisa` cannot be zero.
 */
export function correctDepositInstalment(
  employeeId: number,
  yearMonth: string,
  amountPaisa: number,
  reason: string,
): Promise<{ from: number; to: number }> {
  return api<{ from: number; to: number }>(
    `/deposits/${employeeId}/instalment`,
    { method: 'PATCH', body: { yearMonth, amountPaisa, reason } },
  );
}
export function setDepositStart(
  employeeId: number,
  yearMonth: string | null,
): Promise<{ removed: number; added: number }> {
  return api<{ removed: number; added: number }>(
    `/deposits/${employeeId}/start`,
    { method: 'PATCH', body: { yearMonth } },
  );
}
// ── R1 · Closing a month ─────────────────────────────────────────────────────

export interface MonthClosureView {
  /** '2026-08' */
  yearMonth: string;
  /** ISO instant */
  closedAt: string;
  /** Careful: an email, because "who closed it" must survive even if the user is deleted. */
  closedBy: string;
  note: string | null;
}
/**
 * R1: `GET /api/v1/months`, owner-only.
 *
 * Only closed months are returned, not all months: an open month means "can still
 * change", and that is understood from its absence.
 */
export function listMonthClosures(
  signal?: AbortSignal,
): Promise<{ rows: MonthClosureView[] }> {
  return api<{ rows: MonthClosureView[] }>('/months', { signal });
}
export function closeMonth(
  yearMonth: string,
  note?: string,
): Promise<MonthClosureView> {
  return api<MonthClosureView>(`/months/${yearMonth}/close`, {
    method: 'POST',
    body: { note },
  });
}
/**
 * Careful: reopening means removing the close record, hence `DELETE`. Both audit
 * rows (`month_closed`, `month_reopened`) stay, so history is not erased.
 */
export function reopenMonth(
  yearMonth: string,
): Promise<{ yearMonth: string; reopened: true }> {
  return api<{ yearMonth: string; reopened: true }>(`/months/${yearMonth}`, {
    method: 'DELETE',
  });
}
// ── R2 · Leave ledger ────────────────────────────────────────────────────────

export interface LeaveView {
  id: number;
  employeeId: number;
  employeeName: string;
  /** 'YYYY-MM-DD' */
  leaveDate: string;
  /** `casual` | `sick` | `annual`. Careful: all three are paid leave. */
  type: string;
  note: string | null;
  createdBy: string;
  /**
   * Whether that day was a workday for that employee.
   *
   * Careful: `false` means the row is in the ledger but reduced none of the target:
   * leave written on a Friday or a public holiday. If the screen does not show this
   * separately, the ledger would claim an exemption it did not give.
   */
  countsTowardTarget: boolean;
}
/** R2: `GET /api/v1/leaves?month=YYYY-MM`. Careful: the month is required. */
export function listLeaves(
  month: string,
  signal?: AbortSignal,
): Promise<{ rows: LeaveView[] }> {
  return api<{ rows: LeaveView[] }>(`/leaves${qs({ month })}`, { signal });
}
export interface CreateLeaveBody {
  employeeId: number;
  /** 'YYYY-MM-DD' */
  from: string;
  to: string;
  type: string;
  note?: string;
}
/**
 * By range: people take leave "from the 10th to the 14th", not "the 10th" five times.
 *
 * Careful: when `skipped` is not empty it must be shown. Those days were already
 * in the ledger, so they were not added; saying "5 added" would then be a lie.
 */
export function createLeave(
  body: CreateLeaveBody,
): Promise<{ created: number; skipped: string[] }> {
  return api<{ created: number; skipped: string[] }>('/leaves', {
    method: 'POST',
    body,
  });
}
export function deleteLeave(id: number): Promise<void> {
  return api<void>(`/leaves/${id}`, { method: 'DELETE' });
}
// ── R21 · Security money (deposit) ───────────────────────────────────────

/**
 * Careful: the whole path is owner-only. The deposit is directly part of pay, and
 * no pay figure is within a manager's reach (ADR-023, ADR-027).
 */
export interface DepositPolicyView {
  /** '500.00' */
  amount: string;
  /** Sent in minor units (paisa): 500.00 = 50000. */
  amountPaisa: number;
  startYearMonth: string;
  noticeDays: number;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
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
  /**
   * The start month chosen by the owner; `null` if not set (the default rule applies).
   *
   * Careful: `effectiveStart` also comes back, because the screen needs to show
   * which month deductions really start from. Showing only the override would
   * leave the owner looking at an empty cell, unable to tell which month is in effect.
   */
  startYearMonth: string | null;
  effectiveStart: string | null;

  employeeId: number;
  empCode: string;
  fullName: string;
  status: string;
  /** How many months of installments have been recorded. */
  months: number;
  balance: string;
  balancePaisa: number;
  settlement: DepositSettlementView | null;
}
export function listDeposits(
  signal?: AbortSignal,
): Promise<{ rows: DepositBalance[]; policy: DepositPolicyView }> {
  return api<{ rows: DepositBalance[]; policy: DepositPolicyView }>(
    '/deposits',
    { signal },
  );
}
export interface DepositPolicyBody {
  amountPaisa?: number;
  startYearMonth?: string;
  noticeDays?: number;
  active?: boolean;
}
export function updateDepositPolicy(
  body: DepositPolicyBody,
): Promise<DepositPolicyView> {
  return api<DepositPolicyView>('/deposits/policy', { method: 'PATCH', body });
}
export interface SettleDepositBody {
  outcome: 'refunded' | 'forfeited';
  /** 'YYYY-MM-DD'. Careful: both are optional; "unknown" and "zero days" are not the same. */
  noticeGivenOn?: string;
  lastWorkingDay?: string;
  note?: string;
}
export function settleDeposit(
  employeeId: number,
  body: SettleDepositBody,
): Promise<DepositSettlementView> {
  return api<DepositSettlementView>(`/deposits/${employeeId}/settle`, {
    method: 'POST',
    body,
  });
}
// ── F03 · Payroll (owner-only) ───────────────────────────────────────────────

export interface PayrollRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  /**
   * Kind of work; this used to be `designation`.
   *
   * Careful: the designation field was removed from the form (the owner's
   * decision), so it would have stayed empty forever for new staff, silently showing
   * nothing on screen.
   */
  staffType: 'designer' | 'researcher' | 'manager' | null;
  /**
   * `null` = this employee's salary is not set, which is not the same as zero.
   * Showing them the same way would silently put a wrong number on the sheet.
   * Careful: all money and hours are strings (Decimal, not float). Do not compute
   * with `Number()`; use `formatTaka()` / `formatHoursAsDuration()`.
   */
  monthlySalary: string | null;
  targetHours: string;
  /**
   * How much of the target was actually observed.
   *
   * Careful: the deduction is against this, not against `targetHours`. This is the
   * owner's decision: "no deduction for days we did not observe". Both are shown
   * separately; otherwise the screen could not answer "the target is 208 hours, so
   * why is the shortfall only 2 hours?".
   */
  observedTargetHours: string;
  /** How many workday rows were actually written. */
  observedWorkdays: number;
  /** G37: the employee's workdays (d) and the month's workdays (D). d < D means prorated. */
  workdays: number;
  monthWorkdays: number;
  /**
   * R21: this month's deposit installment, and what will actually be handed over.
   *
   * Careful: the server sent both of these from day one, but the screen neither
   * declared nor showed them. So the sheet the owner pays from showed gross, while
   * the ledger said 11,000 had been withheld. This repo's familiar sin: the contract
   * is written, the caller is not.
   *
   * Careful: `null` when no salary is set, since net cannot be computed.
   */
  securityDeposit: string | null;
  netPayable: string | null;
  creditedHours: string;
  shortfallHours: string;
  overtimeHours: string;
  hourlyRate: string | null;
  deduction: string | null;
  payable: string | null;
  /** how this person is paid that month */
  payBasis: 'monthly' | 'hourly' | 'none';
  /** money for overtime — only when the work policy pays it */
  overtimePay: string | null;
}
export interface PayrollSheet {
  /** `YYYY-MM` */
  yearMonth: string;
  rows: PayrollRow[];
  /** Staff with no salary set; they must be shown by name. */
  missingSalary: string[];
  /** Staff whose rollup for that month has not run yet; they are not in `rows`. */
  missingSummary: string[];

  /**
   * R21: staff whose payable deposit installment for that month was larger than
   * their pay, so the net stopped at zero.
   *
   * Careful: the server sent this field long ago but it was not declared here, so
   * the screen did not know and the silent stop is what happened. `payroll.service.ts`
   * itself says: "if we stopped silently, the ledger would show 500 held while the
   * money was never deducted".
   */
  depositExceedsPayable: string[];

  /**
   * G108: holiday dates in this month that are not final yet.
   * Careful: each row's `payable` rests on `d / D`, and `D` is counted from this
   * month's holiday list, so when a date moves, money moves.
   */
  approximateHolidayDates: string[];
}
/**
 * F03: `GET /api/v1/payroll?month=YYYY-MM`
 *
 * Careful: owner-only, and every call is written to the audit log (payroll_view).
 * Do not even show a manager the link to this page: do not render the route unless
 * `user.role === 'owner'`; catching the 403 alone is not enough.
 */
export function getPayroll(
  month: string,
  signal?: AbortSignal,
): Promise<PayrollSheet> {
  return api<PayrollSheet>(`/payroll${qs({ month })}`, { signal });
}
