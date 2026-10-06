import { createReadStream } from 'node:fs';
import { mkdir, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { isInsideRoot } from '../summary/summary.math';
import { isSafeRelPath, type ScreenshotStorage } from './screenshot-storage';

/**
 * STORAGE_DRIVER=local (default) — files under STORAGE_ROOT, exactly as
 * before. The code is the one that lived in screenshot-ingest.service,
 * screenshots.service and retention.job, moved here unchanged in behaviour.
 */
export class LocalScreenshotStorage implements ScreenshotStorage {
  readonly driver = 'local' as const;
  readonly location: string;

  constructor(private readonly root: string) {
    this.root = resolve(root);
    this.location = this.root;
  }

  async probe(): Promise<void> {
    const probe = join(this.root, '.write-probe');
    try {
      await mkdir(this.root, { recursive: true });
      await writeFile(probe, 'ok');
      await rm(probe, { force: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Screenshot storage is not writable: ${this.root} (${reason}). ` +
          'Screenshots would be silently lost. On Docker this is almost always ' +
          'the bind-mounted folder being owned by root while the container runs ' +
          'as uid 1000 — fix with: chown -R 1000:1000 .data/storage',
      );
    }
  }

  async reachable(): Promise<boolean> {
    try {
      return (await stat(this.root)).isDirectory();
    } catch {
      return false;
    }
  }

  // a file has no content type; the gallery always serves image/webp
  async put(
    relPath: string,
    body: Buffer,
    _contentType?: string,
  ): Promise<void> {
    const abs = this.absolute(relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }

  async size(relPath: string): Promise<number | null> {
    try {
      const info = await stat(this.absolute(relPath));
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  }

  async open(relPath: string): Promise<{
    stream: ReturnType<typeof createReadStream>;
    sizeBytes: number;
  } | null> {
    const sizeBytes = await this.size(relPath);
    if (sizeBytes === null) return null;
    return { stream: createReadStream(this.absolute(relPath)), sizeBytes };
  }

  async remove(relPath: string): Promise<'deleted' | 'missing'> {
    try {
      await unlink(this.absolute(relPath));
      return 'deleted';
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  /**
   * Removes date folders that have become empty.
   *
   * Paths look like `.../YYYY/MM/DD/emp-003/`, so there are ~365 x headcount
   * folders per year. Deleting files but keeping folders would pile up
   * thousands of empty directories within a few years, and the backup
   * robocopy would walk them every night.
   *
   * The `.../emp-003/thumb/` folders are handled too, and not by accident:
   * above, the `dirname` of **every** path (full image and thumbnail alike)
   * is added to `touchedDirs`, and below the deepest folders are visited
   * first. So `thumb/` empties first, and only then can `emp-003` empty. In
   * the opposite order `emp-003` would be stuck on ENOTEMPTY forever and the
   * whole date tree would remain.
   *
   * Careful: `rmdir` (not recursive) fails by itself if a folder has content.
   * Something like `rm -rf` here would take a whole tree on one path mistake.
   */
  //  (moved here from retention.job.ts with the code it describes)
  async afterRemove(relPaths: readonly string[]): Promise<void> {
    const dirs = new Set(relPaths.map((p) => dirname(this.absolute(p))));
    // deepest first — emp-003 must go before DD can be empty
    const ordered = [...dirs].sort((a, b) => b.length - a.length);

    for (const dir of ordered) {
      let current = dir;
      while (current !== this.root && isInsideRoot(this.root, current)) {
        try {
          await rmdir(current);
        } catch {
          // ENOTEMPTY or ENOENT — both normal, stop climbing
          break;
        }
        current = dirname(current);
      }
    }
  }

  /** ⚠️ Every path is checked: a row pointing outside the root is refused */
  private absolute(relPath: string): string {
    if (!isSafeRelPath(relPath) || !isInsideRoot(this.root, relPath)) {
      throw new Error(`path is outside screenshot storage: ${relPath}`);
    }
    return resolve(this.root, relPath);
  }
}
