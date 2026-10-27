import { isAbsolute, resolve } from 'node:path';

import { isInsideRoot } from '../summary/summary.math';

/**
 * **Where an update MSI may live: inside storage.**
 *
 * Both `update.service.ts` (download) and `agent-versions.service.ts`
 * (publish) resolve the stored `msi_path` through here, so the two can never
 * disagree about which file is meant.
 *
 * Careful: the prefix test is `isInsideRoot()` (root + separator), not a bare
 *    `startsWith(root)`. With the bare form a root of `/data/storage` also
 *    accepted `/data/storage-old/...` and `/data/storage2/...`.
 *
 * @returns the absolute path, or `null` when the path is not allowed
 */
export function resolveMsiPath(root: string, msiPath: string): string | null {
  const absRoot = resolve(root);
  const abs = isAbsolute(msiPath) ? resolve(msiPath) : resolve(absRoot, msiPath);

  if (!isInsideRoot(absRoot, abs) || abs === absRoot) return null;

  return abs;
}
