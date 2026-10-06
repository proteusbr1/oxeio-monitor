import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Secret, TOTP, URI } from 'otpauth';

import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD,
  TOTP_WINDOW,
} from './auth.constants';

/**
 * I06: the **pure** part of TOTP 2FA. There is no database and no Nest here,
 * and `Date.now()` can be injected, so all of it can be tested without a DB
 * (`test/totp.spec.ts`).
 *
 * The biggest decision: `users.totp_secret` is a single `String?` column, yet
 * we need to keep four things: the secret, "enabled or not", the recovery code
 * hashes, and the last used counter. The schema cannot be changed in this
 * phase, so all of it sits in that column as one JSON **envelope**. The
 * benefit: the four values live in one row and change atomically in one
 * `UPDATE`; with a separate table, a half-done state like "the code was
 * consumed but the counter was not set" would be possible.
 * (If separate columns come later, `decodeEnvelope` can stay unchanged and
 * only the read/write places need to change.)
 */
export interface TotpEnvelope {
  v: 1;
  /** base32: what goes into the authenticator app */
  secret: string;
  /**
   * Careful: having a `secret` is not the same as 2FA being **enabled**.
   * `POST /auth/2fa/setup` stores the secret but keeps `enabled: false`; if it
   * were enabled before proving it with a code, someone who forgot to scan
   * the QR would be locked out of their own account for good.
   */
  enabled: boolean;
  /** sha256 of the recovery codes; plaintext codes are never stored anywhere */
  recoveryHashes: string[];
  /**
   * Careful: the only way to stop replay. The same 6 digits stay valid for 30
   * seconds; a code seen over someone's shoulder cannot be used to sign in a second time.
   */
  lastCounter: number;
}

/** Not JSON, but not empty either: a secret in the old format placed by hand */
function legacyEnvelope(secret: string): TotpEnvelope {
  return {
    v: 1,
    secret,
    // Careful: fail-closed. If someone puts a secret into the column by hand,
    // treating it as "enabled" is the safe choice. The opposite would silently turn 2FA off.
    enabled: true,
    recoveryHashes: [],
    lastCounter: 0,
  };
}

/**
 * Careful: it parsed as JSON but the shape did not match. Returning `null`
 * here would mean "no 2FA", i.e. corrupt data would make the protection
 * vanish. So it throws: the login fails, but no gap is created.
 */
export class TotpEnvelopeError extends Error {}

export function decodeEnvelope(raw: string | null | undefined): TotpEnvelope | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!trimmed.startsWith('{')) return legacyEnvelope(trimmed);

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new TotpEnvelopeError('Malformed JSON in totp_secret');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new TotpEnvelopeError('totp_secret is not an object');
  }

  const o = parsed as Record<string, unknown>;
  const secret = o.secret;
  const enabled = o.enabled;
  const hashes = o.recoveryHashes;
  const lastCounter = o.lastCounter;

  if (
    typeof secret !== 'string' ||
    secret === '' ||
    typeof enabled !== 'boolean' ||
    !Array.isArray(hashes) ||
    !hashes.every((h): h is string => typeof h === 'string') ||
    typeof lastCounter !== 'number' ||
    !Number.isFinite(lastCounter)
  ) {
    throw new TotpEnvelopeError('totp_secret has an unexpected shape');
  }

  return { v: 1, secret, enabled, recoveryHashes: hashes, lastCounter };
}

export function encodeEnvelope(env: TotpEnvelope): string {
  return JSON.stringify(env);
}

/** A new secret: 20 bytes, as RFC 4226 recommends */
export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/**
 * The link the authenticator app reads from the QR.
 * The email goes in the label and the organization in the issuer; with two
 * accounts on one phone they can be told apart in the app.
 */
export function buildOtpauthUri(secret: string, email: string): string {
  return URI.stringify(
    new TOTP({
      issuer: TOTP_ISSUER,
      label: email,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
      secret: Secret.fromBase32(secret),
    }),
  );
}

export type TotpVerdict =
  | { ok: true; counter: number }
  | { ok: false; reason: 'malformed' | 'invalid' | 'replayed' };

/** Spaces, dashes, Unicode whitespace: all of these come along when copying from the app */
export function normalizeTotpCode(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Careful: three different "no" answers, each important for its own reason:
 *    `malformed` (not 6 digits), `invalid` (did not match), `replayed` (already used).
 *    The caller treats all three as failures, but they show up separately in logs/audit.
 *
 * Careful: window = +-1 step (+-30 seconds). A phone clock being a few
 *    seconds ahead or behind is very common; with 0, half of all logins would
 *    fail for no reason.
 */
export function verifyTotpCode(
  env: Pick<TotpEnvelope, 'secret' | 'lastCounter'>,
  code: string,
  now: number = Date.now(),
): TotpVerdict {
  const token = normalizeTotpCode(code);
  if (token.length !== TOTP_DIGITS) return { ok: false, reason: 'malformed' };

  let secret: Secret;
  try {
    secret = Secret.fromBase32(env.secret);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const delta = TOTP.validate({
    token,
    secret,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    window: TOTP_WINDOW,
    timestamp: now,
  });
  if (delta === null) return { ok: false, reason: 'invalid' };

  // delta = how many steps from the current counter the code matched
  const counter = TOTP.counter({ period: TOTP_PERIOD, timestamp: now }) + delta;

  // Careful: `<=`, so equal is rejected too. A code from the same step cannot be used twice.
  if (counter <= env.lastCounter) return { ok: false, reason: 'replayed' };

  return { ok: true, counter };
}

/**
 * Recovery codes. Losing or resetting the phone is not an imaginary risk:
 *    without these, an owner locked out of their own system would have no way
 *    back in (short of touching the database).
 *
 * Careful: `0 1 I O` are removed from the alphabet; those are exactly the
 *    four that get misread when reading a code written on paper. What is left
 *    is 8 digits + 24 letters = **exactly 32**, and that is what keeps the
 *    `% 32` below unbiased (256 / 32 divides evenly). If the length were not
 *    32, some characters would come up more often than others; the test
 *    (`test/totp.spec.ts`) guards this length.
 */
export const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** `ABCDE-FGHJK`: the middle dash is only for readability and does not go into the hash */
export function formatRecoveryCode(raw: string): string {
  const half = Math.ceil(raw.length / 2);
  return `${raw.slice(0, half)}-${raw.slice(half)}`;
}

export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
  length: number = RECOVERY_CODE_LENGTH,
): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(length);
    let raw = '';
    for (const b of bytes) raw += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    codes.push(formatRecoveryCode(raw));
  }
  return codes;
}

/** Dashes/spaces/lower case: smoothed out into a hashable form */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * sha256, not argon2 as for passwords, deliberately. We generate recovery
 *    codes ourselves: 10 characters x 5 bits = 50 bits of entropy. There is no
 *    "weak choice" here that could be brute-forced, so a slow hash is not
 *    needed, and 10 argon2 checks on the login path would add several seconds.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

export interface RecoveryVerdict {
  ok: boolean;
  /** The new list with the consumed code removed */
  remaining: string[];
}

/**
 * Careful: a code works **only once**, so removing it from the list when it
 *    matches is essential. If the caller does not store `remaining`, the same
 *    paper code would work again and again.
 */
export function consumeRecoveryCode(
  hashes: readonly string[],
  code: string,
): RecoveryVerdict {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length === 0) return { ok: false, remaining: [...hashes] };

  const target = Buffer.from(hashRecoveryCode(normalized), 'hex');
  let matched = -1;

  for (let i = 0; i < hashes.length; i += 1) {
    // Careful: on malformed hex `Buffer.from` does not throw, it returns a shorter buffer, and
    //    `timingSafeEqual` **throws** on a length mismatch. So check the length first.
    const stored = Buffer.from(hashes[i], 'hex');
    if (stored.length !== target.length) continue;
    if (timingSafeEqual(stored, target)) {
      matched = i;
      // Careful: no `break`. A code early in the list matches quickly and one
      //    late in the list matches slowly; that timing difference could leak "which code number".
    }
  }

  if (matched < 0) return { ok: false, remaining: [...hashes] };

  return {
    ok: true,
    remaining: hashes.filter((_, i) => i !== matched),
  };
}

// ══════════════════ Both paths together ══════════════════

export interface SecondFactorAttempt {
  /** The 6 digits from the authenticator app */
  totp?: string;
  /** The single-use code written on paper */
  recoveryCode?: string;
}

export type SecondFactorVerdict =
  | {
      ok: true;
      /** Careful: the **new** envelope with the consumed code/counter set; store this one */
      env: TotpEnvelope;
      usedRecoveryCode: boolean;
    }
  | { ok: false; reason: 'missing' | 'malformed' | 'invalid' | 'replayed' };

/**
 * The second step of login: both paths in one place.
 *
 * The returned `env` is the point: with TOTP `lastCounter` advances, with
 *    recovery the code is dropped from the list. If the caller does not store
 *    it, both replay protection and "single use" would exist only on paper.
 *
 * Careful: `missing` is returned separately because it is **not a failure**:
 *    not giving a code means the user has only just passed the first step.
 *    If it were treated as a failure, every normal login would bump the
 *    throttle's counter.
 */
export function verifySecondFactor(
  env: TotpEnvelope,
  attempt: SecondFactorAttempt,
  now: number = Date.now(),
): SecondFactorVerdict {
  const totp = (attempt.totp ?? '').trim();
  const recovery = (attempt.recoveryCode ?? '').trim();

  if (totp === '' && recovery === '') return { ok: false, reason: 'missing' };

  if (totp !== '') {
    const verdict = verifyTotpCode(env, totp, now);
    if (verdict.ok) {
      return {
        ok: true,
        usedRecoveryCode: false,
        env: { ...env, lastCounter: verdict.counter },
      };
    }
    // Careful: with no recovery code we stop here, and the real reason is
    //    returned (the `replayed` message can tell the user "wait for the next
    //     code", which is far more useful than `invalid`).
    if (recovery === '') return { ok: false, reason: verdict.reason };
  }

  const used = consumeRecoveryCode(env.recoveryHashes, recovery);
  if (used.ok) {
    return {
      ok: true,
      usedRecoveryCode: true,
      env: { ...env, recoveryHashes: used.remaining },
    };
  }

  return { ok: false, reason: 'invalid' };
}
