import {
  getLatestShotPerEmployee,
  type GalleryItem,
} from '../../api/screenshots';

/**
 * Picks the newest screenshot per employee from the gallery, to show the **latest**
 * screenshot on each live-board card.
 *
 * Careful: the obvious approach, one call per card with `?employeeId=`, is the
 *    biggest trap here, for two reasons:
 *
 *    1. `GET /screenshots` writes **one audit row per call** ("who looked at my
 *       screenshots"). A board of 15 people would write 15 rows on every refresh.
 *       Staff trust in the whole system rests on those rows; if they fill with
 *       junk, the real events can no longer be found in the audit viewer.
 *    2. Screenshots arrive **every 5 minutes**. Polling every 30 seconds would
 *       return the identical image 8 times out of 9.
 *
 *    So: **one unfiltered call** for everyone, refreshed much more slowly than the
 *    board (`SHOT_REFRESH_MS` in LiveBoardPage).
 */

export interface LatestShots {
  /** Which workday the shots are for; the server picks today's work-zone date itself */
  date: string;
  /**
   * How many employees have a screenshot.
   *
   * Careful: this used to be the **day's total shots**, taken from the gallery
   *    `total`. The server now returns one row per employee, so it means *how many
   *    employees have a shot*. The screen only uses it as `byEmployee.size > 0`,
   *    so no wrong number is ever displayed.
   */
  total: number;
  /** employeeId to that employee's newest shot; the key is absent if none. */
  byEmployee: Map<number, GalleryItem>;
}

/** Nothing fetched; returned without a call when role=employee */
export const NO_SHOTS: LatestShots = { date: '', total: 0, byEmployee: new Map() };

/**
 * The latest screenshots for today in the work zone, one per employee.
 *
 * Careful: `date` is deliberately not sent. The server uses the work day
 *    itself (`workDateOf`). A date sent from the browser would be a different day
 *    on each side after midnight, and cards would keep showing yesterday's shot.
 */
export async function getLatestShots(signal?: AbortSignal): Promise<LatestShots> {
  const res = await getLatestShotPerEmployee(signal);

  const byEmployee = new Map<number, GalleryItem>();
  for (const item of res.items) byEmployee.set(item.employeeId, item);

  return { date: res.date, total: byEmployee.size, byEmployee };
}
