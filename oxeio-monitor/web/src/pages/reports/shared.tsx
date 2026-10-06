import type { ReactNode } from 'react';

import type { DayType, ReportMeta, UsageCategory } from '../../api/reports';
import { Caveat } from '../../components/States';
import {
  formatDate,
  formatDateTime,
  formatHoursAsDuration,
  parseWorkDate,
} from '../../lib/format';

/**
 * Pieces shared by the four report tabs.
 *
 * Important: showing `meta` is kept in one place because it holds two things that
 * are **the easiest to hide and the most harmful to hide**: a trimmed range
 * (`clampedToToday`) and excluded employees (`excludedEmployees`). Written
 * separately in each tab, forgetting one would have been almost certain.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * F08 — the maximum number of days in one request.
 * Careful: this number is a copy of `MAX_RANGE_DAYS` in the server's
 *    `reports/reports.range.ts`. The server returns 400 for a bigger range; it is
 *    caught here first so a request that is sure to fail is never sent.
 */
export const MAX_REPORT_DAYS = 370;

/** Number of days, both ends included. 0 if a date is invalid, not NaN. */
export function rangeDays(from: string, to: string): number {
  const start = parseWorkDate(from);
  const end = parseWorkDate(to);
  if (!start || !end) return 0;
  return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

/**
 * The range, the generation time, and everything else that needs saying.
 *
 * Careful: when `clampedToToday` is true it **must be said**. Someone who asked
 *    for "1-31 August" and got data only up to the 11th would think everyone is
 *    hugely behind, when the remaining days have simply not happened yet.
 *
 * Careful: `excludedEmployees` lists, by name, the people who could not be
 *    included. Dropping them silently would let readers assume "everyone is
 *    here" and not cross-check.
 */
export function MetaNote({ meta }: { meta: ReportMeta }) {
  return (
    <div className="mt-3">
      <p className="text-[11.5px] text-ink-3">
        <span className="num">{formatDate(meta.from)}</span> —{' '}
        <span className="num">{formatDate(meta.to)}</span> ·{' '}
        <span className="num">{meta.days}</span> days · generated{' '}
        <span className="num">{formatDateTime(meta.generatedAt)}</span>
      </p>

      {meta.clampedToToday && (
        <Caveat>
          Data was requested up to{' '}
          <b className="num">{formatDate(meta.requestedTo)}</b>, but future days
          have none — so this shows up to{' '}
          <b className="num">{formatDate(meta.to)}</b>. The targets for the
          remaining days are not added in here.
        </Caveat>
      )}

      {meta.excludedEmployees.length > 0 && (
        <Caveat>
          These <span className="num">{meta.excludedEmployees.length}</span>{' '}
          could not be included (inactive, with no last working day on file):{' '}
          {meta.excludedEmployees.join(', ')}
        </Caveat>
      )}

      {/*
        Careful: the numbers are not wrong, but they are **uncertain**, and that was
        invisible for a long time. Lunar-calendar holiday dates move after the moon is
        sighted; when they move, that month's workdays change, and with them the
        denominator of the daily target and payroll's `d ÷ D`.

        Careful: the worst moment to find out would be after the announcement moves the
        date, when the numbers have already been printed and handed out.

        Careful: the list comes from `meta`, not recounted here; recounting would
        create a second definition of uncertainty, and one day the screen and Excel
        would show two different lists.
      */}
      {meta.approximateHolidayDates.length > 0 && (
        <Caveat>
          <span className="num">{meta.approximateHolidayDates.length}</span>{' '}
          holiday date
          {meta.approximateHolidayDates.length > 1 ? 's' : ''} in this range{' '}
          {meta.approximateHolidayDates.length > 1 ? 'are' : 'is'} not final yet
          (
          {meta.approximateHolidayDates.map((d, i) => (
            <span key={d}>
              {i > 0 && ', '}
              <b className="num">{formatDate(d)}</b>
            </span>
          ))}
          ). Lunar dates move after the moon is sighted — if one moves, the
          working days for that month change, and so do the target hours and the
          payroll day fraction.
        </Caveat>
      )}
    </div>
  );
}

/**
 * Thin outline chip: day type, category, app/site.
 * Careful: **not** solid red. These are not problems, just classification.
 */
export function Pill({
  children,
  muted = false,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap ${
        muted ? 'border-line text-ink-3' : 'border-line bg-paper text-ink-2'
      }`}
    >
      {children}
    </span>
  );
}

/**
 * Adjustment hours, **with sign**.
 *
 * Careful: `<Hours>` cannot be used here. `formatDuration()` applies
 *    `Math.max(0, …)` internally, so a -1.5 hour adjustment would show as "0m", and
 *    **deducted hours would be completely invisible**. Yet `delta_sec` can well be
 *    negative (schema: "+ = hours returned, - = deducted"), and when someone's hours
 *    are deducted, that is the most important number in the report.
 *
 * Careful: zero shows `—`, not `0m`: most rows have no adjustment, and a column
 *    full of "0m" would hide the rows where there really was one.
 */
export function SignedHours({ hours }: { hours: number }) {
  if (!Number.isFinite(hours) || hours === 0) {
    return <span className="num text-ink-3">—</span>;
  }

  const negative = hours < 0;
  return (
    <span className={`num ${negative ? 'text-brand-ink' : 'text-ink-2'}`}>
      {negative ? '−' : '+'}
      {formatHoursAsDuration(Math.abs(hours))}
    </span>
  );
}

export const DAY_TYPE_LABEL: Record<DayType, string> = {
  workday: 'Workday',
  weekly_off: 'Weekly off',
  holiday: 'Holiday',
};

export const CATEGORY_LABEL: Record<UsageCategory, string> = {
  productive: 'Productive',
  neutral: 'Neutral',
  unproductive: 'Unproductive',
  uncategorized: 'Uncategorized',
};

/**
 * Careful: on a big range, rows reach the thousands (370 days x 15 people = 5550).
 *    Putting them all in the DOM would freeze the page for a few seconds, and nobody
 *    reads more than two hundred rows on screen. So the display is truncated, but
 *    **not silently**, and it also says that the whole thing is in Excel.
 */
export const MAX_SHOWN_ROWS = 500;

export function TrimmedNote({ total }: { total: number }) {
  return (
    <p className="border-t border-line px-4 py-2.5 text-[11.5px] text-ink-3">
      Showing the first <span className="num">{MAX_SHOWN_ROWS}</span> of{' '}
      <span className="num">{total}</span> rows — the full list is in the Excel
      file.
    </p>
  );
}
