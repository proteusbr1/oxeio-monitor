import { isAbsolute, resolve } from 'node:path';

import { isInsideRoot } from '../summary/summary.math';

/**
 * The storage folder agents write into themselves (`screenshot-ingest.service.ts`
 * builds every path as `screenshots/YYYY/MM/DD/emp-NNN/...`).
 */
export const AGENT_UPLOAD_DIR = 'screenshots';

/**
 * **Where an update MSI may live: inside storage, and not where agents upload.**
 *
 * Both `update.service.ts` (download) and `agent-versions.service.ts`
 * (publish) resolve the stored `msi_path` through here, so the two can never
 * disagree about which file is meant.
 *
 * Careful: the prefix test is `isInsideRoot()` (root + separator), not a bare
 *    `startsWith(root)`. With the bare form a root of `/data/storage` also
 *    accepted `/data/storage-old/...` and `/data/storage2/...`.
 *
 * Careful: the screenshot area is refused because **any enrolled agent can put
 *    bytes there**. An update runs as administrator on every PC, so a file a
 *    staff PC uploaded must never be publishable as one, not even by a
 *    mistyped path. The documented place is `updates/` (deploy/README.md › 13.7),
 *    and that keeps working unchanged.
 *
 * @returns the absolute path, or `null` when the path is not allowed
 */
export function resolveMsiPath(root: string, msiPath: string): string | null {
  const absRoot = resolve(root);
  const abs = isAbsolute(msiPath) ? resolve(msiPath) : resolve(absRoot, msiPath);

  if (!isInsideRoot(absRoot, abs) || abs === absRoot) return null;
  if (isInAgentUploads(absRoot, abs)) return null;

  return abs;
}

/** Whether the resolved path sits in the folder agents upload into */
export function isInAgentUploads(root: string, abs: string): boolean {
  return isInsideRoot(resolve(root, AGENT_UPLOAD_DIR), abs);
}
