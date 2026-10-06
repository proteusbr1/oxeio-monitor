import { api } from './client';
import { qs } from './query';

/** Staff: people, their portal logins and roles, staff codes. */

/**
 * E10 · E11 · H05 · H06 — স্টাফ, ডিভাইস, work policy, ছুটি, audit log।
 *
 * সার্ভারের উৎস: `server/src/admin/` ও `server/src/users/`।
 *
 * ⭐ ভূমিকার সীমানাটা এখানে সবচেয়ে সূক্ষ্ম:
 *   · `GET /employees`, `GET /employees/:id` — **owner + manager**
 *     (ম্যানেজারের লাইভ ভিউ ও রিপোর্ট নামের তালিকা ছাড়া অর্থহীন)
 *   · বাকি **সবকিছু** — owner-only: স্টাফ লেখা, ডিভাইস, policy, ছুটি,
 *     audit log, পাসওয়ার্ড রিসেট, portal অ্যাকাউন্ট
 *
 * ⚠️ owner-only জিনিস ম্যানেজারকে **দেখানোই হবে না** — `useAuth().user.role`
 *    দেখে বোতাম/ট্যাব লুকান। ৪০৩ ধরে বার্তা দেখানো শেষ রক্ষাকবচ, প্রথম নয়।
 */

export type EmployeeStatus = 'active' | 'inactive';
/** ⚠️ `UserRole` (কে কী দেখবে) নয় — এটা "কে কী কাজ করে" */
export type StaffType = 'designer' | 'researcher' | 'manager';
export const STAFF_TYPE_LABEL: Record<StaffType, string> = {
  designer: 'Designer',
  researcher: 'Researcher',
  manager: 'Manager',
};
/**
 * ⭐⭐ **পোর্টালের ভূমিকা** — কে কোন পর্দায় ঢোকেন।
 *
 * ⚠️⚠️ `StaffType`-এর সাথে গুলিয়ে ফেলবেন না: ওটা **কী কাজ করেন**, এটা
 * **কী দেখতে পান**। নামগুলো মিলে যায় বলেই ভুলটা সহজ।
 *
 * ⭐ `researcher` যোগ হয়েছে ২৫ আগস্ট ২০২৬ *(মালিক: "researcher and
 * designer same kaj kore na, tai eder access o same hobe na")*। এতদিন
 * দুজনেরই রোল ছিল `employee`, আর পার্থক্যটা লুকিয়ে ছিল অন্য টেবিলে।
 */
export type Role = 'owner' | 'manager' | 'researcher' | 'employee';
/**
 * ⭐ ড্রপডাউন থেকে **যে ভূমিকাগুলো বসানো যায়** — `owner` ইচ্ছাকৃতভাবে বাইরে।
 *
 * owner মানে বেতন, audit log আর সেটিংসের চাবি; সেটা এক ক্লিকে হাতবদলের
 * জিনিস নয় (ADR-011d)। সার্ভারের DTO-তেও `@IsIn` একই তালিকা আটকায়।
 *
 * ⚠️ নামটা আলাদা করে রাখা হলো যাতে `Role`-এর সাথে গুলিয়ে না যায় —
 * ১৩ আগস্ট ঠিক ওই গুলিয়ে ফেলাটাই **ওয়েব বিল্ড ভেঙে রেখেছিল** (TS2345),
 * আর ভাঙা অবস্থায় তিনটে কমিট পার হয়ে গেছে।
 */
export type AssignableRole = Exclude<Role, 'owner'>;
/**
 * ⭐⚠️ `monthlySalary` **ঐচ্ছিক, কারণ ম্যানেজারের JSON-এ key-টাই থাকে না**
 * (`undefined`, `null` নয় — সার্ভার ইচ্ছাকৃতভাবে key বসায়ই না, redact.ts)।
 * তাই `emp.monthlySalary ?? '—'` লিখলে ম্যানেজারের পর্দাতেও বেতনের ঘর
 * বসে যেত। কলামটাই render করবেন না যদি `user.role !== 'owner'`।
 */
export interface EmployeeView {
  id: number;
  empCode: string;
  fullName: string;
  email: string | null;
  designation: string | null;
  /**
   * ⭐ কাজের ধরন *(২১ আগস্ট)* — নিয়ম **কেবল এর উপরেই** বসে।
   *
   * ⚠️ `designation`-এর বিকল্প নয়: ওটা পদবি (মুক্ত-লেখা), এটা শ্রেণি।
   * ⚠️ `null` মানে "বসানো হয়নি" — টার্গেটের হিসাব তখন ওই কর্মীকে **ছেড়ে
   * দেয়**, শূন্য ধরে না।
   */
  staffType: StaffType | null;
  department: string | null;
  /**
   * ⭐⭐ **এই ডিজাইনারের নিজের দৈনিক ডিজাইন-টার্গেট** *(২৩ আগস্ট ২০২৬)*।
   *
   * ⚠️ `null` = **বসানো নেই** → পলিসির সংখ্যাটা (২৫) খাটবে। শূন্য নয়।
   * ⚠️⚠️ `0` = **টার্গেট বন্ধ** — সংখ্যা গোনা চলবে, কিন্তু কেউ "পিছিয়ে" নয়।
   *    দুটো আলাদা অবস্থা, আর সেটাই এখানে `number | null` রাখার কারণ।
   */
  dailyDesignTarget: number | null;
  policyId: number | null;
  /** `YYYY-MM-DD` */
  joinedOn: string | null;
  leftOn: string | null;
  /** ⭐ এজেন্ট বসানোর জন্য তৈরি কি না — Staff পর্দার "Setup" কলাম */
  hasPortalAccount: boolean;
  hasDevice: boolean;
  /** ⭐ portal অ্যাকাউন্টের id ও লগইন ইমেইল — রিসেট ও ইমেইল বদলানোর জন্য */
  portalUserId: number | null;
  portalEmail: string | null;
  /**
   * ⚠️ ড্রপডাউনটা **বর্তমান** ভূমিকা দেখিয়ে খুলতে হয়। null ধরে "Staff"
   * দেখালে কেউ শুধু ইমেইল বদলাতে গিয়ে সেভ চাপলে একজন ম্যানেজার নীরবে
   * স্টাফ হয়ে যেতেন।
   */
  /**
   * ⚠️⚠️ টাইপটা `Role` **ধার করা**, হাতে লেখা তালিকা নয়। আগে এখানে
   * `'owner' | 'manager' | 'employee'` লেখা ছিল, আর ২৫ আগস্ট
   * `researcher` যোগ করার সময় সেটা নীরবে পিছিয়ে পড়ত — একটা গবেষকের
   * ভূমিকা মিলিয়ে দেখতে গেলে TypeScript বলত "এদের কোনো মিলই নেই"।
   */
  portalRole: Role | null;

  /**
   * ⭐ এজেন্ট বসানো ছিল, কিন্তু এখন বন্ধ — সারিতে "Turn agent on" দেখানোর ভিত্তি।
   *
   * ⚠️ `hasDevice === false` দুটো সম্পূর্ণ আলাদা অবস্থায় সত্যি হয়:
   * কখনো বসানো হয়নি, আর বসানো ছিল কিন্তু বন্ধ করে দেওয়া। প্রথমটায়
   * PC-তে যেতে হয়, দ্বিতীয়টায় সারিতেই এক ক্লিক।
   */
  agentSwitchedOff: boolean;
  status: EmployeeStatus;
  policySignedAt: string | null;
  policyDocPath: string | null;
  createdAt: string;
  /** ⭐ শুধু owner-এর রেসপন্সে থাকে। উপরের নোটটা পড়ুন। */
  monthlySalary?: string | null;
}
export interface EmployeeListQuery {
  /** ডিফল্ট `active` */
  status?: EmployeeStatus | 'all';
  /** নাম, কোড বা ইমেইলে খোঁজা */
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
 * ⚠️ `empCode` **নেই, ইচ্ছাকৃতভাবে** — সার্ভার নিজে বসায়।
 *
 * ⚠️ পাঠালে ৪০০ আসবে (`forbidNonWhitelisted`), চুপচাপ উপেক্ষা নয়।
 */
export interface CreateEmployeeBody {
  fullName: string;
  email?: string;
  designation?: string;
  department?: string;
  staffType?: StaffType;
  /** ⚠️ না পাঠালে বা `null` হলে পলিসির টার্গেট খাটবে; `0` = বন্ধ */
  dailyDesignTarget?: number | null;
  policyId?: number;
  /**
   * ⭐⚠️ টাকা **স্ট্রিং** হিসেবে পাঠাতে হবে (`'13000'` বা `'13000.50'`)।
   * সংখ্যা পাঠালে JSON-এর float-এ ১৩০০০.১০ হয়ে যেত ১৩০০০.০৯৯৯…, আর
   * এক পয়সার হেরফের কেউ ধরতে পারত না। ইনপুট বাক্সের মান সরাসরি দিন।
   */
  monthlySalary?: string;
  joinedOn?: string;
}
/**
 * ⚠️ `undefined` = "হাত দিও না", `null` = "মুছে দাও" — সার্ভার দুটোকে
 *    আলাদা করে। ফাঁকা ইনপুট বাক্স থেকে `''` না পাঠিয়ে `null` পাঠান।
 */
/** ⚠️ `empCode` এখানেও নেই — একবার বসলে আর বদলায় না। */
export type UpdateEmployeeBody = Partial<{
  fullName: string;
  email: string | null;
  designation: string | null;
  department: string | null;
  staffType: StaffType | null;
  /** ⚠️ `null` = "নিজের সংখ্যা মুছে পলিসিতে ফেরাও"; `0` = টার্গেট বন্ধ */
  dailyDesignTarget: number | null;
  policyId: number | null;
  monthlySalary: string | null;
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
 * ⚠️ **ডিলিট নেই, deactivate আছে** — সারিটা মুছলে ওই কর্মীর মাসের হিসাব,
 * স্ক্রিনশট আর audit trail সব অনাথ হতো। তাই UI-তেও "মুছে ফেলুন" লিখবেন না।
 *
 * ⭐ এটা একইসাথে তার সব ডিভাইস revoke করে, enrollment code বাতিল করে আর
 * portal অ্যাকাউন্ট বন্ধ করে — নিশ্চিত করার বাক্সে সেটা বলা দরকার।
 *
 * `reason` বাধ্যতামূলক, অন্তত ৩ অক্ষর।
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
  /** ⭐⚠️ **এই একবারই দেখা যাবে** — সার্ভারে শুধু sha256 জমা থাকে */
  code: string;
  expiresAt: string;
  employee: { id: number; empCode: string; fullName: string };
}
// ── অ্যাকাউন্ট (owner-only) ─────────────────────────────────────────────────

/** ⭐ `tempPassword` একবারই আসে — মোডালে দেখিয়ে দিন, কোথাও জমা থাকে না */
export function resetUserPassword(
  userId: number,
  /** ⭐ মালিক নিজে বসালে বাধ্যতামূলক বদল নেই (২৩ আগস্ট) */
  password?: string,
): Promise<{ email: string; tempPassword: string }> {
  return api<{ email: string; tempPassword: string }>(
    `/users/${userId}/reset-password`,
    { method: 'POST', body: password ? { password } : {} },
  );
}
/**
 * পরের কর্মী-কোডের পরামর্শ — নতুন কর্মীর ফর্ম খোলার সময়।
 *
 * ⚠️ এটা **পরামর্শ**, নিশ্চয়তা নয় — ঘরটা সম্পাদনযোগ্যই থাকে, আর দুজন
 * একসাথে যোগ করলে দ্বিতীয়জন সার্ভার থেকে ৪০৯ পাবে।
 */
export function nextEmployeeCode(
  signal?: AbortSignal,
): Promise<{ code: string }> {
  return api<{ code: string }>('/employees/next-code', { signal });
}
/** লগইনের ইমেইল বদলানো — স্টাফের "ইউজারনেম" */
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
 * স্টাফ ↔ ম্যানেজার।
 *
 * ⚠️ `owner` পাঠানো যায় না — সার্ভার ৪০০ দেবে। owner মানে বেতন, audit log
 * আর সেটিংসের চাবি; সেটা ড্রপডাউনের এক ক্লিকে হাতবদলের জিনিস নয়।
 */
/**
 * বন্ধ হয়ে যাওয়া এজেন্ট আবার চালু — **কর্মী ধরে, ডিভাইস ধরে নয়**।
 *
 * ⚠️ মালিক "ডিভাইস #৬১" নিয়ে ভাবেন না, ভাবেন "Belal-এর PC" নিয়ে। তাই
 * আলাদা Devices পর্দা তুলে দিয়ে কাজটা Staff সারিতে আনা হয়েছে।
 */
export function turnAgentOn(employeeId: number): Promise<{ restored: number }> {
  return api<{ restored: number }>(`/employees/${employeeId}/agent/turn-on`, {
    method: 'POST',
  });
}
/**
 * ⚠️ টাইপটা `AssignableRole` — `Role` নয়। `owner` এখান দিয়ে বসানো
 * যায় না, আর সেটা **কম্পাইলারই** আটকায় (ADR-011d)।
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
/** স্টাফের নিজস্ব ভিউয়ের অ্যাকাউন্ট (J04/J05) — ডিফল্ট role `employee` */
export function createPortalAccount(
  employeeId: number,
  email: string,
  role?: Role,
  /**
   * ⭐ মালিকের বেছে দেওয়া পাসওয়ার্ড *(২৩ আগস্ট)*।
   *
   * ⚠️ খালি রাখলে আগের আচরণ: সিস্টেম এলোমেলো পাসওয়ার্ড বানায় **আর
   * প্রথম লগইনে বদলাতে বলে**। দিলে সেটাই বসে, বদলানোর পর্দা আসে না।
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
