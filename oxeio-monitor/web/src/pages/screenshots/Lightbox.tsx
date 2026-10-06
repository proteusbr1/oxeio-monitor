import { useEffect, useRef, useState } from 'react';

import type { GalleryItem } from '../../api/screenshots';
import {
  formatBytes,
  formatCount,
  formatDate,
  formatTime,
  workDateOf,
} from '../../lib/format';
import type { FreshUrls } from './useFreshUrls';

/**
 * Lightbox: full-size image, ← → for previous/next, Esc to close.
 *
 * Important: **the component is mounted only while open** (`{open && <Lightbox/>}`),
 * so the `[]` deps of the effects below mean "every time it opens". A hidden
 * (`hidden`) component would need hand-kept bookkeeping for scroll lock and focus
 * restore, and forgetting one would leave the page unscrollable forever.
 *
 * Careful: unless all three of these are done together, keyboard navigation and
 *    page scroll misbehave:
 *      - lock scrolling of the page behind, or pressing ↓ would move the grid
 *        behind the image
 *      - trap focus in the lightbox, or Tab would reach a button behind it and
 *        ← → would stop working (with no error)
 *      - on close, return focus to where it came from
 */

/** For the Tab trap: excludes `tabindex="-1"` (the wrapper itself) */
const FOCUSABLE =
  'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  urls,
}: {
  items: GalleryItem[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
  urls: FreshUrls;
}) {
  const item = items[index];
  const dialogRef = useRef<HTMLDivElement>(null);

  /**
   * Careful: instead of a `ready` state, this keeps "which src has loaded". With a
   *    plain state, after the image changed `ready=true` would linger for one render
   *    and the new image would show the old one's name.
   */
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  const src = urls.urlOf(item, 'full');
  const dead = urls.isDead(item, 'full');
  const ready = loadedSrc === src;

  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  // ── Keyboard ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (index > 0) onIndex(index - 1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (index < items.length - 1) onIndex(index + 1);
        return;
      }
      if (event.key === 'Tab') trapTab(event, dialogRef.current);
    };

    // Careful: on document, in the capture phase. An `onKeyDown` inside the component
    //    would silently stop ← → working if focus ever left (e.g. coming back from
    //    the browser address bar).
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [index, items.length, onIndex, onClose]);

  // ── Scroll lock and focus ────────────────────────────────────────────
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Careful: remember the previous value. If someone else (a future drawer) has
    //    already locked scroll, closing this would unlock theirs too.
    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${item.fullName}, screenshot at ${formatTime(item.capturedAt)}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/85 outline-none"
    >
      <header className="flex items-center gap-3 px-3 py-2.5 text-white">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">
            {item.fullName}
            <span className="ml-1.5 text-[11.5px] text-white/55">
              {item.empCode}
            </span>
          </div>
          {/* Careful: `.num` goes **only** on the clock digits. The date contains a month
              name ("10 August 2026"); making all of it `.num` would put the month name in
              the mono font too, and the words would spread out like a telegram in
              tabular-nums's equal-width characters. Digits are mono, words are not. */}
          <div className="text-[11.5px] text-white/55">
            {formatDate(workDateOf(item.capturedAt))}
            {' · '}
            <span className="num">{formatTime(item.capturedAt)}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto rounded-md border border-white/20 px-2.5 py-1.5 text-xs text-white/85 transition hover:border-brand hover:text-white focus:outline-none focus:ring-2 focus:ring-brand/40"
        >
          Close ✕
        </button>
      </header>

      {/* Careful: clicking the empty space around the image closes it, but clicking the
          image does not. Without the `e.target === e.currentTarget` check, clicking the
          image would close the lightbox, and zooming would keep kicking you out. */}
      <div
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        className="relative grid min-h-0 flex-1 place-items-center px-3"
      >
        {dead ? (
          <p className="max-w-sm text-center text-[13px] text-white/70">
            Image no longer available
            <span className="mt-1 block text-[11.5px] text-white/45">
              The expired link was fetched again, but the file still wasn't
              there.
            </span>
          </p>
        ) : (
          <>
            {!ready && (
              <span
                aria-hidden
                className="absolute size-5 animate-spin rounded-full border-2 border-white/25 border-t-brand"
              />
            )}
            <img
              // Careful: when `key` changes, React drops the old <img> and mounts a new
              //    one. Otherwise the old image would stay on screen until the new one
              //    loaded, and ← → would seem to do nothing.
              key={src}
              src={src}
              alt={`${item.fullName}, screenshot at ${formatTime(item.capturedAt)}`}
              decoding="async"
              onLoad={() => {
                setLoadedSrc(src);
                urls.reportLoad(item, 'full');
              }}
              onError={() => urls.reportError(item, 'full')}
              /**
               * Careful: **`max-h-full` blocks nothing here**, and nobody can tell by
               *    reading the classes, which is why the bug lasted so long.
               *
               *    A percentage `max-height` only works when the parent's height is
               *    "definite". The cell is `grid` + `place-items-center`, and with
               *    `align-items: center` the item takes its size from its content;
               *    "100% of what?" becomes circular, so the browser **ignores the
               *    limit**.
               *
               *    Careful: so `object-contain` is useless too: a 1920x1080 image
               *    on an 855px screen ended up **1067px** tall (measured), overflowed
               *    the 723px cell, covered the whole screen and pushed the footer and
               *    the ← → buttons out of view.
               *
               *    Important: hence a **viewport-based** limit. It depends on no
               *    parent, so it will not break if someone changes the wrapper's
               *    layout. `100dvh` stays correct when a mobile address bar hides or
               *    shows, and 11rem is the space for header + footer.
               */
              style={{ maxHeight: 'calc(100dvh - 11rem)' }}
              className={`max-w-full object-contain transition-opacity ${
                ready ? 'opacity-100' : 'opacity-0'
              }`}
            />
          </>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-white">
        <button
          type="button"
          onClick={() => onIndex(index - 1)}
          disabled={!hasPrev}
          className={NAV_BUTTON}
        >
          ◀ Previous
        </button>
        <button
          type="button"
          onClick={() => onIndex(index + 1)}
          disabled={!hasNext}
          className={NAV_BUTTON}
        >
          Next ▶
        </button>

        <span className="num text-[11.5px] text-white/55">
          {formatCount(index + 1)} / {formatCount(items.length)}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-white/55">
          {/* Show slot and capture time separately; this conveys that the shot was
              taken at a **random moment** within the 5-minute slot, not on the clock */}
          <span>
            Slot <span className="num">{formatTime(item.slotStart)}</span> ·
            captured{' '}
            <span className="num">{formatTime(item.capturedAt)}</span>
          </span>
          {item.monitorIndex > 0 && (
            <span>
              Monitor <span className="num">{item.monitorIndex + 1}</span>
            </span>
          )}
          {/* Careful: resolutions get no thousands comma; `formatCount` would give
              "1,920×1,080", which nobody recognises as a resolution */}
          {item.width !== null && item.height !== null && (
            <span className="num">
              {item.width}×{item.height}
            </span>
          )}
          {item.sizeBytes !== null && (
            <span className="num">{formatBytes(item.sizeBytes)}</span>
          )}
        </div>

        <p className="w-full text-[11px] text-white/40">
          {/* Careful: the full URL is never stored; what you see here is the window
              title, at most the domain (ADR-013) */}
          {item.activeApp ?? '—'}
          {item.activeTitle ? ` · ${item.activeTitle}` : ''}
          <span className="ml-2 hidden sm:inline">
            ← → previous/next · Esc to close
          </span>
        </p>
      </footer>
    </div>
  );
}

const NAV_BUTTON =
  'rounded-md border border-white/20 px-2.5 py-1.5 text-xs text-white/85 transition hover:border-brand hover:text-white focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-white/20';

/**
 * Focus cycles inside the lightbox only.
 *
 * Careful: if there is nothing focusable inside (theoretically), Tab returns to the
 *    wrapper; otherwise focus would go to the page behind and the user would not
 *    know where they are.
 */
function trapTab(event: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;

  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (nodes.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }

  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  const inside = active instanceof Node && root.contains(active);

  if (!inside) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
