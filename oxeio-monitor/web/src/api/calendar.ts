import { api } from './client';
import { qs } from './query';

/** The working calendar: holidays (and their import) and work policies. */

// ── work policy (owner-only) ────────────────────────────────────────────────

export interface WorkPolicyView {
  id: number;
  name: string;
  /** The only target; default 208. */
  /** how the hours target is stated (server: calendar/work-regime.ts) */
  targetBasis: TargetBasis;
  monthlyTargetHours: number;
  expectedWorkdays: number;
  weeklyTargetHours: number | null;
  dailyTargetHours: number | null;
  breakMinutes: number | null;
  /** overtime paid at this multiple of the hourly rate; null = not paid */
  overtimeMultiplier: number | null;
  /** monthly salaries: missing hours are deducted */
  deductShortfall: boolean;
  /**
   * ISO weekday: Mon = 1 ... Fri = 5 ... Sun = 7. Several allowed; empty = every day is a workday.
   */
  weeklyOffDays: number[];
  /** `'HH:MM'` capture window; default 07:00-23:00. */
  screenshotFrom: string | null;
  screenshotTo: string | null;
  /**
   * `false` = no screenshots for this policy. The agent keeps sampling the
   * screen for the jiggler check, so hours are counted the same way.
   */
  screenshotsEnabled: boolean;
  /**
   * `'HH:MM'` when the office is open. Careful: this is NOT the capture window.
   * The capture window is wide (07:00-23:00) so screenshots are taken even when
   * someone works early or late; this one is narrow (9-18) so no "agent silent"
   * alert fires while the office is closed. `null` means open all day.
   */
  officeFrom: string | null;
  officeTo: string | null;
  idleThresholdSec: number;
  slotMinutes: number;
  timezone: string;
  isActive: boolean;
  /** Check this before deactivating: if anyone is still assigned, the server refuses. */
  employeeCount: number;
}
export type TargetBasis = 'month' | 'week' | 'day' | 'none';

export type WorkPolicyBody = Partial<{
  name: string;
  targetBasis: TargetBasis;
  weeklyTargetHours: number | null;
  dailyTargetHours: number | null;
  breakMinutes: number | null;
  overtimeMultiplier: number | null;
  deductShortfall: boolean;
  monthlyTargetHours: number;
  expectedWorkdays: number;
  weeklyOffDays: number[];
  screenshotFrom: string;
  screenshotTo: string;
  screenshotsEnabled: boolean;
  officeFrom: string;
  officeTo: string;
  idleThresholdSec: number;
  slotMinutes: number;
}>;
export function listWorkPolicies(
  signal?: AbortSignal,
): Promise<{ rows: WorkPolicyView[] }> {
  return api<{ rows: WorkPolicyView[] }>('/work-policies', { signal });
}
/**
 * Careful: changing a number here changes the behavior of every PC (idle
 * threshold, capture window) at the next config sync. Add a confirmation step.
 */
export function createWorkPolicy(
  body: WorkPolicyBody & { name: string },
): Promise<WorkPolicyView> {
  return api<WorkPolicyView>('/work-policies', { method: 'POST', body });
}
export function updateWorkPolicy(
  id: number,
  body: WorkPolicyBody,
): Promise<WorkPolicyView> {
  return api<WorkPolicyView>(`/work-policies/${id}`, { method: 'PATCH', body });
}
export function deactivateWorkPolicy(id: number): Promise<WorkPolicyView> {
  return api<WorkPolicyView>(`/work-policies/${id}/deactivate`, {
    method: 'POST',
  });
}
/**
 * Reopen a closed policy.
 *
 * The server already had `POST /work-policies/:id/reactivate` (controller,
 * service, audit row, five unit tests), but nothing called it: this function was
 * never written on the web side and PoliciesTab had no button in the `!isActive`
 * branch. So after an accidental Close the only way back was `curl` or raw SQL,
 * exactly what the endpoint was written to avoid.
 *
 * A familiar mistake in this project: the contract exists, the caller does not.
 */
export function reactivateWorkPolicy(id: number): Promise<WorkPolicyView> {
  return api<WorkPolicyView>(`/work-policies/${id}/reactivate`, {
    method: 'POST',
  });
}
// ── Holidays (owner-only) ──────────────────────────────────────────────────

export interface HolidayView {
  id: number;
  /** `YYYY-MM-DD` */
  holidayDate: string;
  name: string;
  /** `public` | `optional` | `company`; left open-ended. */
  type: string;
}
export function listHolidays(
  year?: number,
  signal?: AbortSignal,
): Promise<{ rows: HolidayView[] }> {
  return api<{ rows: HolidayView[] }>(`/holidays${qs({ year })}`, { signal });
}
export function createHoliday(body: {
  holidayDate: string;
  name: string;
  type?: string;
}): Promise<HolidayView> {
  return api<HolidayView>('/holidays', { method: 'POST', body });
}
export function updateHoliday(
  id: number,
  body: Partial<{ holidayDate: string; name: string; type: string }>,
): Promise<HolidayView> {
  return api<HolidayView>(`/holidays/${id}`, { method: 'PATCH', body });
}
/**
 * Careful: this is the only real DELETE in the whole holiday module, and it is not
 * harmless. Deleting a holiday adds a workday to that month, so everyone's pace
 * falls behind even though nobody did anything differently. Say so in the
 * confirmation box.
 */
export function deleteHoliday(id: number): Promise<{ deleted: HolidayView }> {
  return api<{ deleted: HolidayView }>(`/holidays/${id}`, { method: 'DELETE' });
}
export interface HolidayImportRow {
  date: string;
  name: string;
  type: string;
}
export interface HolidayImportPlan {
  add: HolidayImportRow[];
  existing: (HolidayImportRow & { nameInDb: string })[];
  pastMonths: HolidayImportRow[];
  problems: string[];
  created: number;
}
/** CSV (`date,name,type`) or ICS — `dryRun` only shows what would happen */
export function importHolidays(body: {
  fileName: string;
  content: string;
  allowPast: boolean;
  dryRun: boolean;
}): Promise<HolidayImportPlan> {
  return api('/holidays/import', { method: 'POST', body });
}

export interface HolidayCountry {
  code: string;
  name: string;
}

/** The countries the public holiday calendar covers */
export function listHolidayCountries(signal?: AbortSignal): Promise<HolidayCountry[]> {
  return api('/holidays/public/countries', { signal });
}

/** A country's nationwide public holidays for a year — `dryRun` only shows */
export function importPublicHolidays(body: {
  country: string;
  year: number;
  allowPast: boolean;
  dryRun: boolean;
}): Promise<HolidayImportPlan> {
  return api('/holidays/public', { method: 'POST', body });
}
