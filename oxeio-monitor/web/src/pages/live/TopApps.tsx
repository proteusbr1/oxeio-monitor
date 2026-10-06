import type { UsageReport } from '../../api/activity';
import { formatDuration, pctOf } from '../../lib/format';

/**
 * Today's sorted list of which apps the team spent time in.
 *
 * Important: identity is shown by name, not by colour. On this board green = fine,
 * yellow = idle, red = needs attention; all three are **status** colours. Using them
 * to colour "which app is which" would make the alert red and the chart red the same,
 * and red would no longer tell you whether to act right now.
 *
 * Careful: which other hues are safe was measured, not eyeballed (CVD simulation,
 * OKLab ΔE): blue vs purple is **1.4-5.5**, practically the same colour to
 * colour-blind eyes; blue vs orange is **24-31**, which is safe. So after removing
 * the three status colours only **two slots** are really free for identity, and
 * that is not enough to colour five apps.
 *
 * Important: so there is **one hue in opacity steps**. The order conveys bar length
 * and list position, not colour difference. This is not giving in to the colour
 * limit; it reads better: five distinct hues must be memorised, one ordering is
 * seen at a glance.
 */
export function TopApps({ usage }: { usage: UsageReport }) {
  const rows = usage.rows.slice(0, 5);

  if (rows.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-ink-3">
        No app time counted yet today.
      </p>
    );
  }

  /**
   * Careful: the denominator is **`totalSec`**, not the sum of the list. Dividing by
   *    the list would always give 100% and imply "the top 5 are everything". The
   *    "everything else" row below exists for the same reason.
   */
  const total = usage.totalSec;
  const shown = rows.reduce((s, r) => s + r.seconds, 0);
  const other = Math.max(0, total - shown);

  return (
    <ul className="flex flex-col gap-2.5 px-4 pt-1 pb-3">
      {rows.map((row, i) => (
        <li key={row.key}>
          <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="truncate">
              {row.label}
              {/*
                Careful: `mixed` means `chrome.exe` contains both YouTube and
                   documentation. Showing a single category would then be false, so
                   none is shown; it only says the contents are mixed.
              */}
              {row.mixed && (
                <span className="ml-1.5 text-[10.5px] text-ink-3">mixed</span>
              )}
            </span>
            <span className="num shrink-0 text-[11.5px] text-ink-3">
              {formatDuration(row.seconds)}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-data"
              style={{
                width: `${pctOf(row.seconds, total)}%`,
                // Important: order is the only signal; top bar solid, the rest fade
                opacity: 1 - i * 0.16,
              }}
            />
          </div>
        </li>
      ))}

      {other > 0 && (
        <li className="text-[11.5px] text-ink-3">
          <div className="flex items-baseline justify-between gap-3">
            <span>everything else</span>
            <span className="num">{formatDuration(other)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-ink-3/40"
              style={{ width: `${pctOf(other, total)}%` }}
            />
          </div>
        </li>
      )}
    </ul>
  );
}
