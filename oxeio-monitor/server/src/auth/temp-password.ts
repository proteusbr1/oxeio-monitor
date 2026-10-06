/**
 * Temporary passwords, **to be read off a screen and typed by hand**.
 *
 * Why this had to be rewritten: it used to be
 * `randomBytes(12).toString('base64url').slice(0, 14)`. Perfect for secrecy,
 * but **broken in use**: base64url puts `l` `I` `1` side by side, and `O` `0`,
 * plus a mix of upper and lower case and `-` `_`.
 *
 * The owner reads this string on screen, tells the staff member, and the
 * staff member types it into the agent window. Typing 14 such characters
 * correctly is nearly impossible.
 *
 * Careful: and a typing mistake was **punished with a 15-minute lockout**
 * (after 5 wrong attempts). So what happened: the owner reset a password, the
 * staff member mistyped a few times, and the screen showed <i>"Too many failed
 * attempts. Try again in 13 minutes."</i> It looked as though **the reset
 * itself was not working**, when the password was in fact correct.
 *
 * This is a familiar pattern in this project: <b>the failure does not point
 * at the real cause.</b> The message talks about lockout and says not one
 * word about typos.
 *
 * Careful: the file is separate and pure: it takes the random bytes **from
 * outside**, so the same input gives the same result, and whether the
 * characters really are unambiguous can be verified without a DB or crypto.
 */

/**
 * 32 characters: `0` `O` `1` `I` `l` removed, and all upper case.
 *
 * Careful: dropping lower case entirely is deliberate. If they were mixed,
 * reading it out over the phone or WhatsApp would mean saying "upper or
 * lower" for every character.
 *
 * 32 = 2^5, so the low 5 bits of each byte can be used directly and the
 * distribution stays **perfectly even** (256 % 32 === 0). With an alphabet of
 * 26 or 30 characters some characters would come up more than others.
 */
export const TEMP_PASSWORD_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Characters per group, and how many groups */
const GROUP = 4;
const GROUPS = 3;

/** Characters excluding hyphens: exactly this many random bytes are needed */
export const TEMP_PASSWORD_CHARS = GROUP * GROUPS;

/**
 * `H7K2-M9PQ-3TVX`: three groups of four, 12 characters, 60 bits.
 *
 * The two hyphens are only for the eye, but when read aloud they hold your
 * place: saying "four, four, four" removes the fear of losing track.
 *
 * Careful: 60 bits is less than base64url's ~84 bits, and that is a **conscious
 * trade**. Cracking it by online guessing would take 2^60 attempts, which is
 * impossible against the lockout and network speed. What we got in return:
 * the password **can actually be typed**, and that was the real cause of failure here.
 *
 * @param random Exactly {@link TEMP_PASSWORD_CHARS} random bytes.
 * @throws If fewer bytes are given: a shorter password is not quietly built,
 * because nobody would notice and it would run for years.
 */
export function buildTempPassword(random: Uint8Array): string {
  if (random.length < TEMP_PASSWORD_CHARS) {
    throw new Error(
      `temp password needs ${TEMP_PASSWORD_CHARS} random bytes, got ${random.length}`,
    );
  }

  const chars: string[] = [];
  for (let i = 0; i < TEMP_PASSWORD_CHARS; i++) {
    // Careful: `& 31`, not the remainder (`% 32`). Here both give the same
    // result, but if the alphabet ever exceeded 32, `%` would silently add
    // bias, while `&` would give a plainly wrong character, so the mistake would be noticed.
    chars.push(TEMP_PASSWORD_ALPHABET[random[i] & 31]);
  }

  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    groups.push(chars.slice(g * GROUP, (g + 1) * GROUP).join(''));
  }
  return groups.join('-');
}
