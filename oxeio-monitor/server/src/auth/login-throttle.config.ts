/**
 * Login lockout sizing: pure functions that interpret the values read from `.env`.
 *
 * Careful: why this had to be opened up: the sizes were hardcoded, 5 wrong
 * attempts and a 15-minute lock. Reasonable against brute force, but what
 * actually happened: the owner reset a staff member's password, the staff
 * member mistyped a few times (the password had a mix of `l/1/O/0`), and the
 * screen said <i>"Try again in 13 minutes."</i> In a 15-person office where
 * everyone sits in the next room, that is not protection, just an obstacle.
 *
 * So both sizes now live in `.env`, and the defaults are much softer.
 *
 * Careful: it can be turned off entirely with `LOGIN_LOCK_MINUTES=0`. There
 * is a single knob, so nobody has to remember "what happens if I turn off which one".
 */

export interface ThrottleLimits {
  /** Failures before locking, for the **same email + same IP** pair */
  maxFails: number;
  /**
   * After how many failures the **whole IP** is locked, whatever the email (G116).
   *
   * Careful: why this field was needed: the pair key (`email|ip`) only
   *    catches "one person's password guessed repeatedly". But the real
   *    attack is the reverse: **a thousand different emails** from one IP,
   *    one or two tries each. Then every attempt landed in a different key,
   *    no counter reached its limit, and the lock **never fell**. Failures
   *    are counted for unknown emails too (`auth.service.ts`), so this
   *    counter closes that gap.
   *
   * Careful: the limit is deliberately **much higher**: the whole office sits
   *    behind one IP, so on a password-reset day a few typos each from seven
   *    people can easily add up to 20-30. This is not the last word in
   *    security; it moves things from "unlimited" to "measured", and that
   *    difference is what matters here.
   */
  ipMaxFails: number;
  /** How long the lock lasts, in milliseconds */
  lockMs: number;
  /** When `false`, lockout is switched off entirely */
  enabled: boolean;
}

/**
 * Careful: the default is **10 attempts / 2 minutes**; it used to be 5 attempts / 15 minutes.
 *
 * Reasoning: against online password guessing what matters is the **rate**,
 * not the length of the lock. Even a 2-minute lock cuts attempts to 300 an
 * hour, so cracking by guessing is still impossible. But for a staff member
 * who mistyped, the difference between 15 minutes and 2 is huge.
 */
const DEFAULT_MAX_FAILS = 10;
const DEFAULT_LOCK_MINUTES = 2;

/**
 * The IP limit defaults to **five times** the pair limit: a multiple, not a
 * separate number. If someone softens `LOGIN_MAX_FAILS` the IP limit softens
 * with it, so the two knobs never work against each other.
 *
 * Careful: by default 50 failures / 2 minutes. It sounds loose, but the
 * arithmetic is this: attempts drop to ~1500 an hour, and **before it was
 * unlimited**. Against 7 accounts with strong passwords that is an effective
 * barrier, and nobody in the office will ever fail 50 times.
 */
const IP_FAILS_MULTIPLIER = 5;

/**
 * Careful: the upper limit is deliberate. If someone typed
 * `LOGIN_LOCK_MINUTES=100000` they would effectively lock themselves out
 * forever, and since the counter is in memory the only way back would be a
 * server restart.
 */
const MAX_LOCK_MINUTES = 60;
const MAX_FAILS_CEILING = 100;

/**
 * @param raw The raw value from `.env`, assumed unvalidated.
 *
 * Careful: an invalid value **does not stop things, it falls back to the
 * default**. Login is the only door in; a server that fails to start because
 * of one typo in `.env` would lock the owner out of their own system.
 */
export function resolveThrottle(raw: {
  maxFails?: string | number | null;
  lockMinutes?: string | number | null;
  ipMaxFails?: string | number | null;
}): ThrottleLimits {
  const maxFails = clamp(
    toNumber(raw.maxFails, DEFAULT_MAX_FAILS),
    1,
    MAX_FAILS_CEILING,
    DEFAULT_MAX_FAILS,
  );

  /**
   * Careful: the default comes from the multiple, and the ceiling is five
   *    times the pair ceiling too; otherwise `LOGIN_MAX_FAILS=100` would pin
   *    the IP limit (500) at the ceiling and make it **smaller than the pair
   *    limit**, so the IP would lock first and the knob's meaning would invert.
   * Careful: the lower bound is `maxFails`: the IP limit can never be lower than the pair limit.
   */
  const ipMaxFails = clamp(
    toNumber(raw.ipMaxFails, maxFails * IP_FAILS_MULTIPLIER),
    maxFails,
    MAX_FAILS_CEILING * IP_FAILS_MULTIPLIER,
    maxFails * IP_FAILS_MULTIPLIER,
  );

  const lockMinutes = toNumber(raw.lockMinutes, DEFAULT_LOCK_MINUTES);

  // Careful: zero is valid and means "off"; it must not be caught by clamp's lower bound
  if (lockMinutes === 0) {
    return { maxFails, ipMaxFails, lockMs: 0, enabled: false };
  }

  const minutes = clamp(lockMinutes, 1, MAX_LOCK_MINUTES, DEFAULT_LOCK_MINUTES);
  return { maxFails, ipMaxFails, lockMs: minutes * 60 * 1000, enabled: true };
}

/**
 * Careful: `Number('')` gives zero and `Number(undefined)` gives `NaN`; both
 * must count as "not provided". If an empty string counted as zero, merely
 * writing `LOGIN_LOCK_MINUTES=` in `.env` would silently turn lockout off.
 */
function toNumber(value: string | number | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;

  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** Careful: out of range falls back to the default; it is not clamped to the limit. If someone
 *  writes 999 their intent is unclear, so returning to a known value is safer than guessing. */
function clamp(n: number, min: number, max: number, fallback: number): number {
  return n >= min && n <= max ? n : fallback;
}
