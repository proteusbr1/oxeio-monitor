/**
 * Gallery maths: date parsing and pagination.
 *
 * Kept in its own file because both are places where a mistake raises no
 * error. The user just sees photos from the wrong day or the wrong page.
 * Testable without a DB.
 */

/**
 * Photos per page. At one 5-minute slot x 2 monitors, one person's full work
 * day comes to about two pages, which is comfortable to scroll in the grid.
 */
export const GALLERY_PAGE_SIZE = 60;

/**
 * `YYYY-MM-DD` -> **UTC midnight** of that date. The `screenshots.work_date`
 * column is `@db.Date` and Prisma expects exactly this (see workDateOf in
 * agent/util/dhaka-time.ts).
 *
 * Careful: a regex check alone would accept `2026-02-30`, and `Date.UTC`
 * would silently turn it into 2 March. The user would ask for February and
 * get March photos with no error. So the resulting date is compared back.
 *
 * @returns `null` when invalid (the caller turns that into a 400)
 */
export function parseWorkDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

/** UTC-midnight date -> `YYYY-MM-DD` (for sending back in the response). */
export function formatWorkDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface PageSlice {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  totalPages: number;
}

/**
 * Page number -> `skip`/`take`.
 *
 * Careful: pages are counted from 1 (nobody writes `page=0` in a URL) but
 * `skip` from 0. This one-off difference could make the first page's photos
 * vanish.
 *
 * `totalPages` is at least 1 even with no photos, otherwise the frontend
 * would show "page 1 / 0".
 */
export function pageSlice(
  page: number,
  total: number,
  pageSize: number = GALLERY_PAGE_SIZE,
): PageSlice {
  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    page: safePage,
    pageSize,
    skip: (safePage - 1) * pageSize,
    take: pageSize,
    totalPages,
  };
}
