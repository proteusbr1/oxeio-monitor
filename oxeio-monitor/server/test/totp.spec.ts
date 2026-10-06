import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';

import {
  IDLE_WARN_BEFORE_SEC,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  SESSION_TTL_MIN,
  TOTP_PERIOD,
} from '../src/auth/auth.constants';
import { idleStateAt, shouldPingSession } from '../src/auth/idle-timeout';
import {
  buildOtpauthUri,
  consumeRecoveryCode,
  decodeEnvelope,
  encodeEnvelope,
  formatRecoveryCode,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  normalizeTotpCode,
  RECOVERY_ALPHABET,
  TotpEnvelopeError,
  verifySecondFactor,
  verifyTotpCode,
  type TotpEnvelope,
} from '../src/auth/totp';

/**
 * Tests for the pure parts of I06/I09 — no database, Nest or HTTP needed.
 * Time is always passed in, so results are fixed.
 *
 * `resetDatabase()` is not here and is not needed — this file touches no
 *    other test's fixtures, so it is safe even when run in parallel.
 */

/** The tests must generate codes themselves — with the same algorithm the app uses */
function codeAt(secret: string, timestamp: number): string {
  return TOTP.generate({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD,
    timestamp,
  });
}

function envelope(over: Partial<TotpEnvelope> = {}): TotpEnvelope {
  return {
    v: 1,
    secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    enabled: true,
    recoveryHashes: [],
    lastCounter: 0,
    ...over,
  };
}

// ══════════════════ envelope ══════════════════

describe('totp envelope — four things in one column', () => {
  it('encode → decode returns every value intact', () => {
    const env = envelope({ recoveryHashes: ['aa', 'bb'], lastCounter: 42 });
    expect(decodeEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  it('empty/null means no 2FA', () => {
    expect(decodeEnvelope(null)).toBeNull();
    expect(decodeEnvelope(undefined)).toBeNull();
    expect(decodeEnvelope('   ')).toBeNull();
  });

  /**
   * This is the most important test: an old secret set by hand must count as
   *    "enabled". If treated as "off", 2FA would silently vanish and nobody would notice.
   */
  it('a non-JSON string = a secret in the old format, and it is enabled', () => {
    const env = decodeEnvelope('JBSWY3DPEHPK3PXP');
    expect(env?.enabled).toBe(true);
    expect(env?.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(env?.recoveryHashes).toEqual([]);
  });

  /**
   * Returning `null` for malformed JSON would mean "no 2FA" — i.e. if the data
   *    is corrupted, security vanishes too. So it throws: login fails, no gap is created.
   */
  it('malformed JSON or wrong shape throws — 2FA is not silently turned off', () => {
    expect(() => decodeEnvelope('{oops')).toThrow(TotpEnvelopeError);
    expect(() => decodeEnvelope('{"secret":"AB"}')).toThrow(TotpEnvelopeError);
    expect(() => decodeEnvelope('{"secret":"","enabled":true,"recoveryHashes":[],"lastCounter":0}')).toThrow(
      TotpEnvelopeError,
    );
    expect(() =>
      decodeEnvelope('{"secret":"AB","enabled":"yes","recoveryHashes":[],"lastCounter":0}'),
    ).toThrow(TotpEnvelopeError);
    expect(() =>
      decodeEnvelope('{"secret":"AB","enabled":true,"recoveryHashes":[7],"lastCounter":0}'),
    ).toThrow(TotpEnvelopeError);
  });
});

// ══════════════════ secret and QR link ══════════════════

describe('secret and otpauth link', () => {
  it('the secret is base32, 20 bytes = 32 characters', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateSecret()).not.toBe(s);
  });

  it('the otpauth link has both the issuer and the email', () => {
    const uri = buildOtpauthUri(generateSecret(), 'owner@oxeio.local');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=oXeio%20Monitor');
    expect(uri).toContain('owner%40oxeio.local');
    expect(uri).toContain('period=30');
    expect(uri).toContain('digits=6');
  });
});

// ══════════════════ TOTP verification ══════════════════

describe('TOTP verification', () => {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const now = 1_760_000_000_000; // fixed time, so the result is fixed too

  it('the current code matches and returns the counter', () => {
    const v = verifyTotpCode(envelope({ secret }), codeAt(secret, now), now);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.counter).toBe(Math.floor(now / 1000 / TOTP_PERIOD));
  });

  it('a code copied with spaces/dashes works too', () => {
    const code = codeAt(secret, now);
    const messy = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotpCode(envelope({ secret }), messy, now).ok).toBe(true);
    expect(normalizeTotpCode(' 12-34 56 ')).toBe('123456');
  });

  it('malformed if not 6 digits', () => {
    const v = verifyTotpCode(envelope({ secret }), '1234', now);
    expect(v).toEqual({ ok: false, reason: 'malformed' });
  });

  it('malformed on a broken secret — does not throw', () => {
    const v = verifyTotpCode(envelope({ secret: '!!!!' }), '123456', now);
    expect(v).toEqual({ ok: false, reason: 'malformed' });
  });

  it('invalid on a wrong code', () => {
    const wrong = codeAt(secret, now) === '000000' ? '111111' : '000000';
    expect(verifyTotpCode(envelope({ secret }), wrong, now)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  /**
   * Tolerance of ±1 step — a phone clock being a few seconds off is normal.
   *    With 0, many valid logins would fail for no reason.
   */
  it('tolerates ±1 step (±30 seconds), not ±2', () => {
    const step = TOTP_PERIOD * 1000;
    expect(verifyTotpCode(envelope({ secret }), codeAt(secret, now - step), now).ok).toBe(true);
    expect(verifyTotpCode(envelope({ secret }), codeAt(secret, now + step), now).ok).toBe(true);
    expect(verifyTotpCode(envelope({ secret }), codeAt(secret, now - 2 * step), now).ok).toBe(false);
    expect(verifyTotpCode(envelope({ secret }), codeAt(secret, now + 2 * step), now).ok).toBe(false);
  });

  /**
   * Replay — the same 6 digits stay valid for 30 seconds. Without remembering
   *    the counter, a code seen over someone's shoulder could be used to log in a second time.
   */
  it('the same code does not work twice', () => {
    const env = envelope({ secret });
    const code = codeAt(secret, now);

    const first = verifyTotpCode(env, code, now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const after = { ...env, lastCounter: first.counter };
    expect(verifyTotpCode(after, code, now)).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  /** A code from an earlier step (even inside the window) must no longer work */
  it('a code from an earlier step is replayed too — once the counter has moved on there is no going back', () => {
    const step = TOTP_PERIOD * 1000;
    const env = envelope({
      secret,
      lastCounter: Math.floor(now / 1000 / TOTP_PERIOD),
    });
    expect(verifyTotpCode(env, codeAt(secret, now - step), now)).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  it('a code from the next step works — a user whose clock runs slightly ahead is not locked out', () => {
    const step = TOTP_PERIOD * 1000;
    const env = envelope({
      secret,
      lastCounter: Math.floor(now / 1000 / TOTP_PERIOD),
    });
    const v = verifyTotpCode(env, codeAt(secret, now + step), now);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.counter).toBe(env.lastCounter + 1);
  });

  it('verification works even when 2FA is off — exactly what the enable step needs', () => {
    const env = envelope({ secret, enabled: false });
    expect(verifyTotpCode(env, codeAt(secret, now), now).ok).toBe(true);
  });
});

// ══════════════════ recovery codes ══════════════════

describe('recovery codes', () => {
  /** If it were not 32, `% length` would pick some characters more often */
  it('the alphabet is exactly 32 characters, with no 0/1/I/O', () => {
    expect(RECOVERY_ALPHABET).toHaveLength(32);
    expect(new Set(RECOVERY_ALPHABET).size).toBe(32);
    for (const ch of '01IO') expect(RECOVERY_ALPHABET).not.toContain(ch);
  });

  it('by default 10 codes, each 10 characters + a dash in the middle', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const c of codes) {
      expect(c).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
      expect(normalizeRecoveryCode(c)).toHaveLength(RECOVERY_CODE_LENGTH);
    }
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('the dash is only for readability — it does not go into the hash', () => {
    expect(formatRecoveryCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
    expect(hashRecoveryCode('ABCDE-FGHJK')).toBe(hashRecoveryCode('abcdefghjk'));
    expect(hashRecoveryCode('a b c d e f g h j k')).toBe(
      hashRecoveryCode('ABCDEFGHJK'),
    );
  });

  it('the hash is 64 hex characters — plaintext is nowhere', () => {
    const h = hashRecoveryCode('ABCDE-FGHJK');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('ABCDE');
  });

  /**
   * On a match the code must be removed from the list — otherwise the same
   *    paper's code would work again and again, and "single-use" would be a lie.
   */
  it('a correct code is used up, and does not work a second time', () => {
    const codes = generateRecoveryCodes(3);
    const hashes = codes.map(hashRecoveryCode);

    const first = consumeRecoveryCode(hashes, codes[1]);
    expect(first.ok).toBe(true);
    expect(first.remaining).toHaveLength(2);
    expect(first.remaining).not.toContain(hashes[1]);

    expect(consumeRecoveryCode(first.remaining, codes[1]).ok).toBe(false);
  });

  it('the list stays intact on a wrong code', () => {
    const codes = generateRecoveryCodes(3);
    const hashes = codes.map(hashRecoveryCode);
    const v = consumeRecoveryCode(hashes, 'ZZZZZ-ZZZZZ');
    expect(v.ok).toBe(false);
    expect(v.remaining).toEqual(hashes);
  });

  it('an empty code never succeeds — not even against an empty list', () => {
    expect(consumeRecoveryCode([], '').ok).toBe(false);
    expect(consumeRecoveryCode([hashRecoveryCode('ABCDEFGHJK')], '  -  ').ok).toBe(
      false,
    );
  });

  it('lower-case letters and extra spaces still match — a code typed from paper', () => {
    const codes = generateRecoveryCodes(2);
    const hashes = codes.map(hashRecoveryCode);
    const sloppy = ` ${codes[0].toLowerCase().replace('-', ' ')} `;
    expect(consumeRecoveryCode(hashes, sloppy).ok).toBe(true);
  });

  /** Must not throw even if a broken hex is stored (timingSafeEqual throws on length) */
  it('does not throw even if the list has a broken hash', () => {
    const code = generateRecoveryCodes(1)[0];
    const hashes = ['zz', '', hashRecoveryCode(code)];
    expect(consumeRecoveryCode(hashes, code).ok).toBe(true);
  });
});

// ══════════════════ second step — both paths together ══════════════════

describe('verifySecondFactor — the second step of login', () => {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const now = 1_760_000_000_000;

  function withCodes(): { env: TotpEnvelope; codes: string[] } {
    const codes = generateRecoveryCodes(3);
    return {
      env: envelope({ secret, recoveryHashes: codes.map(hashRecoveryCode) }),
      codes,
    };
  }

  /**
   * `missing` must be separate — if it were treated as a failure, every normal
   *    login would raise the throttle counter, and five logins would lock
   *    the account for 15 minutes.
   */
  it('missing if nothing is given — not invalid', () => {
    const { env } = withCodes();
    expect(verifySecondFactor(env, {}, now)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(verifySecondFactor(env, { totp: '  ', recoveryCode: '' }, now)).toEqual(
      { ok: false, reason: 'missing' },
    );
  });

  it('a correct TOTP advances the counter, the recovery list stays intact', () => {
    const { env } = withCodes();
    const v = verifySecondFactor(env, { totp: codeAt(secret, now) }, now);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.usedRecoveryCode).toBe(false);
    expect(v.env.lastCounter).toBe(Math.floor(now / 1000 / TOTP_PERIOD));
    expect(v.env.recoveryHashes).toEqual(env.recoveryHashes);
  });

  it('a correct recovery code is removed, the counter is unchanged', () => {
    const { env, codes } = withCodes();
    const v = verifySecondFactor(env, { recoveryCode: codes[2] }, now);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.usedRecoveryCode).toBe(true);
    expect(v.env.recoveryHashes).toHaveLength(2);
    expect(v.env.lastCounter).toBe(env.lastCounter);
  });

  /** With only a TOTP given, the recovery list must not be searched — otherwise a wrong
   *  6-digit code could by chance match some recovery hash */
  it('wrong TOTP and no recovery codes gives back the real reason', () => {
    const { env } = withCodes();
    expect(verifySecondFactor(env, { totp: '000000' }, now).ok).toBe(false);
    expect(verifySecondFactor(env, { totp: '12' }, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('the replay reason is returned separately — a message worth showing the user', () => {
    const { env } = withCodes();
    const used = { ...env, lastCounter: Math.floor(now / 1000 / TOTP_PERIOD) };
    expect(verifySecondFactor(used, { totp: codeAt(secret, now) }, now)).toEqual({
      ok: false,
      reason: 'replayed',
    });
  });

  it('invalid if both are wrong, and nothing is used up', () => {
    const { env } = withCodes();
    const v = verifySecondFactor(
      env,
      { totp: '000000', recoveryCode: 'ZZZZZ-ZZZZZ' },
      now,
    );
    expect(v).toEqual({ ok: false, reason: 'invalid' });
  });

  it('even if the app code is wrong, a recovery code works if there is one', () => {
    const { env, codes } = withCodes();
    const v = verifySecondFactor(
      env,
      { totp: '000000', recoveryCode: codes[0] },
      now,
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.usedRecoveryCode).toBe(true);
  });
});

// ══════════════════ I09 — inactivity ══════════════════

describe('inactivity arithmetic (I09)', () => {
  const TIMEOUT = SESSION_TTL_MIN * 60 * 1000;
  const WARN = IDLE_WARN_BEFORE_SEC * 1000;
  const t0 = 1_700_000_000_000;

  it('just activated = active, full time remaining', () => {
    expect(idleStateAt(t0, t0, TIMEOUT, WARN)).toEqual({
      phase: 'active',
      msLeft: TIMEOUT,
    });
  });

  it('just before the warning window, still active', () => {
    const s = idleStateAt(t0, t0 + TIMEOUT - WARN - 1, TIMEOUT, WARN);
    expect(s.phase).toBe('active');
  });

  /**
   * Without showing the warning exactly at the boundary, the user would get no
   *    warning at all at the last moment — a silent logout mid-work, which is forbidden.
   */
  it('warning exactly with 1 minute left', () => {
    const s = idleStateAt(t0, t0 + TIMEOUT - WARN, TIMEOUT, WARN);
    expect(s).toEqual({ phase: 'warning', msLeft: WARN });
  });

  it('expired when time runs out, msLeft exactly 0', () => {
    expect(idleStateAt(t0, t0 + TIMEOUT, TIMEOUT, WARN)).toEqual({
      phase: 'expired',
      msLeft: 0,
    });
    expect(idleStateAt(t0, t0 + TIMEOUT + 99_999, TIMEOUT, WARN)).toEqual({
      phase: 'expired',
      msLeft: 0,
    });
  });

  /**
   * If the clock goes backwards (waking from sleep, NTP sync), the subtraction
   *    would be negative and `msLeft` would look larger than the timeout — the warning would never come.
   */
  it('even if the clock goes backwards, msLeft does not exceed the timeout', () => {
    const s = idleStateAt(t0 + 60_000, t0, TIMEOUT, WARN);
    expect(s).toEqual({ phase: 'active', msLeft: TIMEOUT });
  });

  it('if the warning window equals the timeout, warning from the start', () => {
    expect(idleStateAt(t0, t0, TIMEOUT, TIMEOUT).phase).toBe('warning');
  });

  it('the keep-alive ping does not go before the refresh interval, and goes after it', () => {
    const refresh = 5 * 60 * 1000;
    expect(shouldPingSession(t0, t0 + refresh - 1, refresh)).toBe(false);
    expect(shouldPingSession(t0, t0 + refresh, refresh)).toBe(true);
  });
});
