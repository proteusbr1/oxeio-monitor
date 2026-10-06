import { api } from './client';
import { qs } from './query';

/** Payroll: the pay sheet, leave, month closing and security deposits. */

/** একজনের মাস-ধরে খাতা — owner-এর সংশোধনের পর্দার জন্য */
export interface DepositMonths {
  months: { yearMonth: string; amount: string }[];
  total: string;
  totalPaisa: number;
  settlement: unknown | null;
  noticeDays: number;
}
/**
 * ⚠️⚠️ **মাসগুলো এতদিন কেবল কর্মীর নিজের পাতায় দেখা যেত** (`/me/deposit`)।
 * মালিকের পাতায় ছিল শুধু যোগফল — *"2 months held · ৳500"* — আর ওই দুটো
 * সংখ্যা একসাথে পড়লে অর্থহীন হতে পারে। মাঠে ঠিক তাই হয়েছিল: একটা মাস
 * ৳০-তে বসে ছিল, আর কেউ ধরতেই পারছিল না কেন যোগফল মেলে না।
 */
export function depositMonths(
  employeeId: number,
  signal?: AbortSignal,
): Promise<DepositMonths> {
  return api<DepositMonths>(`/deposits/${employeeId}/months`, { signal });
}
/**
 * ⭐⭐ বসে যাওয়া একটা কিস্তির অঙ্ক সংশোধন।
 *
 * ⚠️ এতদিন এর কোনো পথ ছিল না — `ensureLedger()` বিদ্যমান সারি কখনো
 * হালনাগাদ করে না (ইচ্ছাকৃত), তাই ভুল অঙ্ক চিরকাল বসে থাকত।
 * ⚠️ `reason` বাধ্যতামূলক, আর `amountPaisa` শূন্য হতে পারে না।
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
// ── R1 · মাস বন্ধ করা ────────────────────────────────────────────────────────

export interface MonthClosureView {
  /** '2026-08' */
  yearMonth: string;
  /** ISO instant */
  closedAt: string;
  /** ⚠️ ইমেইল — ইউজার মুছে গেলেও "কে বন্ধ করেছিল" টিকে থাকা দরকার */
  closedBy: string;
  note: string | null;
}
/**
 * R1 — `GET /api/v1/months` · owner-only।
 *
 * ⭐ শুধু **বন্ধ** মাসগুলোই ফেরে, সব মাস নয় — খোলা মাস মানে "এখনো নড়তে
 * পারে", আর সেটা অনুপস্থিতি দিয়েই বোঝা যায়।
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
 * ⚠️ খোলা মানে বন্ধের রেকর্ডটা তুলে নেওয়া — তাই `DELETE`।
 * ⭐ audit-এ দুটো সারিই (`month_closed`, `month_reopened`) থেকে যায়,
 *    অর্থাৎ ইতিহাস মোছে না।
 */
export function reopenMonth(
  yearMonth: string,
): Promise<{ yearMonth: string; reopened: true }> {
  return api<{ yearMonth: string; reopened: true }>(`/months/${yearMonth}`, {
    method: 'DELETE',
  });
}
// ── R2 · ছুটির খাতা ──────────────────────────────────────────────────────────

export interface LeaveView {
  id: number;
  employeeId: number;
  employeeName: string;
  /** 'YYYY-MM-DD' */
  leaveDate: string;
  /** `casual` · `sick` · `annual` — ⚠️ তিনটেই সবেতন */
  type: string;
  note: string | null;
  createdBy: string;
  /**
   * ⭐⭐ ওই দিনটা ওই কর্মীর কর্মদিবস ছিল কি না।
   *
   * ⚠️ `false` মানে সারিটা খাতায় আছে কিন্তু **টার্গেটের কিছুই কমায়নি** —
   *    শুক্রবার বা সরকারি ছুটির দিনে লেখা ছুটি। পর্দায় এটা আলাদা করে না
   *    দেখালে খাতাটা একটা ছাড়ের দাবি করত যা সে দেয়নি।
   */
  countsTowardTarget: boolean;
}
/** R2 — `GET /api/v1/leaves?month=YYYY-MM` · ⚠️ মাস বাধ্যতামূলক */
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
 * ⭐ রেঞ্জ ধরে — মানুষ "১০ থেকে ১৪" ছুটি নেয়, "১০" পাঁচবার নয়।
 *
 * ⚠️ `skipped` খালি না হলে **সেটা দেখাতেই হবে**: ওই দিনগুলো আগে থেকেই
 *    খাতায় ছিল, তাই যোগ হয়নি। "৫টা যোগ হয়েছে" বলাটা তখন মিথ্যা হতো।
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
// ── R21 · সিকিউরিটি মানি (জামানত) ────────────────────────────────────────

/**
 * ⚠️ পুরো পথটা **owner-only** — জামানত সরাসরি বেতনের অংশ, আর বেতনের কোনো
 * সংখ্যা ম্যানেজারের নাগালে নেই (ADR-023 · ADR-027)।
 */
export interface DepositPolicyView {
  /** '500.00' */
  amount: string;
  /** ⭐ পাঠানোর সময় **পয়সায়** যায় — ৫০০ টাকা = ৫০০০০ */
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
   * ⭐ মালিকের বেছে দেওয়া শুরুর মাস — না দিলে `null` (নিয়মই চলছে)।
   *
   * ⚠️ `effectiveStart`-ও আসে, কারণ পর্দায় দরকার **কোন মাস থেকে সত্যিই
   * কাটা হচ্ছে**। শুধু override দেখালে খালি ঘর দেখে মালিক বুঝতেন না
   * আসলে কোন মাস খাটছে।
   */
  startYearMonth: string | null;
  effectiveStart: string | null;

  employeeId: number;
  empCode: string;
  fullName: string;
  status: string;
  /** কত মাসের কিস্তি বসেছে */
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
  /** 'YYYY-MM-DD' — ⚠️ দুটোই ঐচ্ছিক, "জানা নেই" আর "শূন্য দিন" এক নয় */
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
// ── F03 · পে-রোল (owner-only) ───────────────────────────────────────────────

export interface PayrollRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  /**
   * ⭐ কাজের ধরন *(২২ আগস্ট)* — আগে এখানে `designation` ছিল।
   *
   * ⚠️ পদবির ঘরটা ফর্ম থেকে তুলে দেওয়া হয়েছে (মালিকের সিদ্ধান্ত), তাই
   * নতুন কর্মীর জন্য ওটা চিরকাল খালি থাকত — অর্থাৎ পর্দায় নীরবে কিছুই
   * দেখাত না।
   */
  staffType: 'designer' | 'researcher' | 'manager' | null;
  /**
   * ⭐ `null` = এই কর্মীর বেতন **বসানো নেই** — শূন্য নয়। দুটোকে এক করে
   * দেখালে শিটে চুপচাপ ভুল সংখ্যা যেত।
   * ⚠️ সব টাকা ও ঘণ্টা **স্ট্রিং** — Decimal, float নয়। `Number()` করে
   *    হিসাব করবেন না, `formatTaka()` / `formatHoursAsDuration()` ব্যবহার করুন।
   */
  monthlySalary: string | null;
  targetHours: string;
  /**
   * ⭐⭐⭐ **টার্গেটের যতটুকু সত্যিই দেখা হয়েছে** *(৬ সেপ্টেম্বর ২০২৬)*।
   *
   * ⚠️⚠️ কর্তন **এটার** সাপেক্ষে, `targetHours`-এর নয় — মালিকের সিদ্ধান্ত:
   * *"না-দেখা দিনের জন্য কর্তন হবে না"*। দুটো আলাদা করে দেখানো হয়, নইলে
   * *"টার্গেট ২০৮ ঘণ্টা অথচ ঘাটতি মাত্র ২ ঘণ্টা কেন"* প্রশ্নের উত্তর
   * পর্দায় থাকত না।
   */
  observedTargetHours: string;
  /** ⭐ যতগুলো কর্মদিবসের সারি সত্যিই লেখা হয়েছিল *(৬ সেপ্টেম্বর)* */
  observedWorkdays: number;
  /** ⭐ G37 — তার কর্মদিবস (d) ও মাসের কর্মদিবস (D)। d < D মানে prorated */
  workdays: number;
  monthWorkdays: number;
  /**
   * ⭐⭐⭐ **R21 — এই মাসে জামানতের কিস্তি, আর হাতে যা যাবে**
   * *(৬ সেপ্টেম্বর ২০২৬-এ পর্দায় বসানো)*।
   *
   * ⚠️⚠️ সার্ভার এই দুটো **প্রথম দিন থেকেই** পাঠাচ্ছিল, কিন্তু পর্দা
   * ওগুলো ঘোষণাও করেনি, দেখায়ওনি — অর্থাৎ মালিক যে শিট দেখে টাকা দেন
   * সেখানে **gross** লেখা থাকত, আর খাতা বলত ৳১১,০০০ কেটে রাখা হয়েছে।
   * ⭐ এই রেপোর চেনা পাপ: চুক্তি লেখা আছে, কলার লেখা হয়নি।
   *
   * ⚠️ `null` — বেতন বসানো না থাকলে নিট হিসাব করা যায় না।
   */
  securityDeposit: string | null;
  netPayable: string | null;
  creditedHours: string;
  shortfallHours: string;
  overtimeHours: string;
  hourlyRate: string | null;
  deduction: string | null;
  payable: string | null;
}
export interface PayrollSheet {
  /** `YYYY-MM` */
  yearMonth: string;
  rows: PayrollRow[];
  /** ⭐ যাদের বেতন বসানো নেই — নাম ধরে দেখাতে হবে */
  missingSalary: string[];
  /** যাদের ওই মাসের rollup এখনো হয়নি — এঁরা `rows`-এ **নেই** */
  missingSummary: string[];

  /**
   * ⚠️⚠️ **R21** — যাঁদের ওই মাসের প্রদেয় জামানতের কিস্তির চেয়ে কম, তাই
   * নিট শূন্যে থেমেছে।
   *
   * ⚠️ সার্ভার ঘরটা **অনেক আগে থেকেই পাঠাত**, এখানে declare করা ছিল না —
   * তাই পর্দা জানতই না, আর নীরবে থামাটাই ঘটত। অথচ `payroll.service.ts`-এর
   * ডকেই লেখা: *"নীরবে থামালে খাতায় ৫০০ জমা দেখাত অথচ টাকাটা কোনোদিন
   * কাটাই যেত না"*।
   */
  depositExceedsPayable: string[];

  /**
   * ⭐⭐ **G108** — এই মাসের যেসব ছুটির তারিখ এখনো পাকা নয়।
   * ⚠️ প্রতিটা সারির `payable` দাঁড়িয়ে `d ÷ D`-এর উপর, আর `D` গোনা হয়
   * এই মাসের ছুটির তালিকা ধরে — একটা তারিখ নড়লে **টাকা** নড়ে।
   */
  approximateHolidayDates: string[];
}
/**
 * F03 — `GET /api/v1/payroll?month=YYYY-MM`
 *
 * ⭐⚠️ **owner-only, এবং প্রতিটা কল audit-এ লেখা হয়** (payroll_view)।
 * ম্যানেজারকে এই পেজের লিঙ্কও দেখানো যাবে না — `user.role === 'owner'`
 * না হলে রুটটাই render করবেন না, শুধু ৪০৩ ধরলে হবে না।
 */
export function getPayroll(
  month: string,
  signal?: AbortSignal,
): Promise<PayrollSheet> {
  return api<PayrollSheet>(`/payroll${qs({ month })}`, { signal });
}
