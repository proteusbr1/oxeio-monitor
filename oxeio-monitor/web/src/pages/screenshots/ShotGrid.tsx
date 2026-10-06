import { Trans } from 'react-i18next';

import type { GalleryItem } from '../../api/screenshots';
import { useT } from '../../i18n';
import { formatTime } from '../../lib/format';
import type { FreshUrls } from './useFreshUrls';

/**
 * Screenshot grid (the mockup's `.shots`).
 *
 * Careful: the column count is set by `auto-fill`, not media queries: two on a phone,
 *    four or five on a tablet, as many as fit on a large screen. Under each thumbnail
 *    are the time and the app name, the real tools for finding a shot.
 */
export function ShotGrid({
  items,
  urls,
  showName,
  onOpen,
}: {
  items: GalleryItem[];
  urls: FreshUrls;
  /** True when viewing "Everyone"; otherwise every cell would show the same name */
  showName: boolean;
  onOpen: (index: number) => void;
}) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
      {items.map((item, index) => (
        <li key={item.id}>
          <ShotTile
            item={item}
            urls={urls}
            showName={showName}
            onOpen={() => onOpen(index)}
          />
        </li>
      ))}
    </ul>
  );
}

function ShotTile({
  item,
  urls,
  showName,
  onOpen,
}: {
  item: GalleryItem;
  urls: FreshUrls;
  showName: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const dead = urls.isDead(item, 'thumb');
  const time = formatTime(item.capturedAt);

  return (
    <button
      type="button"
      onClick={onOpen}
      // Careful: the whole cell is a button. If only the image were clickable, tapping
      //    the narrow time/app strip below would do nothing and look broken.
      className="block w-full overflow-hidden rounded-lg border border-line bg-surface text-left transition hover:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
      aria-label={
        showName
          ? t('Screenshot at {{time}}, {{name}}', { time, name: item.fullName })
          : t('Screenshot at {{time}}', { time })
      }
    >
      <div className="relative aspect-[16/10] bg-paper">
        {dead ? (
          // A polite message instead of a broken icon: grey, not red, because nobody
          // did anything wrong; the file expired and was deleted (retention, ADR-006).
          <span className="absolute inset-0 grid place-items-center px-2 text-center text-[11px] text-ink-3">
            {t('Image no longer available')}
          </span>
        ) : (
          <img
            src={urls.urlOf(item, 'thumb')}
            alt=""
            // Careful: without lazy, 60 images on one page would download at once;
            //    the browser would stall for seconds and burn every token before scrolling.
            loading="lazy"
            decoding="async"
            onLoad={() => urls.reportLoad(item, 'thumb')}
            onError={() => urls.reportError(item, 'thumb')}
            className="absolute inset-0 size-full object-cover object-top"
          />
        )}

        {/* Careful: a 5-minute slot holds one shot per monitor, so say which monitor;
            otherwise it looks like the same shot arrived twice.

            Careful: the strip colour is not a token, the one exception: it sits
            **on top of the image**, and the screenshot's colours are unknown in
            advance. With `bg-surface`, the text would vanish on a light screenshot.
            So it is a theme-neutral black shade, identical in both themes. */}
        {item.monitorIndex > 0 && (
          <span className="absolute top-1 right-1 rounded bg-black/55 px-1 py-px text-[10px] text-white">
            {/* Careful: `.num` wraps only the number, for tabular-nums digits; putting
                the words in the mono font would widen the strip and cover the image */}
            <Trans
              i18nKey="Monitor <n>{{number}}</n>"
              values={{ number: item.monitorIndex + 1 }}
              components={{ n: <span className="num" /> }}
            />
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <span className="num text-[11px] font-semibold">{time}</span>
        <span className="ml-auto truncate text-[10.5px] text-ink-3">
          {/* Careful: never the full URL (ADR-013); `activeTitle` holds only the window
              title and domain, and the server guarantees that */}
          {item.activeApp ?? '—'}
        </span>
      </div>

      {showName && (
        <div className="truncate border-t border-line px-2 py-1 text-[10.5px] text-ink-2">
          {item.fullName}
        </div>
      )}
    </button>
  );
}
