import { describe, expect, it } from 'vitest';

import {
  checkThumb,
  looksLikeWebp,
  MAX_THUMB_BYTES,
  THUMB_DIR,
  thumbPathFor,
} from '../src/screenshots/thumb';

/**
 * A06 — the pure arithmetic of thumbnails.
 *
 * Almost every test here is a test for a **silent mistake**. That is the
 * nature of the thumbnail feature: when it goes wrong, no exception is raised
 * and nobody sees a 500. Either files keep piling up on disk, or broken
 * pictures show in the grid, or the full image downloads instead of the 320px
 * one — and finding the cause of any of the three takes days.
 */

const FULL = 'screenshots/2026/08/10/emp-003/093147_m0.webp';

/** A valid RIFF container header — like the fixture in agent.e2e.spec.ts */
function webpBytes(extra = 0): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'ascii'),
    Buffer.alloc(extra),
  ]);
}

function candidate(over: Partial<{ mimetype: string; size: number; buffer: Buffer }> = {}) {
  const buffer = over.buffer ?? webpBytes(1000);
  return {
    mimetype: over.mimetype ?? 'image/webp',
    size: over.size ?? buffer.length,
    buffer,
  };
}

describe('thumbnail path', () => {
  /**
   * Where ingest writes and where retention looks are the same because it is
   * the same function. If they differed, rows would be deleted while the
   * small pictures stayed on disk, forever.
   */
  it('in a `thumb/` subfolder next to the full image, name unchanged', () => {
    expect(thumbPathFor(FULL)).toBe(
      'screenshots/2026/08/10/emp-003/thumb/093147_m0.webp',
    );
  });

  /**
   * This is the main reason for choosing a subfolder: counting `…/emp-003/*.webp`
   * still gives the number of screenshots for that day. Placing
   * `093147_m0-thumb.webp` beside it would make every count silently double.
   */
  it('the file name does not change — so the full-image count does not double', () => {
    const thumb = thumbPathFor(FULL);
    expect(thumb?.endsWith('/093147_m0.webp')).toBe(true);
    expect(thumb).toContain(`/${THUMB_DIR}/`);
  });

  it('also handles Windows backslash paths — old rows can have them', () => {
    expect(thumbPathFor('screenshots\\2026\\08\\10\\emp-003\\093147_m0.webp')).toBe(
      'screenshots/2026/08/10/emp-003/thumb/093147_m0.webp',
    );
  });

  /**
   * The most important test. If the path came from a name sent by the agent,
   * a hijacked device could write any file outside storage using `../../` —
   * and the file write would not fail, so no error would be raised either.
   */
  it.each([
    ['traversal', 'screenshots/../../etc/passwd.webp'],
    ['hidden traversal', 'screenshots/2026/../../../x.webp'],
    ['absolute', '/etc/shadow.webp'],
    ['drive letter', 'C:/Windows/System32/x.webp'],
    ['backslash drive', 'C:\\Windows\\x.webp'],
    ['double slash', 'screenshots//emp-003/x.webp'],
    ['single dot', 'screenshots/./x.webp'],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('thumbnail is not made for a %s path', (_label, path) => {
    expect(thumbPathFor(path)).toBeNull();
  });

  it('extensions other than webp are rejected (ADR-007)', () => {
    expect(thumbPathFor('screenshots/2026/08/10/emp-003/x.png')).toBeNull();
    expect(thumbPathFor('screenshots/2026/08/10/emp-003/x')).toBeNull();
  });

  it('a name without a folder is rejected — otherwise the thumbnail would land in the storage root', () => {
    expect(thumbPathFor('093147_m0.webp')).toBeNull();
  });

  /**
   * If someone in future mistakenly writes `thumbPathFor(row.thumbPath)`,
   * it would create `thumb/thumb/…` — and retention would never find it.
   */
  it('a thumbnail path cannot be wrapped again', () => {
    const once = thumbPathFor(FULL);
    expect(once).not.toBeNull();
    expect(thumbPathFor(once!)).toBeNull();
  });
});

describe('whether a thumbnail is acceptable', () => {
  it('a normal 320px webp is accepted', () => {
    expect(checkThumb(candidate(), 150_000)).toBeNull();
  });

  /**
   * The whole purpose of A06 is here. If a thumbnail is not smaller than the
   * full image, the grid would download the same bytes and use twice the disk
   * space — the feature would work backwards, entirely silently. This is
   * exactly what happens if the agent mistakenly appends the same buffer twice.
   */
  it('not accepted if equal to or larger than the full image', () => {
    const buf = webpBytes(50_000);
    expect(checkThumb(candidate({ buffer: buf }), buf.length)).toBe(
      'not_smaller_than_full',
    );
    expect(checkThumb(candidate({ buffer: buf }), 1000)).toBe(
      'not_smaller_than_full',
    );
  });

  /**
   * The Content-Type is written by the agent itself — i.e. under an attacker's
   * control. Without looking at the bytes, HTML or an EXE could be stored
   * with `image/webp`, and later be served with an `image/webp` header.
   */
  it('rejected if the header says webp but the bytes are not webp', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect(checkThumb(candidate({ buffer: html }), 150_000)).toBe('not_webp');
  });

  it('RIFF present but no WEBP (e.g. WAV) — rejected', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'ascii'),
    ]);
    expect(checkThumb(candidate({ buffer: wav }), 150_000)).toBe('not_webp');
  });

  it('wrong mime rejected', () => {
    expect(checkThumb(candidate({ mimetype: 'image/png' }), 150_000)).toBe(
      'bad_mime',
    );
  });

  it('empty body rejected', () => {
    expect(checkThumb(candidate({ buffer: Buffer.alloc(0), size: 0 }), 1000)).toBe(
      'empty',
    );
  });

  it('rejected if abnormally large — a 320px image is never this big', () => {
    const big = webpBytes(MAX_THUMB_BYTES + 1);
    expect(checkThumb(candidate({ buffer: big }), 10_000_000)).toBe('too_large');
  });

  /**
   * The order is tested too: bytes are checked **before** size. Otherwise a
   * huge non-webp file would be logged as `too_large`, and nobody would ever
   * learn that "the agent is sending the wrong format".
   */
  it('if large and non-webp, the format reason is the one given', () => {
    const big = Buffer.alloc(MAX_THUMB_BYTES + 1, 0x41);
    expect(checkThumb(candidate({ buffer: big }), 10_000_000)).toBe('not_webp');
  });

  it('nothing under 12 bytes is webp', () => {
    expect(looksLikeWebp(Buffer.from('RIFF'))).toBe(false);
    expect(looksLikeWebp(webpBytes())).toBe(true);
  });
});
