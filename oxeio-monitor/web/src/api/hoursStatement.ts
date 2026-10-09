import { api } from './client';

/**
 * Hours statement — server `hours-statement/` (owner and finance) and
 * `settings/pay-period` (owner). Hours only, never money.
 */

export type DeliveryStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'no_recipients'
  | 'not_configured'
  | 'no_staff';

export interface PeriodSummary {
  id: number;
  /** `YYYY-MM-DD`, work-zone dates, both inclusive */
  start: string;
  end: string;
  /** still running: its lines are live figures, not stored */
  open: boolean;
  snapshotAt: string | null;
  deliveryStatus: DeliveryStatus | null;
  sentAt: string | null;
  /** the mail server's answer — owners only; `null` for finance */
  deliveryError: string | null;
}

export interface StatementLine {
  /** `null` on the open period: a live line, nothing stored to mark */
  id: number | null;
  employeeId: number;
  empCode: string;
  fullName: string;
  /** the part of the period this person was employed and paid by the hour */
  fromDate: string;
  toDate: string;
  measuredSec: number;
  /** what earlier periods left over (signed) */
  carryInSec: number;
  /** the proposal: whole minutes to post */
  toPostMin: number;
  leaveDays: number;
  holidayDays: number;
  noDataDays: number;
  /** set only when posted with a value other than `toPostMin` */
  postedMin: number | null;
  postedAt: string | null;
  postedBy: string | null;
  note: string | null;
}

export interface StatementDay {
  fullName: string;
  empCode: string;
  date: string;
  arrived: string | null;
  left: string | null;
  presenceHours: number;
  activeHours: number;
  adjustmentHours: number;
  creditedHours: number;
}

export interface PeriodDetail {
  period: PeriodSummary;
  /** a later statement already used this one: the posted marks are read-only */
  locked: boolean;
  lines: StatementLine[];
}

/** Every period, newest first */
export function listPeriods(signal?: AbortSignal): Promise<PeriodSummary[]> {
  return api<PeriodSummary[]>('/hours-statement/periods', { signal });
}

export function getPeriod(
  id: number,
  signal?: AbortSignal,
): Promise<PeriodDetail> {
  return api<PeriodDetail>(`/hours-statement/periods/${id}`, { signal });
}

/** One person's days inside the period (their own part of it) */
export function personDays(
  id: number,
  employeeId: number,
  signal?: AbortSignal,
): Promise<StatementDay[]> {
  return api<StatementDay[]>(
    `/hours-statement/periods/${id}/people/${employeeId}`,
    {
      signal,
    },
  );
}

/** `postedMin` only when the value posted differs from the proposal; 409 once locked */
export function markPosted(
  lineId: number,
  body: { postedMin?: number; note?: string },
): Promise<void> {
  return api(`/hours-statement/lines/${lineId}/posted`, {
    method: 'POST',
    body,
  });
}

export function unmarkPosted(lineId: number): Promise<void> {
  return api(`/hours-statement/lines/${lineId}/posted`, { method: 'DELETE' });
}

/** Owner only: send a frozen statement again (after fixing SMTP or the recipients) */
export function resendPeriod(id: number): Promise<{ status: DeliveryStatus }> {
  return api<{ status: DeliveryStatus }>(
    `/hours-statement/periods/${id}/resend`,
    {
      method: 'POST',
    },
  );
}

/** For `useXlsxDownload`, which fetches by itself — hence the full `/api/v1` path */
export function periodFileUrl(id: number): string {
  return `/api/v1/hours-statement/periods/${id}/file`;
}

export interface PayPeriodSettings {
  /** 1–28, or the last day of the month */
  cutoffDay: number | 'end';
  /** `HH:MM`, work zone — the day after the cutoff */
  sendTime: string;
  open: { start: string; end: string } | null;
}

export function getPayPeriodSettings(
  signal?: AbortSignal,
): Promise<PayPeriodSettings> {
  return api<PayPeriodSettings>('/settings/pay-period', { signal });
}

export function savePayPeriodSettings(body: {
  cutoffDay: number | 'end';
  sendTime: string;
}): Promise<PayPeriodSettings> {
  return api<PayPeriodSettings>('/settings/pay-period', {
    method: 'PUT',
    body,
  });
}
