import { useCallback, useEffect, useRef, useState } from 'react';

import { isAbortError } from '../../api/client';
import {
  getGallery,
  type GalleryItem,
  type GalleryQuery,
} from '../../api/screenshots';

/**
 * Automatically repairs signed URLs that have expired.
 *
 * The server signs each image link for 5 minutes (see
 * `server/src/screenshots/signed-url.service.ts`). Someone who left the gallery
 * open and went for tea would come back to **all images broken**: no error
 * message, just a grid of broken icons, which looks as if the screenshots were
 * lost even though every file is in place.
 *
 * Important: so when an image fails to load, the whole page is **silently** fetched
 * again (with new tokens) and only the `src` values are swapped. To the user the
 * image just arrived a moment late. No button to press, because showing "please
 * refresh" would put the blame on the user.
 *
 * Careful: **one retry only.** If it fails a second time the image is "gone": the
 * problem is no longer expiry, the file is missing (the retention job deleted it, or
 * ingest wrote the DB row and crashed before writing to disk). Retrying forever
 * would hammer the server for every genuinely lost image.
 *
 * Careful: **audit.** Every refresh is a `GET /screenshots`, which writes one audit
 * log row (`screenshots.service.recordView`). So even if 60 images on a page die
 * together, the refresh happens **once**: `inFlightRef` collapses all failures into
 * one call. Without it, leaving a tab open would put 60 rows in the audit log and
 * bury the real events in the audit viewer.
 */

export type ShotVariant = 'thumb' | 'full';

export interface FreshUrls {
  /** The link that should go into `<img src>` for this image right now */
  urlOf: (item: GalleryItem, variant: ShotVariant) => string;
  /** Still failing after two tries; time to show "image no longer available" */
  isDead: (item: GalleryItem, variant: ShotVariant) => boolean;
  /** Call from `<img onError>` */
  reportError: (item: GalleryItem, variant: ShotVariant) => void;
  /** Call from `<img onLoad>` */
  reportLoad: (item: GalleryItem, variant: ShotVariant) => void;
}

/** `${id}:${variant}`; thumbnail and full-size image are tracked separately */
type Slot = string;

const VARIANTS: readonly ShotVariant[] = ['thumb', 'full'];

const NO_URLS: ReadonlyMap<Slot, string> = new Map();
const NO_TRIES: ReadonlyMap<Slot, number> = new Map();

function slotOf(id: string, variant: ShotVariant): Slot {
  return `${id}:${variant}`;
}

function originalUrl(item: GalleryItem, variant: ShotVariant): string {
  return variant === 'thumb' ? item.thumbUrl : item.fullUrl;
}

export function useFreshUrls(query: GalleryQuery): FreshUrls {
  /**
   * New links are **sticky**: once set they never revert to the old one. Reverting
   * would send a loaded image back to the expired link and loop forever: load,
   * break, load, break.
   */
  const [overrides, setOverrides] = useState(NO_URLS);
  /** How many times each image has failed since its last successful load */
  const [tries, setTries] = useState(NO_TRIES);

  // Careful: decisions (call refresh or not, treat as dead or not) must be made inside
  //    the event, without waiting for a render, hence the refs mirroring the state.
  const overridesRef = useRef(overrides);
  const triesRef = useRef(tries);
  /** Slots currently painted on screen; their `src` must not be touched */
  const paintedRef = useRef(new Set<Slot>());
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    // Careful: effects run twice in StrictMode, so `true` must be set every time
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // Careful: when date/staff/page changes, reset everything; drawing the new day's grid
  //    with the old day's dead-image memory would show good images as "gone".
  useEffect(() => {
    overridesRef.current = NO_URLS;
    triesRef.current = NO_TRIES;
    paintedRef.current = new Set();
    inFlightRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    // Returning the same constant stops React re-rendering needlessly
    setOverrides(NO_URLS);
    setTries(NO_TRIES);
  }, [query]);

  const commitTries = useCallback((next: ReadonlyMap<Slot, number>) => {
    triesRef.current = next;
    setTries(next);
  }, []);

  /** Render and event must give the same answer, so it lives in one place */
  const urlNow = useCallback(
    (item: GalleryItem, variant: ShotVariant) =>
      overridesRef.current.get(slotOf(item.id, variant)) ??
      originalUrl(item, variant),
    [],
  );

  /**
   * Images that failed once and waited for a new link but did not get one cannot
   * be left hanging.
   *
   * Careful: without this the image would hang in "loading" forever: neither image
   *    nor message. That is exactly what would happen in the most common case: the
   *    DB row exists but the file is not on disk, so `/file` returns 404 at once.
   */
  const giveUpPending = useCallback(
    (gotFresh: ReadonlyMap<Slot, string>) => {
      const next = new Map(triesRef.current);
      let changed = false;
      for (const [slot, count] of next) {
        if (count === 1 && !gotFresh.has(slot)) {
          next.set(slot, 2);
          changed = true;
        }
      }
      if (changed) commitTries(next);
    },
    [commitTries],
  );

  const refresh = useCallback(() => {
    // Even if 60 images die at once, only one call reaches the server (audit log)
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;

    void getGallery(query, controller.signal).then(
      (page) => {
        inFlightRef.current = false;
        // Careful: the date may change after the response has arrived but while `.then`
        //    is still queued; abort can no longer stop anything. Without this check, a
        //    previous day's links would land in the new day's grid.
        if (!aliveRef.current || abortRef.current !== controller) return;

        const fresh = new Map<Slot, string>();
        for (const item of page.items) {
          for (const variant of VARIANTS) {
            const slot = slotOf(item.id, variant);

            // Careful: changing `src` of an image painted right now would make it
            //    start loading again: a flash of empty cell for no benefit.
            if (paintedRef.current.has(slot)) continue;

            const next = originalUrl(item, variant);

            /**
             * Careful: **the exact same link can come back.** Token expiry is written to
             * the second (`signed-url.ts` -> `expiresAtSec`), so signing twice within one
             * second gives two identical tokens. This is exactly what happens when the
             * file is not on disk and `/file` returns 404 immediately: failure and
             * refresh both fall inside one second.
             *
             * Then `src` does not change, the browser does not retry, and the image
             * would stay silently broken forever. When skipped, `giveUpPending` treats
             * it as dead, and the user at least sees the truth.
             */
            if (next === urlNow(item, variant)) continue;

            fresh.set(slot, next);
          }
        }

        if (fresh.size > 0) {
          const merged = new Map([...overridesRef.current, ...fresh]);
          overridesRef.current = merged;
          setOverrides(merged);
        }
        giveUpPending(fresh);
      },
      (err: unknown) => {
        inFlightRef.current = false;
        // A cancelled call is not a failure; this happens whenever the page changes
        if (isAbortError(err) || !aliveRef.current) return;
        // The refresh itself failed (network, 403): release everyone waiting
        giveUpPending(NO_URLS);
      },
    );
  }, [query, giveUpPending, urlNow]);

  const reportError = useCallback(
    (item: GalleryItem, variant: ShotVariant) => {
      const slot = slotOf(item.id, variant);

      // Careful: a broken image is no longer "painted". If this were not cleared, an
      //    image that loaded fine and later broke on expiry would be skipped by the
      //    refresh (as painted), so it would never get a new link and would at once show
      //    "image no longer available". That is precisely the case this whole hook
      //    exists for.
      paintedRef.current.delete(slot);

      const count = (triesRef.current.get(slot) ?? 0) + 1;
      const next = new Map(triesRef.current);
      next.set(slot, count);
      commitTries(next);

      // Careful: refresh only on the first failure. A second means even the new link
      //    failed; that is not an expiry problem, the file is missing.
      if (count === 1) refresh();
    },
    [commitTries, refresh],
  );

  const reportLoad = useCallback(
    (item: GalleryItem, variant: ShotVariant) => {
      const slot = slotOf(item.id, variant);
      paintedRef.current.add(slot);

      // On success the count resets: if the link dies again half an hour later that is
      // a **new** event, with no need to carry the old one's penalty. (`overrides` is
      // sticky, so there is no risk of reverting to an old expired link.)
      if (!triesRef.current.has(slot)) return;
      const next = new Map(triesRef.current);
      next.delete(slot);
      commitTries(next);
    },
    [commitTries],
  );

  const urlOf = useCallback(
    (item: GalleryItem, variant: ShotVariant) =>
      overrides.get(slotOf(item.id, variant)) ?? originalUrl(item, variant),
    [overrides],
  );

  const isDead = useCallback(
    (item: GalleryItem, variant: ShotVariant) =>
      (tries.get(slotOf(item.id, variant)) ?? 0) >= 2,
    [tries],
  );

  return { urlOf, isDead, reportError, reportLoad };
}
