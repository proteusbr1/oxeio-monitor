/** The agent sends its own clock time with every request (spec § 2, clock drift). */
export const CLIENT_TIME_HEADER = 'x-client-time';

/** Spec § 4.1 - ingest limits. */
export const MAX_BATCH_SIZE = 500;
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const ALLOWED_SCREENSHOT_MIME = 'image/webp';

/** Per-device rate limit (per minute). */
export const RATE_LIMIT_INGEST = 60;
export const RATE_LIMIT_SCREENSHOT = 20;

/** Enrollment code - single use, expires after 24 hours (H05). */
export const ENROLLMENT_CODE_TTL_HOURS = 24;
