/** httpOnly: browser JS can never read it (ADR-016, to stop token theft via XSS) */
export const SESSION_COOKIE = 'oxeio_session';

/**
 * The CSRF double-submit token. Deliberately **not** httpOnly: the frontend
 * has to read it and send it back in the `X-CSRF-Token` header.
 */
export const CSRF_COOKIE = 'oxeio_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** I09: the session ends after 30 minutes of inactivity */
export const SESSION_TTL_MIN = 30;

/**
 * Issuing a new token on every request is wasteful. The cookie is re-set only
 * once the token is older than this (sliding window).
 */
export const SESSION_REFRESH_AFTER_MIN = 5;

/**
 * I09: how long before expiry the "1 minute left" warning appears.
 * Careful: no silent logout in the middle of work; this window is what lets
 * the user save the session with one click.
 */
export const IDLE_WARN_BEFORE_SEC = 60;

/**
 * I11: brute-force protection.
 *
 * Careful: **the values moved out of here** to `login-throttle.config.ts`,
 * and can be changed through `.env` (`LOGIN_MAX_FAILS`, `LOGIN_LOCK_MINUTES`).
 * They used to be 5 attempts / 15 minutes, and in a 15-person office that was
 * not protection but an obstacle: after a password reset, a staff member
 * mistyping a few times got "Try again in 13 minutes", and it looked as if the
 * reset itself had not worked.
 *
 * Careful: do not bring any constant back here. With two sizes in two places
 * nobody could tell which one is actually in force.
 */

/** Minimum password length */
export const MIN_PASSWORD_LENGTH = 10;

// ══════════════════ I06 — TOTP 2FA ══════════════════

/** The name under which the account shows in the authenticator app */
export const TOTP_ISSUER = 'oXeio Monitor';

/** The RFC 6238 defaults: Google Authenticator, Authy and 1Password all assume these */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;

/**
 * Careful: a tolerance of +-1 step (+-30 seconds). A phone clock being a few
 * seconds off is normal; with 0, many valid codes would be rejected for no reason.
 */
export const TOTP_WINDOW = 1;

/** The only way in if the phone is lost; shown just once */
export const RECOVERY_CODE_COUNT = 10;
/** 10 characters x 5 bits = 50 bits of entropy */
export const RECOVERY_CODE_LENGTH = 10;
