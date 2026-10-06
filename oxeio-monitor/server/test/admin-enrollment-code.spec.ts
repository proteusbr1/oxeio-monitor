import { createHash } from 'node:crypto';
import { workNoon } from './setup/clock';

import { describe, expect, it } from 'vitest';

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  ENROLLMENT_CODE_TTL_MS,
  enrollmentCodeExpiry,
  formatEnrollmentCode,
  hashEnrollmentCode,
} from '../src/devices/enrollment-code';

describe('enrollment code: alphabet', () => {
  /**
   * The number is about security, not aesthetics. If it were not 32, some
   * characters would come up more often than others in `byte % length`
   * (modulo bias).
   */
  it('exactly 32 characters, and 256 divides evenly', () => {
    expect(CODE_ALPHABET).toHaveLength(32);
    expect(256 % CODE_ALPHABET.length).toBe(0);
  });

  /**
   * This test used to assert `toContain('O')`, which directly contradicted
   * the "exactly 32 characters" test above: dropping 0/I/L but keeping O
   * makes the alphabet 33 characters, and 256 % 33 = 25, so the first 25
   * characters would come up 8 times and the rest 7 times. The very modulo
   * bias that 32 was chosen to avoid would come back.
   *
   * So all four are dropped: `0` and `O` (both sides of the pair), `I` and
   * `L` (`1` stays). Dropping both members of a pair leaves no room for a
   * mistake in either direction when typing from paper. 36 - 4 = 32, the
   * numbers add up.
   */
  it('look-alike characters are excluded: 0, O, I, L', () => {
    for (const ch of ['0', 'O', 'I', 'L']) {
      expect(CODE_ALPHABET).not.toContain(ch);
    }
    // The member of the pair that was kept
    expect(CODE_ALPHABET).toContain('1');
  });

  it('no character appears twice', () => {
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });

  /** Measure every byte from 0 to 255: each character comes up exactly 8 times */
  it('all byte values are spread evenly, with no bias', () => {
    const hits = new Map<string, number>();
    for (let b = 0; b < 256; b += 1) {
      const ch = CODE_ALPHABET[b % CODE_ALPHABET.length];
      hits.set(ch, (hits.get(ch) ?? 0) + 1);
    }

    expect(hits.size).toBe(32);
    expect([...hits.values()].every((n) => n === 8)).toBe(true);
  });
});

describe('enrollment code: generating the code', () => {
  it('the same bytes always give the same code', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);

    expect(formatEnrollmentCode(bytes)).toBe(formatEnrollmentCode(bytes));
  });

  it('length is 12, and every character is inside the alphabet', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 31) % 256);
    const code = formatEnrollmentCode(bytes);

    expect(code).toHaveLength(CODE_LENGTH);
    expect([...code].every((ch) => CODE_ALPHABET.includes(ch))).toBe(true);
  });

  /**
   * The code has no hyphen or space: the agent hashes the code exactly, so
   * a typing mistake of `AB12-CD34` versus `AB12CD34` could not be caught.
   */
  it('the code has no hyphen or space', () => {
    const code = formatEnrollmentCode(Uint8Array.from({ length: 16 }, () => 5));

    expect(code).toMatch(/^[A-Z0-9]{12}$/);
  });

  it('too few bytes throws instead of quietly giving a short code', () => {
    // A silent 8-character code would drop the entropy to a third, and
    // nobody would notice
    expect(() => formatEnrollmentCode(new Uint8Array(4))).toThrow(RangeError);
  });
});

describe('enrollment code: hash', () => {
  /**
   * Important: this test is the contract with `src/agent/enrollment.service.ts`,
   * which has `createHash('sha256').update(code.trim()).digest('hex')`.
   * If the two sides disagree, every enrollment would silently fail and the
   * agent would only say "code wrong or expired".
   */
  it('matches the agent\'s calculation character for character', () => {
    const code = 'ABCD1234WXYZ';
    const asAgentDoesIt = createHash('sha256')
      .update(code.trim())
      .digest('hex');

    expect(hashEnrollmentCode(code)).toBe(asAgentDoesIt);
  });

  it('ignores leading and trailing whitespace (the agent also calls `.trim()`)', () => {
    expect(hashEnrollmentCode('  ABCD1234WXYZ \n')).toBe(
      hashEnrollmentCode('ABCD1234WXYZ'),
    );
  });

  /**
   * This test used to assert the bug itself: it said "lowercase gives a
   * different hash" and the comment called that a "known limitation".
   *
   * The limitation cost more than it seemed: if someone typed the code in
   * lowercase, the server said "enrollment code wrong or expired", and the
   * same message also comes for "no such code", "already used" and "expired"
   * (H05, G18). So finding the real cause was nearly impossible.
   *
   * The alphabet is entirely uppercase, so `toUpperCase()` is a no-op on
   * generated codes: the hashes of earlier codes stay intact, and old
   * enrollments do not break.
   */
  it('the same hash whatever the letter case', () => {
    expect(hashEnrollmentCode('abcd1234wxyz')).toBe(
      hashEnrollmentCode('ABCD1234WXYZ'),
    );
    expect(hashEnrollmentCode('  AbCd1234WxYz  ')).toBe(
      hashEnrollmentCode('ABCD1234WXYZ'),
    );
    expect([...CODE_ALPHABET].every((ch) => ch === ch.toUpperCase())).toBe(true);
  });

  it('the code never comes back as plaintext: the hash is 64 hex characters', () => {
    const hash = hashEnrollmentCode('ABCD1234WXYZ');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('ABCD');
  });
});

describe('enrollment code: expiry', () => {
  it('exactly 24 hours (H05)', () => {
    const now = new Date('2026-08-10T09:15:00.000Z');

    expect(enrollmentCodeExpiry(now).toISOString()).toBe(
      '2026-08-11T09:15:00.000Z',
    );
    expect(ENROLLMENT_CODE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('expiry is always in the future', () => {
    const now = workNoon();

    expect(enrollmentCodeExpiry(now).getTime()).toBeGreaterThan(now.getTime());
  });
});
