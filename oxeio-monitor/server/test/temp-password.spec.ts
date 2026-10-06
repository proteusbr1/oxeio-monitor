import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildTempPassword,
  TEMP_PASSWORD_ALPHABET,
  TEMP_PASSWORD_CHARS,
} from '../src/auth/temp-password';

/**
 * Temporary password — whether it **can be typed** is the question here.
 *
 * This file was written after a field incident: the owner reset a staff
 * member's password, the staff member mistyped it a few times in the agent
 * window, and the screen showed <i>"Too many failed attempts. Try again in 13
 * minutes."</i> — so it looked like **the reset itself was not working**,
 * although the password was correct. The cause: in the old base64url, `l` `I`
 * `1` and `O` `0` sat side by side.
 */
describe('buildTempPassword', () => {
  const bytes = (n: number) => new Uint8Array(TEMP_PASSWORD_CHARS).fill(n);

  it('twelve characters in three groups', () => {
    const pw = buildTempPassword(bytes(0));

    expect(pw).toHaveLength(14); // 12 characters + 2 hyphens
    expect(pw.split('-')).toHaveLength(3);
    expect(pw.split('-').every((g) => g.length === 4)).toBe(true);
  });

  /**
   * **The main test of this file.** Not a single ambiguous character is
   * allowed — this is where the real bug was.
   */
  it('ambiguous characters never appear', () => {
    // All 256 values are tested — sampling would miss the rare character
    for (let b = 0; b < 256; b++) {
      const pw = buildTempPassword(bytes(b));

      for (const bad of ['0', 'O', '1', 'I', 'l', 'o', 'i']) {
        expect(pw).not.toContain(bad);
      }
    }
  });

  it('only alphabet characters and hyphens', () => {
    const pw = buildTempPassword(randomBytes(TEMP_PASSWORD_CHARS));

    for (const ch of pw.replace(/-/g, '')) {
      expect(TEMP_PASSWORD_ALPHABET).toContain(ch);
    }
  });

  /** The alphabet is 32 = 2^5, so `& 31` gives a perfectly even distribution */
  it('256 bytes split into exactly 32 characters, evenly', () => {
    const seen = new Map<string, number>();

    for (let b = 0; b < 256; b++) {
      const ch = buildTempPassword(bytes(b))[0];
      seen.set(ch, (seen.get(ch) ?? 0) + 1);
    }

    expect(seen.size).toBe(32);
    // 256 ÷ 32 = 8 — each character exactly eight times, none more or less
    expect([...seen.values()].every((n) => n === 8)).toBe(true);
  });

  it('the same bytes give the same result — the function is pure', () => {
    const seed = randomBytes(TEMP_PASSWORD_CHARS);

    expect(buildTempPassword(seed)).toBe(buildTempPassword(seed));
  });

  it('each position comes from its own byte', () => {
    const seed = new Uint8Array(TEMP_PASSWORD_CHARS);
    seed[0] = 0;
    seed[1] = 31;

    const pw = buildTempPassword(seed);

    expect(pw[0]).toBe(TEMP_PASSWORD_ALPHABET[0]);
    expect(pw[1]).toBe(TEMP_PASSWORD_ALPHABET[31]);
  });

  /**
   * It **stops** if given too few bytes. Quietly producing a short password
   * would go unnoticed for years — and every reset would hand out a weak
   * password with no sign of it.
   */
  it('throws when there are too few bytes', () => {
    expect(() => buildTempPassword(new Uint8Array(TEMP_PASSWORD_CHARS - 1))).toThrow(
      /random bytes/,
    );
    expect(() => buildTempPassword(new Uint8Array(0))).toThrow();
  });

  it('no problem if given more bytes', () => {
    expect(buildTempPassword(randomBytes(64))).toHaveLength(14);
  });

  /** No lower-case letters at all — spelling it over the phone needs no "upper or lower" */
  it('all upper case', () => {
    const pw = buildTempPassword(randomBytes(TEMP_PASSWORD_CHARS));

    expect(pw).toBe(pw.toUpperCase());
  });
});
