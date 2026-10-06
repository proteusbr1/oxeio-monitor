import { api } from './client';

/**
 * **B14 · ADR-011e** — the owner gives back hours lost through the system's fault.
 *
 * This is **not an approval system**. Staff claim nothing and press nothing;
 * the owner looks and decides. Once a "claim" existed, it would drag in a full
 * approval workflow, which this system deliberately does not have
 * (section 4 · ADR-011d).
 */
export interface AdjustmentView {
  /** A string — `BigInt` on the server; sending a JSON number would break */
  id: string;
  employeeId: number;
  workDate: string;
  /** + = hours given back · − = hours deducted */
  deltaSec: number;
  cause: AdjustmentCause;
  reason: string;
  beyondEvidence: boolean;
  createdAt: string;
  createdBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  /** A revoked adjustment is no longer counted */
  active: boolean;
}

export type AdjustmentCause =
  | 'agent_down'
  | 'server_down'
  | 'agent_crash'
  | 'pc_replaced'
  | 'data_loss'
  | 'other';

/**
 * Staff read these labels too (J08), so no technical wording: "The agent
 * crashed" instead of "agent_crash". The cause explains their own hours.
 */
export const CAUSE_LABELS: Record<AdjustmentCause, string> = {
  agent_down: 'The agent was not running',
  server_down: 'The server was unreachable',
  agent_crash: 'The agent crashed',
  pc_replaced: 'The PC was replaced',
  data_loss: 'Data was lost',
  other: 'Something else',
};

export function listAdjustments(
  employeeId: number,
  signal?: AbortSignal,
): Promise<AdjustmentView[]> {
  return api<AdjustmentView[]>(`/employees/${employeeId}/time-adjustments`, {
    signal,
  });
}

export function createAdjustment(
  employeeId: number,
  body: {
    workDate: string;
    deltaSec: number;
    cause: AdjustmentCause;
    reason: string;
    beyondEvidence?: boolean;
  },
): Promise<AdjustmentView> {
  return api<AdjustmentView>(`/employees/${employeeId}/time-adjustments`, {
    method: 'POST',
    body,
  });
}

/** Not a delete: the row stays, it just stops being counted. */
export function revokeAdjustment(
  id: string,
  reason: string,
): Promise<AdjustmentView> {
  return api<AdjustmentView>(`/time-adjustments/${id}/revoke`, {
    method: 'POST',
    body: { reason },
  });
}
