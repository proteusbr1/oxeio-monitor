/**
 * 'YYYY-MM-DD' -> a `Date` fit to store in a `@db.Date` column.
 *
 * Careful: `src/agent/util/work-time.ts` is deliberately **not** used here.
 * That file converts an *instant* to a work-zone date (for example which workday a
 * segment falls on). But a joining date or a holiday date is not an instant:
 * it is a plain calendar date that a person wrote by hand. Applying a
 * timezone to it would sometimes turn the 1st into the 31st.
 *
 * Careful: the real trap: `new Date('2026-08-10T00:00:00')` (without a
 * trailing `Z`) is read in the server's **local** time. If the server is in
 * a zone east of UTC (UTC+6, say), that is 18:00 of the previous day in UTC, so the database would get
 * a date one day behind and the holiday calendar would silently shift by a
 * day. That is why the `Z` is written explicitly.
 */

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `null` on a bad format or value; the caller decides which status to return */
export function parseCalendarDate(value: string): Date | null {
  const m = CALENDAR_DATE.exec(value);
  if (!m) return null;

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;

  // Careful: JS silently turns `2026-02-31` into 3 March. Without checking it
  // back, the holiday calendar would get a date nobody wrote.
  if (parsed.toISOString().slice(0, 10) !== value) return null;

  return parsed;
}
