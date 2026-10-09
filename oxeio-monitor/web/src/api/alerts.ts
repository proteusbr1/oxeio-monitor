import { api } from './client';
import { qs } from './query';

/**
 * G01–G07 — the alert list and acknowledge.
 *
 * Server source: `server/src/alerts/` (alerts.controller.ts ·
 * alerts.service.ts · alerts.constants.ts).
 *
 * Careful: all of it is **owner-only**. An alert carries the hostname, the
 * employee's name and the device state together, and managers must not see
 * those (section 4.3). Do not show managers the alert badge either.
 */

export type AlertType =
  | 'agent_down'
  | 'agent_killed'
  | 'disk_warning'
  | 'disk_critical'
  | 'backup_failed'
  | 'clock_drift'
  | 'no_activity_today'
  | 'device_overlap'
  | 'synthetic_input'
  | 'agent_capability'
  | 'statement_delivery_failed';

export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * Display names for the screen — kept identical across all pages.
 *
 * Note: no page renders these yet (there is no alerts page). They are still
 * in the **same language** as the rest of the UI; otherwise, by the time the
 * page is written, the whole dashboard would be English with an alert list in
 * another language, and nobody would remember this file was left untranslated.
 *
 * Careful: the `agent_down` text matches `STATUS_LABEL` in `StatusDot`
 * **exactly** ("Agent down"). Calling the same event by two names on two
 * screens would make them look like different things.
 */
export const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  agent_down: 'Agent down',
  agent_killed: 'Agent was stopped',
  disk_warning: 'Disk filling up',
  disk_critical: 'Disk almost full',
  backup_failed: 'Backup failed',
  clock_drift: 'Clock drift',
  no_activity_today: 'No activity today',
  device_overlap: 'Two devices at once',
  /**
   * **G46** — the name is deliberately neutral: not "Unbroken activity" or
   * "Fake input". The alert is a suspicion, not proof, and if the filter
   * dropdown said "Fake input" the owner would decide just by opening the list.
   */
  synthetic_input: 'Unbroken activity',
  agent_capability: 'Agent part not working',
  statement_delivery_failed: 'Hours statement not sent',
};

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};

export interface AlertRow {
  /** A string — `BigInt` on the server */
  id: string;
  /** The column is TEXT, so a value outside the list can in theory arrive */
  type: string;
  severity: AlertSeverity;
  title: string;
  detail: string | null;
  deviceId: number | null;
  deviceHostname: string | null;
  employeeId: number | null;
  employeeName: string | null;
  meta: unknown;
  /** Channels it was sent to (`email` …) */
  channelsSent: string[];
  acknowledgedAt: string | null;
  /** Whoever first said "seen" — the name does not change if someone else acknowledges later */
  acknowledgedBy: string | null;
  /**
   * Closed by the **server itself** (the agent came back) — no human looked.
   * Distinct from acknowledgedAt: "open" means both are null.
   */
  resolvedAt: string | null;
  createdAt: string;
}

export interface AlertPage {
  total: number;
  page: number;
  limit: number;
  /** Total not yet acknowledged, whatever the filter — the nav badge shows this */
  openCount: number;
  rows: AlertRow[];
}

export interface AlertListQuery {
  /** Defaults to `open` — the list exists for "not yet looked at" */
  status?: 'open' | 'all';
  type?: AlertType;
  severity?: AlertSeverity;
  page?: number;
  /** Default 50, max 200 */
  limit?: number;
}

export function listAlerts(
  query: AlertListQuery = {},
  signal?: AbortSignal,
): Promise<AlertPage> {
  return api<AlertPage>(`/alerts${qs({ ...query })}`, { signal });
}

/**
 * Mark as seen ("acknowledge").
 *
 * Careful: alerts are **never deleted**, only acknowledged, so the UI should
 * say "Seen", not "Delete". The history later serves as evidence for hour
 * corrections.
 *
 * Idempotent, and **the first person's name is kept**.
 */
export function acknowledgeAlert(id: string): Promise<AlertRow> {
  return api<AlertRow>(`/alerts/${id}/acknowledge`, { method: 'POST' });
}

/**
 * Acknowledge all open alerts at once — as with G01, it saves pressing them one
 * by one when the same problem shows up repeatedly on 12 PCs.
 *
 * Rows already seen are untouched; returns how many were newly seen.
 */
export function acknowledgeAllAlerts(): Promise<{ count: number }> {
  return api<{ count: number }>(`/alerts/acknowledge-all`, { method: 'POST' });
}
