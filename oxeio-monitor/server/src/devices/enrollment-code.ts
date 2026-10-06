import { createHash } from 'node:crypto';

/**
 * One-time codes for agent registration.
 *
 * The pure part is kept separate: building the code, hashing it, and working
 * out its expiry. The random bytes come from outside, so the functions are
 * deterministic — in a test, given specific bytes, the same code comes out.
 */

/** 24 hours (spec § 4.2 · H05) */
export const ENROLLMENT_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Exactly **32** characters — the most important decision in this file.
 *
 * 256 ÷ 32 = 8 (divides exactly), so `byte % 32` has **no modulo bias** —
 * every character comes up with equal probability. An alphabet of 31 or 33
 * characters would make some characters more frequent than others, and
 * guessing slightly easier. So the number is a matter of security, not looks.
 *
 * Careful: look-alike pairs are removed — someone will write this code on
 * paper and type it on another PC. **Four** are dropped: both `0` and `O`,
 * and both `I` and `L` (`1` is kept). Dropping both members of a pair leaves
 * no way to mistype in either direction.
 *
 * Careful: neither `O` nor `0` may be "brought back". Dropping exactly 4 of
 * the 36 alphanumerics gives 32; bringing one back makes 33, and
 * 256 % 33 = 25 — the whole modulo-bias argument above collapses, yet the
 * code keeps working so nobody notices.
 */
export const CODE_ALPHABET = '123456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** 12 characters × 5 bits = 60 bits of entropy — enough for a one-time, 24-hour code */
export const CODE_LENGTH = 12;

/**
 * Careful: the code has no hyphens or spaces — deliberately.
 *
 * `src/agent/enrollment.service.ts` hashes the code exactly as given (only
 * `.trim()`), and on failure the message is deliberately vague ("wrong or
 * expired"). So a typing error like `AB12-CD34` versus `AB12CD34` would be
 * nearly impossible to debug. The fewer ways there are to mistype, the better.
 */
export function formatEnrollmentCode(bytes: Uint8Array): string {
  if (bytes.length < CODE_LENGTH) {
    throw new RangeError(
      `Building an enrolment code needs at least ${CODE_LENGTH} bytes, got ${bytes.length}`,
    );
  }

  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Careful: this function must match the calculation in
 * `src/agent/enrollment.service.ts` **character for character** — there it is
 * the hex of `sha256(code.trim())`.
 *
 * With a slight mismatch on the two sides (`.toUpperCase()` on one, not the
 * other), every enrollment would silently fail, and the agent would only say
 * "code wrong or expired" — one message for three different causes (H05 · G18).
 * People would hunt for the real cause for days.
 */
export function hashEnrollmentCode(code: string): string {
  // Careful: without `toUpperCase()` the code was **case-sensitive**.
  // CODE_ALPHABET is all upper case, so for generated codes this is a no-op —
  // the hashes of earlier codes stay intact. But when someone typed lower case
  // it used to say "wrong or expired code", and with one message for three
  // different causes, finding the real problem took days (H05 · G18).
  // Careful: **the same function** must be used on both sides — changing one
  // side would break every enrollment. That is why enrollment.service.ts imports this.
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/** 24 hours from now */
export function enrollmentCodeExpiry(now: Date): Date {
  return new Date(now.getTime() + ENROLLMENT_CODE_TTL_MS);
}
