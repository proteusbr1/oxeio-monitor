/**
 * **The agent's resource report**: pure rules, no database.
 *
 * Why it exists: an NVIDIA overlay injects `nvspcap64.dll` into every process
 * that captures the screen. In one agent it leaked ~217k kernel handles and
 * 7 GB of private memory over twelve days, and from the server the PC simply
 * looked "slow". The agent now reports what it holds in every heartbeat, and
 * restarts itself cleanly above a ceiling (`ResourceCeiling` in the agent);
 * this side stores the last report and tells the owner.
 *
 * Careful: the ceiling numbers below are a **copy of the agent's**
 * (`agent/src/oXeio.Core/Watchdog/ResourceCeiling.cs`). If they drifted apart,
 * the owner would get an alert for a PC the agent considers fine, or none for
 * one it is about to restart.
 */

/** Above this many handles the agent restarts itself (and the owner is told). */
export const RESOURCE_CEILING_HANDLES = 20_000;

/** Above 1.5 GiB of private memory, likewise. */
export const RESOURCE_CEILING_PRIVATE_BYTES = 1_610_612_736;

/** What is stored in `devices.resources` (JSONB) */
export interface DeviceResources {
  handleCount: number | null;
  privateBytes: number | null;
  gdiObjects: number | null;
  userObjects: number | null;
  /** Known-troublesome DLLs that are loaded in the agent right now */
  injectedModules: string[];
}

/** The heartbeat fields this module reads (already validated by the DTO) */
export interface ResourceFields {
  handleCount?: number;
  privateBytes?: number;
  gdiObjects?: number;
  userObjects?: number;
  injectedModules?: string[];
}

/**
 * The heartbeat's fields → the stored shape; `null` when the agent sent none of
 * them.
 *
 * Careful: `null` means "an agent older than the report", and the caller then
 * **keeps what it had**. Writing an empty report instead would wipe the last
 * real numbers of a PC that was just downgraded, exactly when they are needed.
 *
 * Careful: module names are lower-cased and de-duplicated. Windows file names
 * are case-insensitive, so `NvSpCap64.dll` and `nvspcap64.dll` are one DLL, and
 * showing it twice would read as two problems.
 */
export function toResources(fields: ResourceFields): DeviceResources | null {
  const { handleCount, privateBytes, gdiObjects, userObjects, injectedModules } = fields;

  if (
    handleCount === undefined &&
    privateBytes === undefined &&
    gdiObjects === undefined &&
    userObjects === undefined &&
    injectedModules === undefined
  ) {
    return null;
  }

  return {
    handleCount: handleCount ?? null,
    privateBytes: privateBytes ?? null,
    gdiObjects: gdiObjects ?? null,
    userObjects: userObjects ?? null,
    injectedModules: [...new Set((injectedModules ?? []).map((m) => m.toLowerCase()))].sort(),
  };
}

/**
 * Reads back what is in the column. Anything that does not look like a report
 * (a hand-edited row, a future shape) is `null`, not an exception: this runs on
 * every heartbeat, and a throw here would 500 the heartbeat and drop its
 * commands.
 */
export function readResources(raw: unknown): DeviceResources | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

  return {
    handleCount: num(r.handleCount),
    privateBytes: num(r.privateBytes),
    gdiObjects: num(r.gdiObjects),
    userObjects: num(r.userObjects),
    injectedModules: Array.isArray(r.injectedModules)
      ? r.injectedModules.filter((m): m is string => typeof m === 'string')
      : [],
  };
}

/**
 * Over the ceiling? Careful: an unknown number (`null`) is **not** over: the
 * benefit of the doubt goes to "fine", because a false alert about a PC that is
 * not leaking teaches the owner to ignore this one.
 */
export function isOverCeiling(r: DeviceResources | null): boolean {
  if (!r) return false;
  return (
    (r.handleCount ?? 0) > RESOURCE_CEILING_HANDLES ||
    (r.privateBytes ?? 0) > RESOURCE_CEILING_PRIVATE_BYTES
  );
}

/** One line for the alert: `24,310 handles · 1.9 GB private · nvspcap64.dll loaded` */
export function describeResources(r: DeviceResources): string {
  const parts: string[] = [];
  if (r.handleCount !== null) parts.push(`${r.handleCount.toLocaleString('en-US')} handles`);
  if (r.privateBytes !== null) {
    parts.push(`${(r.privateBytes / 1_000_000_000).toFixed(1)} GB private memory`);
  }
  if (r.injectedModules.length > 0) parts.push(`${r.injectedModules.join(', ')} loaded`);
  return parts.join(' · ');
}
