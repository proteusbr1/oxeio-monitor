/**
 * The weekly days off of a work policy — the one place that answers "is this
 * weekday off?".
 *
 * A policy used to have one day off (`weekly_off_day`, e.g. Friday);
 * most countries have two (Sat + Sun, or Fri + Sat). The check lived inline in
 * five places as `day !== null && iso === day`; with a list, writing it five
 * times again would let one copy drift, and workdays, targets, pace and
 * prorated salary all depend on it.
 */

/** ISO weekday: Mon = 1 … Sun = 7 — the numbering `weekly_off_days` uses */
export type IsoWeekday = number;

/** `true` when `isoDay` is one of the policy's weekly days off */
export function isOffWeekday(
  isoDay: IsoWeekday,
  offDays: readonly IsoWeekday[],
): boolean {
  return offDays.includes(isoDay);
}

/**
 * The days off as stored: unique, ISO 1–7, sorted. Anything else is dropped
 * rather than refused here — the DTO refuses it at the door; this only keeps
 * a stray value from turning a workday into a day off.
 */
export function normaliseOffDays(days: readonly number[]): IsoWeekday[] {
  return [
    ...new Set(days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)),
  ].sort((a, b) => a - b);
}
