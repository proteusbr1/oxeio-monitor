import { Zone, type ZoneTransition } from './zone';

/**
 * The work-day time zone and every "which day / which hour is it there"
 * question the server asks. The helpers are named `work*` because they are
 * tied to the configured zone, not to any one city.
 *
 * Daylight saving is supported: every answer comes from the tz database
 * (`zone.ts`), so the offset is the one in force at that instant, a day can
 * be 23 or 25 hours long, and a missing midnight is handled.
 */

/**
 * The work-day time zone, from the `WORK_TIMEZONE` env var (IANA name).
 * Default `UTC`, the same default the agent uses; a company sets its own on
 * Settings → Company & region (main.ts puts the saved zone into the env
 * before this module loads) or in `.env`.
 *
 * Read from `process.env` at import time, not through `ConfigService`: the
 * `@Cron({ timeZone })` options in `summary/scheduling.ts` are evaluated
 * when the class is defined, before Nest's DI container exists.
 */
export const WORK_TIMEZONE = process.env.WORK_TIMEZONE?.trim() || 'UTC';

/** Refuses to start on a zone name the tz database does not know */
const ZONE = new Zone(WORK_TIMEZONE);

export { assertKnownZone, type ZoneTransition } from './zone';

/** Minutes east of UTC at that instant (Lisbon: 0 in winter, 60 in summer) */
export function workOffsetMinutesAt(instant: Date): number {
  return ZONE.offsetMinutesAt(instant.getTime());
}

/** The offset in force at `from`, then each change up to `to` — for the agent */
export function workZoneTransitions(from: Date, to: Date): ZoneTransition[] {
  return ZONE.transitions(from, to);
}

/**
 * Short place name for human-facing text ("… (Lisbon)", say, in the digest).
 * For example `Europe/Lisbon` → `Lisbon`, `America/Sao_Paulo` → `Sao Paulo`, `UTC` → `UTC`.
 */
export const WORK_TIMEZONE_LABEL = (
  WORK_TIMEZONE.split('/').pop() ?? WORK_TIMEZONE
).replace(/_/g, ' ');

/**
 * Which date an instant falls on in work-zone time.
 * Returns that date's UTC midnight, which is exactly what Prisma's `@db.Date` wants.
 */
export function workDateOf(instant: Date): Date {
  return ZONE.dateOf(instant.getTime());
}

/**
 * **The moment a work date began**, from its label (a `@db.Date` value).
 *
 * Careful: the label is **not** a moment. Using it directly puts the boundary
 * off by the zone's offset — the one mistake that happened more often than any
 * other in this project, so the conversion lives only here.
 */
export function startOfWorkDate(date: Date): Date {
  return ZONE.startOfDate(date);
}

/** The moment the work day of that instant started (G166). */
export function localMidnightOf(instant: Date): Date {
  return ZONE.startOfDate(workDateOf(instant));
}

/**
 * The start of the next work day after the instant, as a UTC instant (§ 2.1-a).
 * Careful: not `localMidnightOf + 24 h` — with daylight saving a day can be
 * 23 or 25 hours long.
 */
export function nextLocalMidnight(instant: Date): Date {
  return ZONE.nextDayStart(instant.getTime());
}

/** The work-zone wall clock at that instant, written as if UTC (read with getUTC*) */
export function workWallOf(instant: Date): Date {
  return ZONE.wallOf(instant.getTime());
}

/** The instant a work-zone wall-clock time names (`wall` written as if UTC) */
export function instantOfWorkWall(wall: Date): Date {
  return ZONE.instantOfWall(wall);
}

/**
 * The hour (0-23) of the instant in work-zone time.
 *
 * Careful: `getHours()` uses the server's timezone, and containers run in UTC.
 * Retention and day-close both depend on this number, so a mistake would run
 * the jobs at the wrong time.
 */
export function workHourOf(instant: Date): number {
  return ZONE.wallOf(instant.getTime()).getUTCHours();
}

/**
 * The work-zone clock as `HH:MM`, e.g. `18:30`. The daily report prints it
 * so readers know **which moment** the numbers are from.
 */
export function workClock(instant: Date): string {
  const local = ZONE.wallOf(instant.getTime());
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');

  return `${hh}:${mm}`;
}

export function sameWorkDate(a: Date, b: Date): boolean {
  return workDateOf(a).getTime() === workDateOf(b).getTime();
}

/** For building file paths: YYYY/MM/DD by the work-zone date. */
export function workPathParts(instant: Date): {
  year: string;
  month: string;
  day: string;
  hhmmss: string;
} {
  const s = ZONE.wallOf(instant.getTime());
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return {
    year: String(s.getUTCFullYear()),
    month: pad(s.getUTCMonth() + 1),
    day: pad(s.getUTCDate()),
    hhmmss: `${pad(s.getUTCHours())}${pad(s.getUTCMinutes())}${pad(s.getUTCSeconds())}`,
  };
}
