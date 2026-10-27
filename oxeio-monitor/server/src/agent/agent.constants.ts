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

/**
 * **Bounds on the agent's resource report in the heartbeat** (handles, private
 * memory, GDI/USER objects, known injected modules).
 *
 * Careful: these are **sanity bounds, not the ceiling**. The ceiling (when the
 * agent restarts itself, when the owner is told) is in `resources.rules.ts`.
 * The two must not be confused: a leaking agent is exactly the one that reports
 * 217,000 handles, and if the DTO's `@Max` sat near the ceiling, the very
 * heartbeat that carries the bad news would get a 400, and a 400 on the
 * heartbeat also drops its commands, revoke among them. So each bound is the
 * **hard limit Windows itself enforces**: a value above it is not a leak, it is
 * garbage. The agent clamps to the same numbers before sending (`SyncLimits`).
 */
/** Windows' per-process handle limit: 2^24. */
export const HEARTBEAT_MAX_HANDLES = 16_777_216;
/** The x64 user-mode address space: 128 TiB. Still well under 2^53. */
export const HEARTBEAT_MAX_PRIVATE_BYTES = 140_737_488_355_328;
/** GDI and USER objects: 65,536 per process at most (the quota's hard cap). */
export const HEARTBEAT_MAX_GUI_OBJECTS = 65_536;
/** At most this many module names; the agent watches a short fixed list. */
export const HEARTBEAT_MAX_MODULES = 8;
export const HEARTBEAT_MAX_MODULE_NAME = 64;
/**
 * A bare DLL file name: `nvspcap64.dll`. Careful: no slashes, colons or spaces,
 * so a path (which would carry the user's name) can never be stored here.
 */
export const HEARTBEAT_MODULE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
