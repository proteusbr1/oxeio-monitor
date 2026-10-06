import { api } from './client';

/** PCs (devices) and the agent builds offered to them. */

export type DeviceStatus = 'active' | 'revoked';
// ── Devices (owner-only) ────────────────────────────────────────────────────

export interface DeviceView {
  id: number;
  hostname: string;
  windowsUsername: string;
  machineGuid: string;
  osVersion: string | null;
  agentVersion: string | null;
  monitors: number;
  status: DeviceStatus;
  /** ISO instant — `null` if it never responded */
  lastSeenAt: string | null;
  /** Clock drift in seconds — if large, the time figures are suspect */
  lastDriftSec: number;
  maxDriftSec: number;
  /**
   * The agent's own report on its parts, e.g. `{ browserDomain: 'degraded' }`.
   * `null`/missing until an agent that sends it checks in.
   */
  capabilities?: Record<string, string> | null;
  capabilitiesAt?: string | null;
  enrolledAt: string;
  /** `null` if not linked to any employee */
  employee: { id: number; empCode: string; fullName: string } | null;
}
/**
 * **This route existed on the server for a long time; the web never called it.**
 *
 * The `DeviceView` type above was also already written, so both sides of the
 * contract existed with no call in between. Result: the question "which agent
 * runs on which PC" was answered nowhere on screen, although the data was one
 * call away (raised by the owner).
 *
 * Owner-only (`@Roles(UserRole.owner)`), and the server wraps the result in a
 * `{ rows, total }` envelope — `total` is not needed here, only the rows are returned.
 */
export function listDevices(signal?: AbortSignal): Promise<DeviceView[]> {
  return api<{ rows: DeviceView[]; total: number }>('/devices', {
    signal,
  }).then((r) => r.rows);
}
// ── H04 · Agent version rollout ─────────────────────────────────────────────

export type RolloutStage = 'canary' | 'partial' | 'all' | 'halted';
/**
 * These labels appear on the owner's screen, so no technical names — what
 * "canary" means cannot be assumed to be known.
 */
export const STAGE_LABEL: Record<RolloutStage, string> = {
  canary: 'A few PCs first',
  partial: 'About half',
  all: 'Everyone',
  halted: 'Stopped',
};
export interface AgentVersionView {
  version: string;
  sha256: string;
  sizeBytes: number | null;
  rolloutStage: RolloutStage;
  isMandatory: boolean;
  releaseNotes: string | null;
  releasedAt: string;
  /** The row exists but the MSI file is not on disk — agents fetching it get a 404 */
  fileMissing: boolean;
  /** Published with the owner's signature (`<msi>.sig`); optional for older servers */
  signed?: boolean;
  devicesOn: number;
  /**
   * The PC that gets this version first, regardless of rollout stage.
   * `null` means none.
   */
  pilotDeviceId: number | null;
  /** Display name for the screen — the employee's name, or the hostname if none */
  pilotLabel: string | null;
}
export function listAgentVersions(
  signal?: AbortSignal,
): Promise<AgentVersionView[]> {
  return api<AgentVersionView[]>('/agent-versions', { signal });
}
export function publishAgentVersion(body: {
  version: string;
  msiPath: string;
  releaseNotes?: string;
  rolloutStage?: RolloutStage;
  isMandatory?: boolean;
}): Promise<AgentVersionView> {
  // `body` is a raw object — `api()` calls `JSON.stringify` itself. Stringifying
  // here first would encode it twice, the server would receive a **string**,
  // and the browser would get `"…" is not valid JSON`.
  return api<AgentVersionView>('/agent-versions', { method: 'POST', body });
}
/**
 * Not sending `pilotDeviceId` and sending `null` are different: the first
 * means "leave it as it was", the second means "remove the pilot". Without the
 * distinction, merely changing the stage would silently erase the chosen PC.
 */
export function setAgentRollout(
  version: string,
  rolloutStage: RolloutStage,
  pilotDeviceId?: number | null,
): Promise<AgentVersionView> {
  return api<AgentVersionView>(
    `/agent-versions/${encodeURIComponent(version)}/stage`,
    {
      method: 'POST',
      body:
        pilotDeviceId === undefined
          ? { rolloutStage }
          : { rolloutStage, pilotDeviceId },
    },
  );
}
