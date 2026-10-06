import { describe, expect, it } from 'vitest';

import {
  deriveSigningKey,
  signScreenshotToken,
  SIGNED_URL_TTL_SEC,
  verifyScreenshotToken,
} from '../src/screenshots/signed-url';

/**
 * I07: signed URLs.
 *
 * Almost everything tested here is about silent mistakes: if expiry is not
 * checked, or a field is left outside the signature, no error is raised
 * anywhere; a link just stays open forever, or one employee's link gives out
 * another's screenshot.
 */

const SECRET = 'test-only-secret-at-least-32-characters-long';
const KEY = deriveSigningKey(SECRET);

/** 2026-08-10 12:00:00 UTC: a fixed time, otherwise the test would depend on the clock */
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);

function make(
  over: Partial<{
    screenshotId: bigint;
    variant: 'thumb' | 'full';
    viewerUserId: number;
  }> = {},
  nowMs = NOW,
): string {
  return signScreenshotToken(
    {
      screenshotId: over.screenshotId ?? 42n,
      variant: over.variant ?? 'full',
      viewerUserId: over.viewerUserId ?? 7,
    },
    KEY,
    nowMs,
  );
}

describe('signed URL: signing and verifying', () => {
  it('accepts its own token, and the claims come back unchanged', () => {
    const token = make({ screenshotId: 9007199254740993n, viewerUserId: 3 });
    const result = verifyScreenshotToken(token, KEY, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The id is deliberately larger than Number.MAX_SAFE_INTEGER. If it is
    // ever turned into a Number(), it is caught here; otherwise in a couple
    // of years, when screenshots.id gets big, the wrong image would be served.
    expect(result.claims.screenshotId).toBe(9007199254740993n);
    expect(result.claims.viewerUserId).toBe(3);
    expect(result.claims.variant).toBe('full');
  });

  it('who asked is in the token itself, to match against the audit', () => {
    const token = make({ viewerUserId: 11 });
    const result = verifyScreenshotToken(token, KEY, NOW);

    expect(result.ok && result.claims.viewerUserId).toBe(11);
  });
});

/**
 * A06: since the 320px thumbnail arrived, `variant` is no longer just a
 * label: there are now two different files, one about 15 KB and one about
 * 150 KB. So a wrong variant here means either ten times the bytes, or an
 * unauthorised full-resolution image.
 */
describe('signed URL: variant (A06)', () => {
  it('a thumb token comes back as thumb', () => {
    const result = verifyScreenshotToken(make({ variant: 'thumb' }), KEY, NOW);
    expect(result.ok && result.claims.variant).toBe('thumb');
  });

  /**
   * The same image, the same viewer, the same moment, yet the two tokens are
   * different. If they became equal it would mean variant had moved outside
   * the signature, and then the full image could be downloaded via the gallery's thumbUrl.
   */
  it('the thumb and full tokens of the same image are never equal', () => {
    const thumb = make({ variant: 'thumb' });
    const full = make({ variant: 'full' });

    expect(thumb).not.toBe(full);

    const t = thumb.split('.');
    const f = full.split('.');

    // id, expiry, viewer: all three are exactly the same
    expect(t.slice(2, 5)).toEqual(f.slice(2, 5));
    // the only difference is variant and signature: so the signature covers variant
    expect(t[1]).not.toBe(f[1]);
    expect(t[5]).not.toBe(f[5]);
  });

  /**
   * The simplest attack: the gallery sends both links for every image
   * (thumbUrl, fullUrl). If someone cuts the full signature and puts it on the
   * thumb body, or the reverse, both must break. They break because the
   * signature covers the whole body.
   */
  it('one variant\'s signature does not fit on the other variant\'s body', () => {
    const thumb = make({ variant: 'thumb' }).split('.');
    const full = make({ variant: 'full' }).split('.');

    const stolen = [...thumb.slice(0, 5), full[5]].join('.');
    expect(verifyScreenshotToken(stolen, KEY, NOW).ok).toBe(false);

    const reverse = [...full.slice(0, 5), thumb[5]].join('.');
    expect(verifyScreenshotToken(reverse, KEY, NOW).ok).toBe(false);
  });

  /**
   * The variant is inside the token, not in a separate `?variant=thumb` query
   * parameter. With a parameter the signature could not cover it, and changing
   * one word would turn thumb into full. This test pins that design: the
   * token's second part is the only place the variant lives.
   */
  it('the variant lives in a fixed part of the token, not outside it', () => {
    expect(make({ variant: 'thumb' }).split('.')[1]).toBe('t');
    expect(make({ variant: 'full' }).split('.')[1]).toBe('f');
  });

  it('an unknown variant code never passes', () => {
    for (const code of ['x', 'T', 'F', 'thumb', '']) {
      const parts = make({ variant: 'full' }).split('.');
      parts[1] = code;
      expect(verifyScreenshotToken(parts.join('.'), KEY, NOW).ok).toBe(false);
    }
  });
});

describe('signed URL: expiry', () => {
  it('still works one second before 5 minutes', () => {
    const token = make();
    const result = verifyScreenshotToken(
      token,
      KEY,
      NOW + (SIGNED_URL_TTL_SEC - 1) * 1000,
    );
    expect(result.ok).toBe(true);
  });

  /**
   * This test is the heart of I07. If expiry were not checked there would be
   * no error: the link would just work forever, and nobody would ever notice.
   */
  it('expires exactly at the 5 minute mark', () => {
    const token = make();
    const result = verifyScreenshotToken(
      token,
      KEY,
      NOW + SIGNED_URL_TTL_SEC * 1000,
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('expired');
  });

  it('certainly not valid after 6 minutes', () => {
    const token = make();
    const result = verifyScreenshotToken(token, KEY, NOW + 6 * 60 * 1000);
    expect(!result.ok && result.reason).toBe('expired');
  });

  /**
   * Whether expiry is inside the signature: this is the real test of that. If
   * outside, changing exp would still match the signature and the link would become immortal.
   */
  it('extending the expiry breaks the signature', () => {
    const parts = make().split('.');
    parts[3] = String(Number(parts[3]) + 86_400); // extend by one day

    const result = verifyScreenshotToken(parts.join('.'), KEY, NOW);
    expect(!result.ok && result.reason).toBe('bad_signature');
  });
});

describe('signed URL: tampered tokens', () => {
  /**
   * The scariest attack: take a valid link for your own image and just change
   * the id. It fails because the signature covers the id too.
   */
  it('changing the screenshot id is caught', () => {
    const parts = make({ screenshotId: 42n }).split('.');
    parts[2] = '43';

    const result = verifyScreenshotToken(parts.join('.'), KEY, NOW);
    expect(!result.ok && result.reason).toBe('bad_signature');
  });

  /**
   * Whether a full image can be pulled through a thumbnail link. If variant
   * were not inside the signature, changing one character would do it.
   */
  it('changing thumb to full is caught', () => {
    const parts = make({ variant: 'thumb' }).split('.');
    expect(parts[1]).toBe('t');
    parts[1] = 'f';

    const result = verifyScreenshotToken(parts.join('.'), KEY, NOW);
    expect(!result.ok && result.reason).toBe('bad_signature');
  });

  it('a link cannot be made in someone else\'s name', () => {
    const parts = make({ viewerUserId: 7 }).split('.');
    parts[4] = '1'; // posing as the owner

    const result = verifyScreenshotToken(parts.join('.'), KEY, NOW);
    expect(!result.ok && result.reason).toBe('bad_signature');
  });

  it('changing one character of the signature rejects it', () => {
    const parts = make().split('.');
    const sig = parts[5];
    parts[5] = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);

    const result = verifyScreenshotToken(parts.join('.'), KEY, NOW);
    expect(!result.ok && result.reason).toBe('bad_signature');
  });
});

describe('signed URL: wrong secret', () => {
  it('a token made with another secret is not accepted', () => {
    const otherKey = deriveSigningKey(
      'another-secret-that-is-also-at-least-32-chars',
    );
    const token = signScreenshotToken(
      { screenshotId: 42n, variant: 'full', viewerUserId: 7 },
      otherKey,
      NOW,
    );

    const result = verifyScreenshotToken(token, KEY, NOW);
    expect(!result.ok && result.reason).toBe('bad_signature');
  });

  /**
   * Domain separation. Even with the same raw secret the key should differ;
   * otherwise if another module later did HMAC with the same secret, its
   * tokens would work here too.
   */
  it('a key derived from the raw secret is not equal to the raw secret', () => {
    const derived = deriveSigningKey(SECRET);
    expect(derived.equals(Buffer.from(SECRET, 'utf8'))).toBe(false);
    // the same input gives the same key: otherwise a server restart would break all links
    expect(derived.equals(deriveSigningKey(SECRET))).toBe(true);
  });
});

describe('signed URL: malformed shape', () => {
  it.each([
    ['empty', ''],
    ['too few parts', 'v1.f.42.999'],
    ['too many parts', `${make()}.extra`],
    ['no dots', 'garbage'],
    ['unknown version', make().replace(/^v1\./, 'v2.')],
    ['unknown variant', make().replace(/^v1\.f\./, 'v1.x.')],
  ])('%s → malformed', (_label, token) => {
    const result = verifyScreenshotToken(token, KEY, NOW);
    expect(result.ok).toBe(false);
  });

  /**
   * For an unknown variant the signature breaks first (`bad_signature`),
   * because variant is inside the signature too. Neither is a gap: both say "no".
   */
  it('expired and tampered: both give ok=false', () => {
    expect(verifyScreenshotToken('v1.f.1.1.1.abc', KEY, NOW).ok).toBe(false);
  });
});
