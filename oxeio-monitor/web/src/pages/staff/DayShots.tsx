import { useState } from 'react';

import { getGallery, type GalleryItem } from '../../api/screenshots';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { formatTime } from '../../lib/format';
import { Lightbox } from '../screenshots/Lightbox';
import { useFreshUrls, type FreshUrls } from '../screenshots/useFreshUrls';

/**
 * The day's screenshots, on the employee's own page ([07 § 5](../../../../docs/07-Technical-Spec.md)).
 *
 * <b>Why this is needed even though a gallery page exists:</b> when someone
 * questions a day ("what happened in these 3 hours?"), the answer only comes
 * from seeing the timeline, the hourly chart and the pictures <b>together</b>.
 * If you had to go to another page and pick the staff member and date again,
 * nobody would bother cross-checking.
 *
 * Important: this call is <b>written to the audit log</b> (I08); the "who
 * viewed my screenshots" answer is built from it. So there is no polling, and
 * it is only called again when the date or employee changes.
 */
export function DayShots({
  employeeId,
  date,
  nonce,
}: {
  employeeId: number;
  date: string;
  nonce: number;
}) {
  const [open, setOpen] = useState<number | null>(null);

  // The signed-link expiry (5 minutes, I07) is handled by the **same hook**
  // as the gallery page. Re-implementing it here would eventually give two
  // different behaviours and "pictures break on one page only" bugs.
  const urls = useFreshUrls({ employeeId, date });

  const { data, error, loading, reload } = useApi(
    (signal) => getGallery({ employeeId, date }, signal),
    [employeeId, date, nonce],
  );

  if (loading && !data) return <Loading label="Loading screenshots…" />;
  if (error) return <ErrorBox error={error} retry={reload} />;

  const items = data?.items ?? [];

  if (items.length === 0) {
    return (
      <Card
        title="Screenshots"
        hint="One per 5-minute slot · 07:00–23:00 only"
      >
        <Empty
          title="No screenshots for this day"
          // Careful: saying just "nothing here" would look like a broken system.
          // The three **normal** reasons are spelled out so nobody calls IT for nothing.
          hint="Pictures are only taken while someone is working, and only between 07:00 and 23:00. A day off or an idle day has none."
        />
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Screenshots"
        hint={`${data?.total ?? items.length} this day · click to enlarge`}
      >
        {/* Careful: only the first page is shown. A day can have up to 192
            pictures (16 hours x 12). Fetching them all would flood the audit
            log and bog down the browser. The gallery page has the full set. */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {items.map((shot, i) => (
            <Thumb
              key={shot.id}
              shot={shot}
              urls={urls}
              onOpen={() => setOpen(i)}
            />
          ))}
        </div>

        {data && data.total > items.length && (
          <p className="mt-3 text-[11.5px] text-ink-3">
            Showing the first {items.length} of {data.total} — open the
            Screenshots page for the rest.
          </p>
        )}
      </Card>

      {open !== null && (
        <Lightbox
          items={items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          urls={urls}
        />
      )}
    </>
  );
}

function Thumb({
  shot,
  urls,
  onOpen,
}: {
  shot: GalleryItem;
  urls: FreshUrls;
  onOpen: () => void;
}) {
  const dead = urls.isDead(shot, 'thumb');

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${formatTime(shot.capturedAt)}${shot.activeApp ? ` · ${shot.activeApp}` : ''}`}
      className="group relative overflow-hidden rounded-md border border-line bg-paper transition hover:border-brand focus:border-brand focus:outline-none"
    >
      {dead ? (
        // Careful: the signed URL dies after 5 minutes (I07). We show the reason
        // instead of a broken icon; otherwise a tab left open for ten minutes
        // would show every picture silently broken.
        <span className="grid aspect-video place-items-center px-1 text-center text-[10px] text-ink-3">
          Picture is gone
        </span>
      ) : (
        <img
          src={urls.urlOf(shot, 'thumb')}
          alt={`Screen at ${formatTime(shot.capturedAt)}`}
          loading="lazy"
          onError={() => urls.reportError(shot, 'thumb')}
          onLoad={() => urls.reportLoad(shot, 'thumb')}
          className="aspect-video w-full object-cover"
        />
      )}

      <span className="num absolute right-1 bottom-1 rounded bg-chrome/80 px-1 text-[10px] text-white">
        {formatTime(shot.capturedAt)}
      </span>
    </button>
  );
}
