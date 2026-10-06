import { useMemo, useState, type ReactNode } from 'react';

import { getAttendanceReport, reportXlsxUrl } from '../../api/reports';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { Card, Stat, StatRow } from '../../components/Card';
import { MonthPicker } from '../../components/DatePicker';
import { Button, Page, SectionHead } from '../../components/Page';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import { ErrorNote } from '../../components/Field';
import { useXlsxDownload } from '../../lib/download';
import {
  formatDate,
  formatHoursAsDuration,
  formatMonth,
  monthEndOf,
  monthKeyOf,
  todayInWorkZone,
} from '../../lib/format';
import { seesEveryone } from '../../api/auth';
import { HeatGrid } from './HeatGrid';
import { buildMonthGrid, type GridSort } from './heatmap';

/**
 * Monthly progress (`/monthly`).
 *
 * Important: this is the owner's most-viewed screen, and it has one question:
 *   **who is falling short before the month ends?** So the page puts the answer on
 *   top: the furthest-behind person in the first row, and the "behind" count in the
 *   tile row. The heatmap is the explanation, not the answer.
 *
 * Careful: **the data comes from `GET /reports/attendance`, which trims to today**
 *   (`meta.clampedToToday`). So "expected by now" and "month target" are two different
 *   numbers, and both must be shown. Only showing 208 would make everyone look
 *   terribly behind on the 11th; only "so far" would hide where the month is heading.
 *
 * Careful: reports are open to both owner and manager, so nothing here is
 *   owner-only, and there is no money field in this endpoint. Staff would get a 403,
 *   so they are never allowed to make the request (see below).
 */
export function MonthlyPage() {
  const { user } = useAuth();

  // Important: for staff this screen is the colleagues' list; better to stop before
  //   catching the 403, or every visit would make a pointless server call.
  if (!seesEveryone(user?.role)) {
    return (
      <Page title="Monthly">
        <Empty
          title="You don't have access"
          hint="Everyone's monthly hours are for the owner and managers only."
        />
      </Page>
    );
  }

  return <MonthlyBoard />;
}

function MonthlyBoard() {
  const today = todayInWorkZone();
  const [month, setMonth] = useState(() => monthKeyOf(today));
  const [sort, setSort] = useState<GridSort>('pace');
  const download = useXlsxDownload();

  const from = `${month}-01`;
  const to = monthEndOf(from);

  // Careful: the whole month is requested; trimming is the server's job. Setting
  //    `to = today` ourselves would mean `meta.clampedToToday` is never true, and we
  //    could never say "asked up to the 31st, got up to the 11th".
  const { data, error, loading, reload } = useApi(
    (signal) => getAttendanceReport({ from, to }, signal),
    [from, to],
  );

  /**
   * Careful: the calendar month comes **from `data.meta.from`**, not from the
   *    `month` state. After the month changes, `useApi` still holds the old response
   *    for one frame before it starts fetching; going by state would put August's
   *    rows in September's calendar for that frame: all cells empty, as if data
   *    were lost. The grid always draws the month of its own data.
   */
  const grid = useMemo(
    () => (data ? buildMonthGrid(data, monthKeyOf(data.meta.from), sort) : null),
    [data, sort],
  );

  const actions = (
    <>
      <MonthPicker value={month} onChange={setMonth} max={monthKeyOf(today)} />
      {/*
        F05: this used to be a plain `<a href download>`, changed for two reasons:
          1. **On a 403/400 the browser silently saved a JSON file named `.xlsx`.**
             Someone opening it in Excel saw "file is corrupt", when the real
             event was "not permitted".
          2. The reports page does exactly this with fetch; the same button
             behaving differently on two pages would leave no way to tell which is
             true.
        Now both use `useXlsxDownload()`; the URL is still built by `reportXlsxUrl()`.
      */}
      <Button
        onClick={() =>
          download.start(
            reportXlsxUrl('attendance', { from, to }),
            `oxeio-attendance-${from}_${to}.xlsx`,
          )
        }
        disabled={download.busy}
        title="The file is built on the server first, then downloads"
      >
        {download.busy ? 'Preparing…' : 'Excel'}
      </Button>
    </>
  );

  return (
    <Page
      title="Monthly"
      subtitle={
        // Careful: the month name also comes from the data's `meta`, so every number on
        //    the screen speaks for the same response (see the `grid` note above)
        data
          ? `${formatMonth(monthKeyOf(data.meta.from))} · counted from ${formatDate(data.meta.from)} to ${formatDate(data.meta.to)}`
          : formatMonth(month)
      }
      actions={actions}
    >
      {/* Careful: showing the download error is the whole reason for this change;
             hiding it would bring back the old `<a>`'s silent failure */}
      {download.error && (
        <div className="mb-3">
          <ErrorNote>{download.error}</ErrorNote>
        </div>
      )}

      {loading && !data ? (
        <Loading label="Loading the month…" />
      ) : error ? (
        <ErrorBox error={error} retry={reload} />
      ) : !grid || grid.rows.length === 0 ? (
        <Empty
          title={`Nothing counted in ${formatMonth(month)} yet`}
          hint="Have staff been added, and is the agent installed on their computers? Hours start adding up from the day after the agent runs."
        />
      ) : (
        <div className="space-y-4">
          <StatRow>
            <Stat label="Staff" value={grid.totals.employees} />
            <Stat
              label="Counted so far"
              value={formatHoursAsDuration(grid.totals.creditedHours)}
            />
            <Stat
              label="Expected so far"
              value={formatHoursAsDuration(grid.totals.expectedHours)}
              tone="muted"
            />
            {/*
              Careful: only one red tile per screen, and this is it. Everything else is
                 grey/black, or red would lose its meaning.
            */}
            <Stat
              label="Behind"
              value={grid.totals.behind}
              unit={`/${grid.totals.employees}`}
              tone={grid.totals.behind > 0 ? 'attention' : 'muted'}
            />
            <Stat
              label="Everyone's monthly target"
              value={
                grid.totals.targetHoursInRange === null
                  ? '—'
                  : `${grid.totals.monthTargetEstimated ? '≈' : ''}${formatHoursAsDuration(grid.totals.targetHoursInRange)}`
              }
              tone="muted"
            />
          </StatRow>

          <div>
            <SectionHead
              title="Staff × date"
              // Careful: do not write "darker": the ramp is opacity over `--color-ink`,
              //    and `ink` is black in the light theme, white in dark. So in dark,
              //    more hours make the cell **brighter**, not darker, and the text
              //    would say the opposite. Theme-neutral wording is the only safe one.
              hint="The stronger a cell, the more hours were counted that day"
              actions={
                <SortToggle value={sort} onChange={setSort} />
              }
            />

            <Card padded={false}>
              <HeatGrid grid={grid} today={today} />
            </Card>

            {/*
              The mockup's sentence: it summarises the whole rule.
              Careful: numbers use English digits (10, 6).
            */}
            <p className="mt-3 text-xs text-ink-3">
              <b className="font-semibold text-ink-2">Hours</b> are counted, not
              days. <span className="num">10</span> hours one day and{' '}
              <span className="num">6</span> the next is fine — what matters is
              reaching the month's total target.
            </p>

            <Notices
              clamped={data?.meta.clampedToToday ?? false}
              requestedTo={data?.meta.requestedTo ?? to}
              coveredTo={data?.meta.to ?? to}
              estimated={grid.totals.monthTargetEstimated}
              excluded={data?.meta.excludedEmployees ?? []}
            />
          </div>
        </div>
      )}
    </Page>
  );
}

/**
 * Careful: **none of the three sentences may be hidden**: all three say "the number
 *    is less certain than it looks". Without them a trimmed range would make
 *    everyone look behind, and excluded employees would stay silently invisible.
 */
function Notices({
  clamped,
  requestedTo,
  coveredTo,
  estimated,
  excluded,
}: {
  clamped: boolean;
  requestedTo: string;
  coveredTo: string;
  estimated: boolean;
  excluded: string[];
}) {
  const notes: ReactNode[] = [];

  if (clamped) {
    notes.push(
      <>
        The month is not over yet. Data was requested up to{' '}
        {formatDate(requestedTo)}, but only {formatDate(coveredTo)} is covered —
        so “Expected so far” is the target up to today, not for the whole month.
      </>,
    );
  }

  if (estimated) {
    notes.push(
      <>
        A monthly target marked <span className="num">≈</span> is an estimate —
        it drops if a new public holiday is declared on any of the remaining
        days.
      </>,
    );
  }

  if (excluded.length > 0) {
    notes.push(
      <>
        {excluded.length} people are missing from this count —{' '}
        {excluded.join(', ')}. They are inactive, but their last working day is
        not on file, so no target could be set for them.
      </>,
    );
  }

  if (notes.length === 0) return null;

  return (
    <>
      {notes.map((note, i) => (
        <Caveat key={i}>{note}</Caveat>
      ))}
    </>
  );
}

/**
 * Sort order.
 * Careful: a thin red outline = brand (the selected tab), not solid red; it is not an
 *    error, only a choice.
 */
function SortToggle({
  value,
  onChange,
}: {
  value: GridSort;
  onChange: (next: GridSort) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[11.5px] text-ink-3">Sort</span>
      <Tab active={value === 'pace'} onClick={() => onChange('pace')}>
        Shortfall first
      </Tab>
      <Tab active={value === 'name'} onClick={() => onChange('name')}>
        Name
      </Tab>
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-2.5 py-1 text-[12px] font-medium transition focus:outline-none focus:ring-2 focus:ring-brand/30 ${
        active
          ? 'border-brand bg-surface text-brand-ink'
          : 'border-line bg-surface text-ink-3 hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}
