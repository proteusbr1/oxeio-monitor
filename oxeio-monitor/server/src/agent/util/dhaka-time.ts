import { fixedOffsetMinutes as fixedOffsetMinutesOf } from './fixed-offset';

/**
 * Asia/Dhaka = UTC+06:00 with no DST, so it is safe to compute with a constant offset.
 *
 * Careful: in v1 only Asia/Dhaka is supported. The `work_policies.timezone`
 *    column exists for the future, but supporting another timezone needs a real
 *    tz library here (such as Temporal or luxon); this simple arithmetic breaks
 *    wherever DST exists.
 *
 * Update: any zone WITHOUT DST can now be chosen with `WORK_TIMEZONE`
 * (default Asia/Dhaka). Zones with DST are still refused at startup, for the
 * reason above. The `dhaka*` names are kept so callers did not have to change.
 */

/**
 * The work-day time zone, from the `WORK_TIMEZONE` env var (IANA name).
 * Default `Asia/Dhaka`, so a deployment that sets nothing behaves exactly
 * as before.
 *
 * Read from `process.env` at import time, not through `ConfigService`: the
 * `@Cron({ timeZone })` options in `summary/scheduling.ts` are evaluated
 * when the class is defined, before Nest's DI container exists.
 *
 * Only zones WITHOUT daylight saving are accepted (see `fixedOffsetMinutes`).
 * Everything below shifts an instant by one constant offset; with DST that
 * offset would be wrong for half the year and every work date near midnight
 * would land on the wrong day, silently.
 */
export const WORK_TIMEZONE = process.env.WORK_TIMEZONE?.trim() || 'Asia/Dhaka';

// the check lives in fixed-offset.ts (no side effects), so main.ts can use
// it before this module is loaded — see main.ts › applySavedTimeZone
export { fixedOffsetMinutes } from './fixed-offset';

/** Minutes east of UTC for `WORK_TIMEZONE` — refuses to start on a DST zone */
export const LOCAL_OFFSET_MIN = fixedOffsetMinutesOf(WORK_TIMEZONE);

/**
 * The old name, kept so the many callers stay untouched. With the default
 * zone it is still 360; with another zone it is that zone's offset.
 */
export const DHAKA_OFFSET_MIN = LOCAL_OFFSET_MIN;

/** The offset as an ISO-8601 suffix: `+06:00`, `-03:00`, `+00:00` */
export const LOCAL_OFFSET_ISO = ((): string => {
  const abs = Math.abs(LOCAL_OFFSET_MIN);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${LOCAL_OFFSET_MIN < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
})();

/**
 * Short place name for human-facing text ("… (Dhaka)" in the digest).
 * `Asia/Dhaka` → `Dhaka`, `America/Sao_Paulo` → `Sao Paulo`, `UTC` → `UTC`.
 */
export const WORK_TIMEZONE_LABEL = (
  WORK_TIMEZONE.split('/').pop() ?? WORK_TIMEZONE
).replace(/_/g, ' ');

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFSET_MS = DHAKA_OFFSET_MIN * 60 * 1000;

/**
 * Which date an instant falls on in Dhaka time.
 * Returns that date's UTC midnight, which is exactly what Prisma's `@db.Date` wants.
 */
export function workDateOf(instant: Date): Date {
  const shifted = new Date(instant.getTime() + OFFSET_MS);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ),
  );
}

/**
 * **The moment the Dhaka day of that instant started** (G166).
 *
 * Careful: <b>not `workDateOf()`.</b> That is a **label**: the Dhaka day written
 * as a UTC midnight. Using that value directly as a moment puts the boundary
 * **6 hours late**, i.e. at 6 am Dhaka time. This one mistake has happened more
 * often than any other in this project, so the number is never worked out by
 * hand anywhere else; everyone takes it from here.
 */
export function localMidnightOf(instant: Date): Date {
  return new Date(workDateOf(instant).getTime() - OFFSET_MS);
}

/** The next **local** midnight after the instant, as a UTC instant (§ 2.1-a). */
export function nextLocalMidnight(instant: Date): Date {
  return new Date(localMidnightOf(instant).getTime() + DAY_MS);
}

/**
 * The hour (0-23) of the instant in Dhaka time.
 *
 * Careful: `getHours()` uses the server's timezone, so a server running in UTC
 * would show 2 am Dhaka time as 8 pm here. Retention and day-close both depend
 * on this number, so a mistake would run the jobs at the wrong time.
 */
export function dhakaHourOf(instant: Date): number {
  return new Date(instant.getTime() + OFFSET_MS).getUTCHours();
}

/**
 * The Dhaka clock as `HH:MM`, e.g. `18:30`.
 *
 * Careful: same technique as `dhakaHourOf` (add the offset, read UTC), for the
 * same reason: `getHours()` would use the server's timezone, and containers run
 * in UTC.
 * The daily report prints this so readers know **which moment** the numbers
 * are from; many people are still at work as of 6:30 pm.
 */
export function dhakaClock(instant: Date): string {
  const local = new Date(instant.getTime() + OFFSET_MS);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');

  return `${hh}:${mm}`;
}

export function sameWorkDate(a: Date, b: Date): boolean {
  return workDateOf(a).getTime() === workDateOf(b).getTime();
}

/** For building file paths: YYYY/MM/DD by the Dhaka date. */
export function dhakaPathParts(instant: Date): {
  year: string;
  month: string;
  day: string;
  hhmmss: string;
} {
  const s = new Date(instant.getTime() + OFFSET_MS);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return {
    year: String(s.getUTCFullYear()),
    month: pad(s.getUTCMonth() + 1),
    day: pad(s.getUTCDate()),
    hhmmss: `${pad(s.getUTCHours())}${pad(s.getUTCMinutes())}${pad(s.getUTCSeconds())}`,
  };
}
