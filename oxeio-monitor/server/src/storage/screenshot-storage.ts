import type { Readable } from 'node:stream';

/**
 * Where screenshot and thumbnail bytes live — the local disk (default) or an
 * S3-compatible bucket (Backblaze B2, MinIO, AWS …), chosen by
 * `STORAGE_DRIVER`.
 *
 * Every caller speaks in the same relative paths the database stores
 * (`screenshots/2026/08/10/emp-003/093147_m0.webp`); only the driver knows
 * whether that is a file under STORAGE_ROOT or a key in a bucket. The rows,
 * the paths and the signed links stay exactly as they were.
 *
 * ⚠️ Only screenshots and thumbnails go through here. Agent installers and
 *    backups stay on disk: they are few, and the update path checks them by
 *    hash and serves them by file.
 */
export interface ScreenshotStorage {
  readonly driver: 'local' | 's3';

  /** For logs and the health page — a folder or `s3://bucket/prefix` */
  readonly location: string;

  /**
   * Write, read back and delete a probe. Throws with a clear message when
   * storage is not usable: screenshots would otherwise be lost silently.
   */
  probe(): Promise<void>;

  /** Is the store reachable right now — for the health page, never throws */
  reachable(): Promise<boolean>;

  put(relPath: string, body: Buffer, contentType: string): Promise<void>;

  /** Size in bytes, or `null` when there is nothing at that path */
  size(relPath: string): Promise<number | null>;

  /** The bytes as a stream, or `null` when there is nothing at that path */
  open(
    relPath: string,
  ): Promise<{ stream: Readable; sizeBytes: number } | null>;

  /**
   * `'missing'` when there was nothing to delete — not an error, retention
   * counts it separately. Any other failure throws.
   */
  remove(relPath: string): Promise<'deleted' | 'missing'>;

  /** After a batch of removals — the local driver prunes empty folders */
  afterRemove(relPaths: readonly string[]): Promise<void>;
}

/** Nest injection token */
export const SCREENSHOT_STORAGE = Symbol('SCREENSHOT_STORAGE');

/**
 * A path the database may hold: relative, `/`-separated, no empty, `.` or
 * `..` segment, no drive letter. The same rule `thumbPathFor` applies, so a
 * row that points outside the store is refused by both drivers alike.
 */
export function isSafeRelPath(relPath: string): boolean {
  const rel = relPath.replace(/\\/g, '/').trim();
  if (rel.length === 0) return false;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false;
  return !rel.split('/').some((p) => p === '' || p === '.' || p === '..');
}
