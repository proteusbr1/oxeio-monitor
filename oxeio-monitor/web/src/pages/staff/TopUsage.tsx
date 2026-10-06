import type { Productivity, UsageReport, UsageTally } from '../../api/activity';
import { getTopUsage } from '../../api/activity';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Duration } from '../../components/Duration';
import { SectionHead } from '../../components/Page';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import { formatCount, formatPct } from '../../lib/format';

/**
 * D08 — top 10 apps and top 10 sites.
 *
 * Important: **sites are domain only.** The server never stores the full URL
 * and never sends the window title, so there is no attempt here to work out
 * "which page", and there should not be (hard rule of docs/09 § 4). This is
 * also stated on screen, because the employee whose data is viewed has a right
 * to know.
 *
 * Careful: app time and site time **cannot be added**: the 1 hour of
 * `youtube.com` sits inside the 3 hours of `chrome.exe`. The server's `caveat`
 * says exactly that, and it is not hidden.
 */

const TOP_LIMIT = 10;

/** Careful: the wording must match the `ScoreCard` breakdown of D07 exactly */
const CAT_LABEL: Record<Productivity | 'unknown', string> = {
  productive: 'Productive',
  neutral: 'Neutral',
  unproductive: 'Unproductive',
  unknown: 'Uncategorised',
};

/**
 * Careful: follows the mockup's `--st-*`: solid `ink` · grey · dark red · empty.
 *
 * Careful: the "Uncategorised" dot is `bg-paper`, not `bg-surface`. The card's
 *    background is already `surface`, so a surface dot would make the row look
 *    as if the dot was forgotten. (The rule is the same in the Midnight theme:
 *    paper is dark, surface lighter, so the difference survives in both themes.)
 */
const CAT_CLASS: Record<Productivity | 'unknown', string> = {
  productive: 'bg-ink',
  neutral: 'bg-ink-3/50',
  unproductive: 'bg-brand-ink',
  unknown: 'bg-paper',
};

export function TopUsage({
  employeeId,
  date,
  nonce,
}: {
  employeeId: number;
  date: string;
  nonce: number;
}) {
  const { data, error, loading, reload } = useApi(
    (signal) =>
      getTopUsage(
        { employeeId, from: date, to: date, limit: TOP_LIMIT },
        signal,
      ),
    [employeeId, date, nonce],
  );

  const nothing =
    data !== null &&
    data.apps.rows.length === 0 &&
    data.sites.rows.length === 0;

  return (
    <section>
      <SectionHead
        title="Most used"
        hint={`Top ${TOP_LIMIT} for this day`}
      />

      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} retry={reload} />
      ) : !data || nothing ? (
        <Empty
          title="No app or site records on this day"
          hint="The agent reports the foreground app once per slot. Nothing at all means either the PC or the agent wasn't running."
        />
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <UsagePanel
              title="Top Apps"
              hint="By process name"
              report={data.apps}
              emptyText="No app rows on this day"
              unitLabel="app"
            />
            {/*
              Careful: the hint must stay on screen (docs/09 § 4): the person
                 whose data is viewed has a right to know that the full URL is stored nowhere.
            */}
            <UsagePanel
              title="Top Sites"
              hint="Domains only — full URLs are never stored"
              report={data.sites}
              emptyText="No browser time found"
              unitLabel="domain"
            />
          </div>
          <Caveat>{data.caveat}</Caveat>
        </>
      )}
    </section>
  );
}

function UsagePanel({
  title,
  hint,
  report,
  emptyText,
  unitLabel,
}: {
  title: string;
  hint: string;
  report: UsageReport;
  emptyText: string;
  /**
   * **Singular**: `'app'` / `'domain'`. The plural `s` is added below, so even
   * a single domain does not produce broken English like "1 apps".
   */
  unitLabel: string;
}) {
  return (
    <Card title={title} hint={hint}>
      {report.rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-ink-3">{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {report.rows.map((row) => (
            <UsageRow key={row.key} row={row} />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line pt-2.5 text-[11.5px] text-ink-3">
        <span>
          <span className="num">{formatCount(report.distinctKeys)}</span>{' '}
          {report.distinctKeys === 1 ? unitLabel : `${unitLabel}s`} in total ·{' '}
          <Duration seconds={report.totalSec} tone="muted" />
        </span>
        {/*
          Without showing the time that fell outside the list, the "top 10" would
             look like the whole day, when it may be less than half of it.
        */}
        {report.otherSec > 0 && (
          <span>
            Outside this list{' '}
            <Duration seconds={report.otherSec} tone="muted" />
          </span>
        )}
      </div>
    </Card>
  );
}

function UsageRow({ row }: { row: UsageTally }) {
  const cat = row.category ?? 'unknown';

  return (
    <div
      className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2.5"
      title={`${row.label} · ${CAT_LABEL[cat]} · ${formatPct(row.sharePct, 1)} of time · ${formatCount(row.records)} rows`}
    >
      <span
        aria-hidden
        className={`size-2.5 rounded-[2px] border border-line ${CAT_CLASS[cat]}`}
      />

      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-ink">
            {row.label}
          </span>
          {/*
            Careful: `mixed` means several **known** categories are blended inside
               this key (github and youtube both inside chrome.exe). Showing a
               single colour dot and saying nothing would be a lie.
          */}
          {row.mixed && (
            <span className="flex-none rounded border border-line px-1 text-[10px] text-ink-3">
              Mixed
            </span>
          )}
        </div>

        <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-ink/45"
            style={{ width: `${Math.min(100, Math.max(0, row.sharePct))}%` }}
          />
        </div>
      </div>

      <Duration seconds={row.seconds} className="text-[12px] text-ink-2" />
    </div>
  );
}
