import { api } from './client';
import { qs } from './query';

/** The working calendar: holidays (and their import) and work policies. */

// ── work policy (owner-only) ────────────────────────────────────────────────

export interface WorkPolicyView {
  id: number;
  name: string;
  /** ⭐ একমাত্র টার্গেট, ডিফল্ট ২০৮ */
  monthlyTargetHours: number;
  expectedWorkdays: number;
  /** ISO দিন — সোম = ১ … শুক্র = ৫ … রবি = ৭। Several allowed; empty = every day is a workday. */
  weeklyOffDays: number[];
  /** `'HH:MM'` — ক্যাপচার উইন্ডো, ডিফল্ট ০৭:০০–২৩:০০ */
  screenshotFrom: string | null;
  screenshotTo: string | null;
  /**
   * `false` = no screenshots for this policy. The agent keeps sampling the
   * screen for the jiggler check, so hours are counted the same way.
   */
  screenshotsEnabled: boolean;
  /**
   * ⭐ `'HH:MM'` — অফিস কখন খোলা। ⚠️ ক্যাপচার উইন্ডো **নয়**: ওটা চওড়া
   * (০৭:০০–২৩:০০) যাতে কেউ আগে-পরে কাজ করলেও ছবি ওঠে, আর এটা সংকীর্ণ
   * (৯টা–৬টা) যাতে অফিস বন্ধ থাকলে "এজেন্ট চুপ" অ্যালার্ট না ওঠে।
   * `null` হলে সারাদিনই খোলা ধরা হয়।
   */
  officeFrom: string | null;
  officeTo: string | null;
  idleThresholdSec: number;
  slotMinutes: number;
  timezone: string;
  isActive: boolean;
  /** ⭐ deactivate করার আগে এটাই দেখার জিনিস — কেউ থাকলে সার্ভার আটকাবে */
  employeeCount: number;
}
export type WorkPolicyBody = Partial<{
  name: string;
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
 * ⚠️ এখানে একটা সংখ্যা বদলালে পরের config sync-এ **প্রতিটা PC-র আচরণ**
 * বদলে যায় (idle threshold, ছবির উইন্ডো)। নিশ্চিত করার ধাপ রাখুন।
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
 * ⭐⭐⭐ **বন্ধ করা পলিসি আবার খোলা** *(৬ সেপ্টেম্বর ২০২৬, G167)*।
 *
 * ⚠️⚠️ **যে বাগটা এটা সারায়:** সার্ভারে `POST /work-policies/:id/reactivate`
 * ছিল **G85 থেকেই** — কন্ট্রোলার, সার্ভিস, অডিট-সারি, পাঁচটা ইউনিট টেস্ট,
 * সব। কেবল **কেউ ওটা ডাকত না**। ওয়েবে এই ফাংশনটাই লেখা হয়নি, আর
 * PoliciesTab-এ `!isActive` শাখায় কোনো বোতামও ছিল না।
 *
 * ⚠️ ফলে ভুল করে Close চাপলে ফেরার পথ ছিল কেবল দুটো — `curl`, বা কাঁচা
 * SQL। ঠিক যে দুটো জিনিস দূর করতেই G85 লেখা হয়েছিল।
 *
 * ⭐ এই প্রকল্পের চেনা ভুলটাই আবার: **"চুক্তি লেখা আছে, কলার লেখা হয়নি।"**
 */
export function reactivateWorkPolicy(id: number): Promise<WorkPolicyView> {
  return api<WorkPolicyView>(`/work-policies/${id}/reactivate`, {
    method: 'POST',
  });
}
// ── ছুটি (owner-only) ───────────────────────────────────────────────────────

export interface HolidayView {
  id: number;
  /** `YYYY-MM-DD` */
  holidayDate: string;
  name: string;
  /** `public` | `optional` | `company` — খোলা রাখা হয়েছে */
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
 * ⚠️ পুরো E10-এ এটাই একমাত্র সত্যিকারের DELETE, আর নিরীহ নয়: ছুটি মুছলে
 * ওই মাসের কর্মদিবস বেড়ে যায়, ফলে **সবার pace পিছিয়ে যায়** — কেউ কোনো
 * কাজ না করেও। নিশ্চিত করার বাক্সে এটা বলুন।
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
