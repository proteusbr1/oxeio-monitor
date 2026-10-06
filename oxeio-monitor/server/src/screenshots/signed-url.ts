import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed URLs for screenshots (spec sections 4.2 and 7).
 *
 * Tokens are **not stored in the database**. The signature is the only proof,
 * so verifying needs no I/O: loading 60 gallery photos does not cause 60 DB
 * lookups. The cost is that a token **cannot be revoked**. That is why the
 * lifetime is only 5 minutes; time limits the risk of not being able to revoke.
 *
 * Careful: with a signed URL **the link is the key**. Anyone who gets the
 * link (sent over WhatsApp, screen share, browser history) can see the photo.
 * So "who viewed" is recorded **when the link is created**, not when the
 * image is fetched (see screenshots.service.ts).
 *
 * This file has no I/O, only pure functions, so expiry, tampering and
 * wrong-secret cases are all tested without a DB in test/signed-url.spec.ts.
 */

/** Spec section 4.2: "signed URL, expires in 5 minutes". */
export const SIGNED_URL_TTL_SEC = 5 * 60;

/**
 * First part of the token. If the payload layout changes later, the version
 * is bumped and tokens in the old layout are rejected as `malformed`.
 *
 * Careful: the version is also covered by the signature. Otherwise someone
 * could change only the prefix and feed an old payload to the new parser.
 */
export const TOKEN_VERSION = 'v1';

/**
 * Which variant may be viewed is also inside the signature.
 *
 * Careful: if the variant were a query parameter (`?token=...&variant=full`),
 * anyone holding a thumbnail link could change one word and download the
 * full-resolution image. Showing a thumbnail in the grid and opening the full
 * image are two separate permissions, hence two separate tokens.
 */
export type ScreenshotVariant = 'thumb' | 'full';

/** One character, to keep the token short; the link goes into `<img src>`. */
const VARIANT_CODE: Record<ScreenshotVariant, string> = {
  thumb: 't',
  full: 'f',
};
const CODE_TO_VARIANT: Record<string, ScreenshotVariant | undefined> = {
  t: 'thumb',
  f: 'full',
};

/**
 * Careful: the raw `JWT_SECRET` is not used directly. A separate key is
 * derived with its own label (domain separation). A screenshot token and a
 * session JWT can therefore never stand in for each other, even if someone
 * later picks the same algorithm by mistake.
 */
const KEY_LABEL = 'oxeio:screenshot-signed-url:v1';

export interface SignedClaims {
  screenshotId: bigint;
  variant: ScreenshotVariant;
  /** Who requested the link; kept in the token to cross-check with the audit log. */
  viewerUserId: number;
  /** Epoch seconds. */
  expiresAtSec: number;
}

export type VerifyFailure =
  /** Wrong shape: part count, version, or a number failed to parse. */
  | 'malformed'
  /** Signature mismatch: a tampered token, or one made with another secret. */
  | 'bad_signature'
  | 'expired';

export type VerifyResult =
  | { ok: true; claims: SignedClaims }
  | { ok: false; reason: VerifyFailure };

/**
 * This module's own HMAC key, derived from the secret.
 * Called once at server start (signed-url.service.ts).
 */
export function deriveSigningKey(rawSecret: string): Buffer {
  return createHmac('sha256', rawSecret).update(KEY_LABEL).digest();
}

export interface SignInput {
  screenshotId: bigint;
  variant: ScreenshotVariant;
  viewerUserId: number;
}

/**
 * `v1.f.42.1786500000.7.<sig>`; the signature covers the first five parts.
 *
 * Careful: the expiry (`exp`) is **inside** the signature. If it were outside,
 * anyone could raise the number to make the link permanent and the signature
 * would still match.
 */
export function signScreenshotToken(
  input: SignInput,
  key: Buffer,
  nowMs: number = Date.now(),
  ttlSec: number = SIGNED_URL_TTL_SEC,
): string {
  const expiresAtSec = Math.floor(nowMs / 1000) + ttlSec;

  const body = [
    TOKEN_VERSION,
    VARIANT_CODE[input.variant],
    input.screenshotId.toString(),
    String(expiresAtSec),
    String(input.viewerUserId),
  ].join('.');

  return `${body}.${hmac(body, key)}`;
}

/**
 * Verification order: **shape -> signature -> meaning -> expiry**.
 *
 * Careful: no token value is trusted before the signature matches. Checking
 * expiry first would not be wrong as such, but the habit is dangerous; later
 * someone might use an unverified value ("I am only reading the id").
 */
export function verifyScreenshotToken(
  token: string,
  key: Buffer,
  nowMs: number = Date.now(),
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 6) return { ok: false, reason: 'malformed' };

  const [version, variantCode, idPart, expPart, viewerPart, signature] = parts;
  if (version !== TOKEN_VERSION) return { ok: false, reason: 'malformed' };

  const body = parts.slice(0, 5).join('.');
  if (!safeEqual(signature, hmac(body, key))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // From here the values are ones we wrote, but still not trusted blindly:
  // after a future version change, old signed tokens can also reach this point.
  const variant = CODE_TO_VARIANT[variantCode];
  if (!variant) return { ok: false, reason: 'malformed' };

  if (!/^\d{1,19}$/.test(idPart)) return { ok: false, reason: 'malformed' };
  if (!/^\d{1,12}$/.test(expPart)) return { ok: false, reason: 'malformed' };
  if (!/^\d{1,12}$/.test(viewerPart)) return { ok: false, reason: 'malformed' };

  const expiresAtSec = Number(expPart);

  // Careful: the exact expiry instant also counts as expired (`<=`). One
  // second either way changes nothing, but an undefined boundary makes it
  // unclear which behaviour is right when writing tests.
  if (expiresAtSec * 1000 <= nowMs) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: {
      screenshotId: BigInt(idPart),
      variant,
      viewerUserId: Number(viewerPart),
      expiresAtSec,
    },
  };
}

function hmac(body: string, key: Buffer): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

/**
 * Careful: comparing signatures with `a === b` leaks how many characters
 * matched through the comparison time (timing attack). `timingSafeEqual`
 * throws when the lengths differ, so the length is checked first.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
