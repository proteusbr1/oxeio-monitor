import { api } from './client';
import { qs } from './query';
import type { Role } from "./staff";

/** The audit log — who looked at what, and who changed what. */

// ── E11 · audit log (owner-only) ────────────────────────────────────────────

export interface AuditLogRow {
  /** ⚠️ স্ট্রিং — সার্ভারে BigInt */
  id: string;
  occurredAt: string;
  /** `login` · `view_screenshot` · `payroll_view` · `change_setting` · `revoke_device` … */
  action: string;
  targetType: string | null;
  targetId: string | null;
  ipAddress: string | null;
  /** ⚠️ যেকোনো আকারের JSON — অন্ধভাবে render না করে `JSON.stringify` করে দেখান */
  meta: unknown;
  /** ইউজার মুছে গেলে `null` */
  user: {
    id: number;
    email: string;
    fullName: string;
    /**
     * ⚠️ টাইপটা `Role`, `string` নয় — নইলে ভূমিকার মানচিত্রগুলো
     * (`Record<Role, …>`) এই সারিটার উপর পাহারা দিতে পারত না, আর
     * enum বাড়লে পর্দায় নীরবে কাঁচা মান ফুটত।
     */
    role: Role;
  } | null;
}
export interface AuditLogPage {
  rows: AuditLogRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}
export interface AuditLogQuery {
  userId?: number;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** ⚠️ ISO-8601 **instant** (`2026-08-10T00:00:00Z`), শুধু তারিখ নয় */
  from?: string;
  to?: string;
  page?: number;
  /** ডিফল্ট ৫০, সর্বোচ্চ ২০০ — বেশি চাইলে ৪০০ */
  pageSize?: number;
}
export function listAuditLog(
  query: AuditLogQuery = {},
  signal?: AbortSignal,
): Promise<AuditLogPage> {
  return api<AuditLogPage>(`/audit-log${qs({ ...query })}`, { signal });
}
