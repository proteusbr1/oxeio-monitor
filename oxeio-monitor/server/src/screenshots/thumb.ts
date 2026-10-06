/**
 * 320px thumbnails: **pure path and acceptance logic**.
 *
 * No I/O and no Nest here, so everything is tested without a DB in
 * test/thumb.spec.ts. Ingest (writes), retention (deletes) and the gallery
 * (serves) all use this one definition.
 *
 * Careful: the lesson from `storage.config.ts` applies here too. If the path
 * logic were duplicated, ingest would write to one folder and retention would
 * look in another, and thumbnails would pile up on disk forever, silently.
 */

/**
 * Thumbnails go in a **separate `thumb/` subfolder**, not beside the original
 * as `*-thumb.webp`. Three reasons, all real:
 *
 *   1. Counting `.../emp-003/*.webp` still gives "screenshots on that day".
 *      Side by side, every count would show **double**, with no error, just a
 *      wrong number.
 *   2. Backup needs one line, `/XD thumb`, which is much safer than excluding
 *      a name pattern. Losing thumbnails costs nothing (the gallery falls back
 *      to the full image), so the nightly robocopy should skip them.
 *   3. Retention's `pruneEmptyDirs` already walks up from each path's
 *      `dirname`, so a subfolder is handled automatically.
 */
export const THUMB_DIR = 'thumb';

/** Spec A06: 320px wide is enough for the grid (card ~280px, 2x on retina). */
export const THUMB_WIDTH = 320;

/**
 * A 320px WebP is really 8-25 KB, so the 256 KB cap is generous. It is not
 * for measuring the "right size" but for stopping the **wrong thing**: if the
 * agent mistakenly sends the full image twice, it must not take double space.
 */
export const MAX_THUMB_BYTES = 256 * 1024;

/** ADR-007: the agent sends only webp, thumbnails included. */
export const THUMB_MIME = 'image/webp';

/**
 * Relative path of the thumbnail, from the full image's relative path.
 *
 * `screenshots/2026/08/10/emp-003/093147_m0.webp`
 *   -> `screenshots/2026/08/10/emp-003/thumb/093147_m0.webp`
 *
 * The path is **always computed on the server**, never from a name sent by
 * the agent. The agent sends only bytes. If it could supply a name, a
 * compromised device could write any file outside storage with `../../../../`.
 *
 * @returns `null` means the path is not trustworthy, so no thumbnail is made
 *          (`thumb_path` stays null and the gallery falls back to the full image).
 */
export function thumbPathFor(fullRelPath: string): string | null {
  // Ingest writes `/`, but old rows may contain Windows `\`.
  const rel = fullRelPath.replace(/\\/g, '/').trim();
  if (rel.length === 0) return null;

  // Careful: both absolute paths and drive letters are rejected.
  // `resolve(root, '/etc/x')` ignores the root completely, and silently.
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;

  const parts = rel.split('/');
  // An empty part (`a//b`), `.` or `..` never appears in a valid storage path.
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;

  // At least one folder is required, otherwise the thumbnail would land in the storage root.
  if (parts.length < 2) return null;

  const name = parts[parts.length - 1];
  if (!name.toLowerCase().endsWith('.webp')) return null;

  // Careful: already a thumbnail path; wrapping again would give `thumb/thumb/...`.
  // If someone later writes `thumbPathFor(row.thumbPath)` by mistake, it stops here.
  if (parts[parts.length - 2] === THUMB_DIR) return null;

  parts.splice(parts.length - 1, 0, THUMB_DIR);
  return parts.join('/');
}

/** Why the thumbnail was not accepted; this word goes into the log. */
export type ThumbRejection =
  | 'empty'
  | 'bad_mime'
  | 'not_webp'
  | 'too_large'
  | 'not_smaller_than_full';

export interface ThumbCandidate {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Whether the thumbnail the agent sent is fit to keep.
 *
 * Careful: saying "no" here does **not** fail the upload. The photo is the
 * valuable part and the thumbnail is only a convenience (see ingest). So this
 * function never throws; it only returns the reason.
 *
 * @returns `null` means OK
 */
export function checkThumb(
  thumb: ThumbCandidate,
  fullSizeBytes: number,
): ThumbRejection | null {
  if (thumb.size <= 0 || thumb.buffer.length === 0) return 'empty';
  if (thumb.mimetype !== THUMB_MIME) return 'bad_mime';

  // Careful: the Content-Type is written by the agent, so an attacker controls
  // it. Without looking at the real bytes, anything (HTML, EXE) could be stored
  // as `image/webp` and later served with an `image/webp` header.
  if (!looksLikeWebp(thumb.buffer)) return 'not_webp';

  if (thumb.size > MAX_THUMB_BYTES) return 'too_large';

  /**
   * A thumbnail not smaller than the full image makes **the whole feature
   * work backwards**: the grid would download the same bytes and disk usage
   * would double. That is exactly what happens if the agent attaches the same
   * buffer twice, and no error would be raised anywhere.
   */
  if (fullSizeBytes > 0 && thumb.size >= fullSizeBytes) {
    return 'not_smaller_than_full';
  }

  return null;
}

/**
 * Head of a RIFF container: `R I F F <4 bytes size> W E B P`.
 * The full image is not decoded; Node cannot do that and it is not needed.
 * This much is enough to catch a "wrong format".
 */
export function looksLikeWebp(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  return (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  );
}
