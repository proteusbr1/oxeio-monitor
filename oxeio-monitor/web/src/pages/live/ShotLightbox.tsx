import { useEffect, useRef, useState } from 'react';

import type { LiveCard } from '../../api/dashboard';
import type { GalleryItem } from '../../api/screenshots';
import { Button } from '../../components/Page';
import { formatBytes, formatDateTime } from '../../lib/format';

/**
 * E03: clicking a thumbnail shows the full image.
 *
 * `shot` comes from the parent's latest data; no copy is kept. So when "fetch
 * again" is pressed, the new URL with the new token lands here by itself. Keeping
 * the image in state would pin the expired link, and refreshing would do nothing.
 *
 * Careful: `shot` can be `null`: after a refresh that employee's image may drop
 * off the last page. The modal then says what happened instead of suddenly closing.
 */
export function ShotLightbox({
  card,
  shot,
  onClose,
  onRefresh,
}: {
  card: LiveCard;
  shot: GalleryItem | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => setBroken(false), [shot?.fullUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    // Careful: the board behind stops scrolling; on a phone, with the modal open,
    // dragging a finger would move the page below and make the image seem stuck.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    closeRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-3 sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Latest screenshot of ${card.fullName}`}
        // Careful: a click inside must not close it; closing the modal by accident
        // while looking at the image is annoying.
        onClick={(e) => e.stopPropagation()}
        /**
         * The modal covers about 92% of the screen.
         *
         * Careful: it used to be `max-w-4xl` (896px): on a wide screen a 1920x1080
         * screenshot was shrunk to 896px with lots of empty space around, and the text in
         * the image could not be read. Now it is `92vw` (capped at 1800px so it does not
         * become absurdly big on ultrawide; on a 1920px screen the cap does not bind and
         * the full 92% applies).
         */
        className="flex max-h-[92vh] w-[92vw] max-w-[1800px] flex-col overflow-hidden rounded-xl border border-line bg-surface"
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[13.5px] font-semibold tracking-tight">
              {card.fullName}
            </h2>
            <p className="truncate text-[11.5px] text-ink-3">
              <span className="num">{card.empCode}</span>
              {shot ? ` · ${formatDateTime(shot.capturedAt)}` : ''}
              {shot && shot.monitorIndex > 0
                ? ` · Monitor ${shot.monitorIndex + 1}`
                : ''}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={onRefresh}>Fetch again</Button>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink-2 transition hover:border-brand hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-paper">
          {!shot ? (
            <p className="px-6 py-14 text-center text-sm text-ink-3">
              This shot is no longer in the latest set. Every shot from the day
              is on the Screenshots page.
            </p>
          ) : broken ? (
            <div className="px-6 py-14 text-center">
              <p className="text-sm text-ink-2">Link expired (5 minutes)</p>
              <p className="mt-1 text-xs text-ink-3">
                Image links are made to be short-lived — “Fetch again” gets a
                fresh one.
              </p>
            </div>
          ) : (
            <img
              src={shot.fullUrl}
              alt={`Latest screenshot of ${card.fullName}`}
              onError={() => setBroken(true)}
              /**
               * Careful: this used to be `h-auto w-full`, with no limit at all. `w-full` always
               * stretched the image to the container's full width and the height grew
               * proportionally as far as it liked. On a wide screen a 1920x1080 image overflowed
               * the container and had to be scrolled.
               *
               * The Gallery's lightbox had a different rule: the two lightboxes ran on two
               * rules, and that was the real root. Now both use the same viewport-based limit.
               *
               * Careful: `w-auto`: small images are not stretched up by force; otherwise a
               * thumbnail would swell up blurry.
               */
              style={{ maxHeight: 'calc(92vh - 7rem)' }}
              className="mx-auto block h-auto w-auto max-w-full object-contain"
            />
          )}
        </div>

        {shot && (
          <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 text-[11.5px] text-ink-3">
            {shot.activeApp && <span className="truncate">{shot.activeApp}</span>}
            {/* Careful: only the window title and the domain; the full URL is never
                stored (section 7) */}
            {shot.activeTitle && (
              <span className="min-w-0 flex-1 truncate" title={shot.activeTitle}>
                {shot.activeTitle}
              </span>
            )}
            <span className="num ml-auto">
              {shot.width && shot.height ? `${shot.width}×${shot.height} · ` : ''}
              {formatBytes(shot.sizeBytes)}
            </span>
          </footer>
        )}
      </div>
    </div>
  );
}
