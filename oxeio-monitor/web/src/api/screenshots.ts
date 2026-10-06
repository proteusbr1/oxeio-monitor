import { api } from './client';
import { qs } from './query';

/**
 * E06: screenshot gallery.
 *
 * Server source: `server/src/screenshots/` (screenshots.controller.ts,
 * screenshots.service.ts).
 *
 * There is no `@Roles` here: owners, managers and staff all get in. What each may
 * see is decided by scope, not role: for `role = employee` the server takes the
 * employeeId from the session, and asking for someone else's id gives a 403 (J05).
 *
 * Careful: the full URL is never stored (ADR-013). `activeTitle` holds the window
 * title and the domain, nothing more.
 */

export interface GalleryItem {
  /** Careful: a string; the server uses BigInt. */
  id: string;
  employeeId: number;
  empCode: string;
  fullName: string;
  /** ISO instant */
  capturedAt: string;
  slotStart: string;
  monitorIndex: number;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  activeApp: string | null;
  activeTitle: string | null;
  /**
   * Expires after 5 minutes (I07). A relative path, usable directly in
   * `<img src={item.thumbUrl}>`.
   *
   * Careful: once the link expires the image returns 403 and shows a broken icon.
   * The gallery page should catch `<img onError>` and show "link expired, refresh";
   * otherwise in a tab left open for ten minutes every image would silently look broken.
   */
  thumbUrl: string;
  /** Full image for the lightbox; a separate token with the same 5-minute expiry. */
  fullUrl: string;
}

export interface GalleryPage {
  /** `YYYY-MM-DD` */
  date: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: GalleryItem[];
  /** One person whose policy takes no screenshots; optional for older servers */
  screenshotsOff?: boolean;
}

export interface GalleryQuery {
  /** Careful: for role=employee this is not ignored; anything but their own id gives a 403. */
  employeeId?: number;
  /** Defaults to today's workday in Dhaka. */
  date?: string;
  /** Starts at 1. Careful: at most 10,000. */
  page?: number;
}

/**
 * E06: `GET /api/v1/screenshots?employeeId=&date=&page=`
 *
 * This call is written to the audit log (I08); it is what answers "who looked at
 * my screenshots". One row per page, so calling it needlessly fills the audit
 * log; do not poll.
 */
export function getGallery(
  query: GalleryQuery = {},
  signal?: AbortSignal,
): Promise<GalleryPage> {
  return api<GalleryPage>(`/screenshots${qs({ ...query })}`, { signal });
}

/**
 * Each employee's newest screenshot today (G159).
 *
 * Careful: this used to be guessed by pulling the last one or two gallery pages,
 * and anyone whose last screenshot fell outside that 60-120 window got "No
 * screenshot yet today" on their card, even though a screenshot existed.
 */
export function getLatestShotPerEmployee(
  signal?: AbortSignal,
): Promise<{ date: string; items: GalleryItem[] }> {
  return api<{ date: string; items: GalleryItem[] }>('/screenshots/latest', {
    signal,
  });
}
