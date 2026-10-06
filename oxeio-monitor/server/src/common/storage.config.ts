import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';

/**
 * Where screenshots and other files accumulate: **a single definition**.
 *
 * Careful: this line used to be **copied in five places**: ingest, retention,
 * gallery, disk alert, update. The danger of copies is not theoretical:
 * <b>if the retention job computed a different folder than ingest, it would
 * delete database rows but leave the pictures on disk.</b> The disk would
 * fill up silently and the gallery would show broken images, and both are
 * hard to trace to their cause.
 *
 * The fallback path is deliberately inside the repo (`.data/storage`): it
 * works on a developer's machine without setting `STORAGE_ROOT`, and does not go into git.
 */
export function storageRoot(config: ConfigService): string {
  return (
    config.get<string>('STORAGE_ROOT') ??
    join(process.cwd(), '..', '.data', 'storage')
  );
}
