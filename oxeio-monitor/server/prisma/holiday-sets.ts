/**
 * Which country's holidays the seed writes — `SEED_COUNTRY`.
 *
 * The seed used to write Bangladesh's public holidays unconditionally. That is
 * right for the office this was built for and wrong everywhere else: every
 * listed date takes a workday out of the month, so a deployment in another
 * country would start with targets, pace and prorated salary computed on
 * holidays it does not have.
 *
 * ⚠️ Only Bangladesh ships with the code. Other countries' calendars change by
 *    decree, by state, by city; a list kept here would be wrong somewhere the
 *    day it is merged. They come in through `import-holidays.ts` (CSV or ICS
 *    from an official source) instead.
 */
import {
  BD_HOLIDAYS,
  HOLIDAY_YEARS,
  PENDING_GAZETTES,
  type HolidayEntry,
  type PendingGazette,
} from './holidays.data';

export interface HolidaySet {
  /** ISO 3166-1 alpha-2 */
  code: string;
  entries: readonly HolidayEntry[];
  years: readonly number[];
  pending: readonly PendingGazette[];
  /**
   * `settings` key that records which years were seeded. Bangladesh keeps the
   * original `seed.holidays`, so an existing database sees no change.
   */
  settingKey: string;
}

export const HOLIDAY_SETS: Readonly<Record<string, HolidaySet>> = {
  BD: {
    code: 'BD',
    entries: BD_HOLIDAYS,
    years: HOLIDAY_YEARS,
    pending: PENDING_GAZETTES,
    settingKey: 'seed.holidays',
  },
};

export const DEFAULT_COUNTRY = 'BD';

/** "Write no holidays" — for anyone whose calendar is not in `HOLIDAY_SETS` */
export const NO_HOLIDAYS = 'none';

/**
 * The set to seed, or `null` for none.
 *
 * - unset or empty → Bangladesh, as before;
 * - `none` → no holidays (add them later, or import a file);
 * - `SEED_HOLIDAYS=false` → none as well (the switch from the first briefing);
 * - anything else unknown → an error, not a silent fallback to Bangladesh.
 *
 * ⚠️ `SEED_HOLIDAYS` is matched against exactly `'false'`, the same way the
 *    seed matches `SEED_HOLIDAYS_PAST` against exactly `'true'`.
 */
export function resolveHolidaySet(env: {
  SEED_COUNTRY?: string;
  SEED_HOLIDAYS?: string;
}): HolidaySet | null {
  if (env.SEED_HOLIDAYS === 'false') return null;

  const code = (env.SEED_COUNTRY ?? '').trim().toUpperCase() || DEFAULT_COUNTRY;
  if (code === NO_HOLIDAYS.toUpperCase()) return null;

  const set = HOLIDAY_SETS[code];
  if (!set) {
    const known = [...Object.keys(HOLIDAY_SETS), NO_HOLIDAYS].join(', ');
    throw new Error(
      `SEED_COUNTRY="${env.SEED_COUNTRY}" has no holiday list here (known: ${known}). ` +
        `Use SEED_COUNTRY=none and import your calendar with prisma/import-holidays.ts.`,
    );
  }
  return set;
}
