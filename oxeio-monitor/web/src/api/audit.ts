import { api } from './client';
import { qs } from './query';
import type { Role } from "./staff";

/** The audit log — who looked at what, and who changed what. */

// ── E11 · audit log (owner-only) ────────────────────────────────────────────

export interface AuditLogRow {
  /** A string — `BigInt` on the server */
  id: string;
  occurredAt: string;
  /** `login` · `view_screenshot` · `payroll_view` · `change_setting` · `revoke_device` … */
  action: string;
  targetType: string | null;
  targetId: string | null;
  ipAddress: string | null;
  /** JSON of any shape — show it via `JSON.stringify`, never render it blindly */
  meta: unknown;
  /** `null` when the user has been deleted */
  user: {
    id: number;
    email: string;
    fullName: string;
    /**
     * The type is `Role`, not `string`: otherwise the role maps
     * (`Record<Role, …>`) could not guard this row, and a new enum value
     * would silently show up raw on screen.
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
  /** ISO-8601 **instant** (`2026-08-10T00:00:00Z`), not just a date */
  from?: string;
  to?: string;
  page?: number;
  /** Default 50, max 200 — asking for more gets a 400 */
  pageSize?: number;
}
export function listAuditLog(
  query: AuditLogQuery = {},
  signal?: AbortSignal,
): Promise<AuditLogPage> {
  return api<AuditLogPage>(`/audit-log${qs({ ...query })}`, { signal });
}
