import { useState, type CSSProperties, type ReactNode } from 'react';

import { ProgressBar } from '../../components/ProgressRing';
import { PersonCell } from '../../components/Table';
import { Hours } from '../../components/Duration';
import { formatDate, formatHoursAsDuration, weekdayOf } from '../../lib/format';
import {
  PACE_EPSILON,
  type DayCell,
  type EmployeeGridRow,
  type MonthGrid,
} from './heatmap';

/**
 * Staff x date heatmap.
 *
 * Colour depth = hours counted that day, but careful: **colour alone cannot carry
 *   everything**: colour blindness, small screens and print all make colour useless.
 *   So every cell is a `<button>`:
 *     - mouse hover: the number in `title`
 *     - finger tap / keyboard Enter: the full breakdown in the strip below
 *   With `<div>` cells there would be no way to see the number on a phone.
 *
 * Careful: **red is used very sparingly**: only for zero hours on a workday (light
 *    `brand-bg`) and in the "behind" column (`brand-ink`). Zero hours on a day off is
 *    not slacking; red there would turn the whole screen red every Friday and red
 *    would lose its meaning.
 */

/**
 * Grey-to-black ramp, for `level` 1...4 (`level` 0 = no hours at all, which has its
 * own look).
 * Careful: not hardcoded colours, but opacity over the brand token (see index.css).
 */
const RAMP = ['bg-ink/20', 'bg-ink/45', 'bg-ink/70', 'bg-ink'] as const;

/**
 * Diagonal hatch for days off.
 * Important: the hatch takes its colour from the token (`--color-line`), so it
 *   changes with the theme. A solid grey would look like a middle step of the ramp,
 *   making "day off" and "half a day's work" look the same.
 */
const OFF_PATTERN: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, var(--color-line) 0 2px, transparent 2px 5px)',
};

const DAY_TYPE_LABEL = {
  workday: 'Workday',
  weekly_off: 'Weekly off',
  holiday: 'Holiday',
} as const;

/**
 * Careful: `1st / 2nd / 3rd / 4th`: in English "since day 5" sounds robotic, and
 *    a narrow column has no room for the month name (see `partial` below).
 *    11-13 are handled separately, or it would read "11st".
 */
function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;

  const ones = day % 10;
  if (ones === 1) return `${day}st`;
  if (ones === 2) return `${day}nd`;
  if (ones === 3) return `${day}rd`;
  return `${day}th`;
}

export function HeatGrid({
  grid,
  today,
}: {
  grid: MonthGrid;
  /** Today in the work zone, so the column can be marked */
  today: string;
}) {
  // Careful: keep only the keys, not the cell objects; holding old objects after the
  //    month changes would leave a piece of data on screen that matches no new grid.
  const [picked, setPicked] = useState<{ employeeId: number; date: string } | null>(
    null,
  );

  const pickedRow = grid.rows.find((r) => r.employeeId === picked?.employeeId);
  const pickedCell = pickedRow?.cells.find((c) => c.date === picked?.date);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-medium text-ink-3"
              >
                Staff
              </th>

              {grid.days.map((date) => (
                <th
                  key={date}
                  scope="col"
                  title={`${formatDate(date)} · ${weekdayOf(date)}`}
                  className={`num px-0 py-2 text-center text-[10px] font-semibold ${
                    date === today
                      ? 'text-brand-ink'
                      : grid.officeOffDays.has(date) || grid.futureDays.has(date)
                        ? 'text-ink-3/60'
                        : 'text-ink-3'
                  }`}
                >
                  {Number(date.slice(8, 10))}
                </th>
              ))}

              <th scope="col" className="px-3 py-2 pl-5 text-right font-medium text-ink-3">
                Counted
              </th>
              <th
                scope="col"
                title="How much should have been done by today"
                className="px-3 py-2 text-right font-medium text-ink-3"
              >
                Expected
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium text-ink-3">
                Behind / Ahead
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium text-ink-3">
                Monthly target
              </th>
            </tr>
          </thead>

          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.employeeId} className="border-b border-line/70 last:border-0">
                {/*
                  Important: the behind/ahead number is **written again in this pinned
                     column**. After 31 day-columns, the numbers on the right are not
                     visible on a small screen without scrolling, yet they hold the
                     answer to the screen's one question. Written twice, knowingly.
                  Careful: narrow on phones, wide on desktop; if the pinned column took
                     more room, nothing would be left for the heatmap on a small
                     screen. To save that space the empCode is not written here; code
                     and department are in the row's `title`.
                */}
                <td
                  title={`${row.fullName} · ${row.empCode}${row.department ? ` · ${row.department}` : ''}`}
                  className="sticky left-0 z-10 w-36 max-w-36 border-r border-line bg-surface px-3 py-1 sm:w-52 sm:max-w-52"
                >
                  <PersonCell
                    fullName={row.fullName}
                    note={
                      <>
                        <Pace hours={row.paceHours} compact observed={row.observed} />
                        {/*
                          Careful: not `formatDateShort()` here. The whole grid is one
                             month, so the month name is extra, and writing
                             "since 5 August" in a narrow column would cut off the
                             shortfall number.
                        */}
                        {row.partial &&
                          ` · since the ${ordinal(Number(row.partial.from.slice(8, 10)))}`}
                      </>
                    }
                  />
                </td>

                {row.cells.map((cell) => (
                  <td key={cell.date} className="p-px">
                    <Cell
                      cell={cell}
                      fullName={row.fullName}
                      selected={
                        picked?.employeeId === row.employeeId &&
                        picked.date === cell.date
                      }
                      onPick={() =>
                        setPicked((prev) =>
                          prev?.employeeId === row.employeeId &&
                          prev.date === cell.date
                            ? null
                            : { employeeId: row.employeeId, date: cell.date },
                        )
                      }
                    />
                  </td>
                ))}

                <td className="px-3 py-1 pl-5 text-right font-semibold">
                  <Hours hours={row.creditedHours} />
                </td>
                <td className="px-3 py-1 text-right">
                  <Hours hours={row.expectedHours} tone="muted" />
                </td>
                <td className="px-3 py-1 text-right">
                  <Pace hours={row.paceHours} observed={row.observed} />
                </td>
                <td className="px-3 py-1 text-right">
                  <MonthTarget row={row} />
                </td>
              </tr>
            ))}
          </tbody>

          <tfoot className="border-t border-line bg-paper font-medium">
            <tr>
              <td className="sticky left-0 z-10 border-r border-line bg-paper px-3 py-2 text-[12px] text-ink-2">
                Everyone
                {/*
                  Who the total is **about**, right beside the total.
                  Careful: those not yet observed have expectation 0, so their whole
                     target is silently left out of the total on the right; the team
                     looks **better** than it really is behind. It could not be added
                     in: that would claim a shortfall nobody claimed.
                  Careful: at 0 the line is not rendered; otherwise it is a
                     meaningless sentence every day.
                */}
                {grid.totals.notObserved > 0 && (
                  <div className="mt-0.5 text-[11px] font-normal text-ink-3">
                    {grid.totals.notObserved} not observed yet
                  </div>
                )}
              </td>
              <td colSpan={grid.days.length} />
              <td className="px-3 py-2 pl-5 text-right">
                <Hours hours={grid.totals.creditedHours} />
              </td>
              <td className="px-3 py-2 text-right">
                <Hours hours={grid.totals.expectedHours} tone="muted" />
              </td>
              <td className="px-3 py-2 text-right">
                <Pace hours={grid.totals.creditedHours - grid.totals.expectedHours} />
              </td>
              <td className="num px-3 py-2 text-right text-ink-3">
                {grid.totals.targetHoursInRange === null
                  ? '—'
                  : `${grid.totals.monthTargetEstimated ? '≈' : ''}${formatHoursAsDuration(grid.totals.targetHoursInRange)}`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <CellDetail row={pickedRow ?? null} cell={pickedCell ?? null} />
      <Legend />
    </div>
  );
}

// ── One cell ────────────────────────────────────────────────────────────────

function Cell({
  cell,
  fullName,
  selected,
  onPick,
}: {
  cell: DayCell;
  fullName: string;
  selected: boolean;
  onPick: () => void;
}) {
  const label = cellLabel(cell, fullName);
  const off = cell.kind === 'day' && cell.dayType !== 'workday';
  const worked = cell.creditedHours > 0;

  // Important: four different states, four different looks, none relying on colour
  //   depth, so the difference can be felt even without seeing colour.
  let look = '';
  let style: CSSProperties | undefined;

  if (cell.kind === 'future') {
    look = 'border border-dashed border-line';
  } else if (cell.kind === 'outside') {
    look = 'border border-dotted border-line/60 opacity-50';
  } else if (cell.kind === 'untracked') {
    /**
     * **We were not watching that day.**
     *
     * Careful: these cells used to fall into the `!off && !worked` branch below, so
     * they got the reddish "nothing happened on a workday" tint. On one page the number
     * said "no claim" and the picture said "slacking", and people look at the picture
     * first. On this installation the agent went in on 13 August, so days 1-12 were
     * reddish on every August page.
     *
     * Important: the look is `outside`'s dotted outline, but **not faded**; the Live
     * Board's seven-day strip uses exactly this. Two looks for one thing on two
     * screens would make people learn it twice.
     * Careful: no red, no ramp; unobserved is not an accusation.
     */
    look = 'border border-dotted border-line';
  } else if (off && !worked) {
    // Careful: 0 hours on a day off is not slacking. No red, no ramp here.
    look = 'border border-line';
    style = OFF_PATTERN;
  } else if (cell.onLeave && !worked) {
    /**
     * **Approved leave.**
     *
     * Careful: this branch **must come before the red branch below**. On a leave day
     * `dayType` is `workday` (the office calendar, not one person's) and hours are 0,
     * so the cell used to get a **reddish mark** for "nothing happened on a workday".
     * The number was not lying (target 0, no shortfall), but the picture said
     * "slacking", and people look at the picture first.
     *
     * Important: the look is **close to the weekly-off cell, but not the same**: the
     * same pattern, but the outline has a faded brand tint. Merging them would make
     * "office closed" and "this person is on leave" indistinguishable.
     */
    look = 'border border-brand/30';
    style = OFF_PATTERN;
  } else if (!off && !worked) {
    // Nothing happened on a workday: the only place a cell gets a touch of red
    look = 'bg-brand-bg ring-1 ring-brand/25 ring-inset';
  } else {
    // Careful: `level` here is always 1...4 (0 would have been caught above), hence -1.
    // Work on a day off gets a thin brand-red line over the ramp (not solid)
    look = `${RAMP[cell.level - 1]} ${off ? 'ring-1 ring-brand ring-inset' : ''}`;
  }

  return (
    <button
      type="button"
      onClick={onPick}
      title={label}
      aria-label={label}
      aria-pressed={selected}
      style={style}
      /**
       * Careful: cells are large on phones (26px), 18px as before on desktop, because
       *    on a phone **this cell is the only door**: there is no hover, so there is no
       *    other way to see a day's breakdown (see the `CellDetail` note). With 18px
       *    cells the pitch would be 20px, two days under one finger, and a tap on
       *    the wrong cell would open **another day's** breakdown in the panel below.
       *    The date is written there so it can be caught, but not if nobody looks.
       * Careful: 44px (the recommended minimum) was not used: across 31 columns that
       *    is 1364px, so reading each row would take three screens of dragging. At
       *    26px the pitch is 28px, mis-taps drop a lot and the grid crosses in one or
       *    two swipes.
       * Important: desktop did not change by a single pixel; hover is enough there.
       */
      className={`block size-[26px] rounded-[3px] transition focus:outline-none focus:ring-2 focus:ring-brand/40 sm:size-[18px] ${look} ${
        selected ? 'outline outline-2 outline-offset-1 outline-ink' : ''
      }`}
    />
  );
}

function cellLabel(cell: DayCell, fullName: string): string {
  const when = `${fullName} · ${formatDate(cell.date)} (${weekdayOf(cell.date)})`;

  if (cell.kind === 'future') return `${when} · day has not arrived yet`;
  if (cell.kind === 'outside') return `${when} · outside their time here`;
  /**
   * Careful: it says not "0 hours" but **"was not being counted"**. Important: phones
   * have no hover, so this text is the only explanation for many, and this is where
   * misreading happens.
   */
  if (cell.kind === 'untracked')
    return `${when} · not being tracked yet — this day is not counted against them`;

  /**
   * Careful: phones have no hover, so the reason for leave must also be in the
   *    text; otherwise the cell's look would change and the question would remain:
   *    *"why is this day different"*.
   */
  const type = cell.onLeave
    ? 'on approved leave'
    : cell.dayType
      ? DAY_TYPE_LABEL[cell.dayType]
      : '';
  const target =
    cell.targetHours > 0
      ? `target ${formatHoursAsDuration(cell.targetHours)}`
      : 'no target';

  return `${when} · ${type} · counted ${formatHoursAsDuration(cell.creditedHours)} · ${target}`;
}

// ── The full breakdown of the chosen cell (on a phone the only way) ───────────

function CellDetail({
  row,
  cell,
}: {
  row: EmployeeGridRow | null;
  cell: DayCell | null;
}) {
  // Careful: the height is always the same; otherwise tapping a cell would make the
  //    whole grid jump and the cell under the finger would move.
  if (!row || !cell) {
    return (
      <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">
        Tap any cell — that day's full breakdown appears here.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line bg-paper px-4 py-2.5 text-xs">
      <span className="font-semibold text-ink">{row.fullName}</span>
      <span className="num text-ink-2">
        {formatDate(cell.date)} · {weekdayOf(cell.date)}
      </span>

      {cell.kind === 'future' && (
        <span className="text-ink-3">This day has not arrived yet</span>
      )}
      {cell.kind === 'outside' && (
        <span className="text-ink-3">They were not with the office that day</span>
      )}

      {cell.kind === 'day' && (
        <>
          <span className="text-ink-3">
            {cell.dayType ? DAY_TYPE_LABEL[cell.dayType] : ''}
          </span>
          <Field label="Worked" value={<Hours hours={cell.workedHours} />} />
          {cell.adjustmentHours !== 0 && (
            <Field
              label="Owner adjustment"
              value={
                <span className="num">
                  {cell.adjustmentHours > 0 ? '+' : '−'}
                  {formatHoursAsDuration(Math.abs(cell.adjustmentHours))}
                </span>
              }
            />
          )}
          <Field
            label="Counted"
            value={<Hours hours={cell.creditedHours} className="font-semibold" />}
          />
          <Field
            label="Target"
            value={
              cell.targetHours > 0 ? (
                <Hours hours={cell.targetHours} tone="muted" />
              ) : (
                <span className="text-ink-3">None</span>
              )
            }
          />
        </>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="text-ink-3">
      {label} <span className="text-ink">{value}</span>
    </span>
  );
}

// ── Behind / ahead ──────────────────────────────────────────────────────────

/**
 * Important: this one column is the real answer of the screen: "who is behind".
 * Careful: `credited - expected`, not `worked - expected`; otherwise the owner's
 *    adjustments would vanish here and a fixed shortfall would still show as one.
 */
function Pace({
  hours,
  compact = false,
  observed = true,
}: {
  hours: number;
  compact?: boolean;
  /**
   * Whether they have been observed on at least one finished workday.
   *
   * Careful: when not observed, `hours` is exactly 0, and the branch below would
   * write **"On track"**, a reassurance with not one observation behind it. This
   * happens in a new employee's first week or when someone's agent is late being
   * installed, which is exactly when the reassurance does the most harm.
   */
  observed?: boolean;
}) {
  if (!observed) {
    return (
      <span
        className="text-ink-3"
        title="No finished workday has been seen for them yet, so there is nothing to be on track with"
      >
        Not observed yet
      </span>
    );
  }

  if (Math.abs(hours) <= PACE_EPSILON) {
    return <span className="num text-ink-3">On track</span>;
  }

  const behind = hours < 0;
  const amount = formatHoursAsDuration(Math.abs(hours));

  // Careful: in a narrow column many people miss the `-`/`+` sign, so it is spelled out in words
  return (
    <span className={`num ${behind ? 'font-semibold text-brand-ink' : 'text-ink'}`}>
      {compact ? `${behind ? 'Behind' : 'Ahead'} ${amount}` : `${behind ? '−' : '+'}${amount}`}
    </span>
  );
}

function MonthTarget({ row }: { row: EmployeeGridRow }) {
  if (row.targetHoursInRange === null) {
    return (
      <span
        className="num text-ink-3"
        title="This person's target for these dates cannot be worked out yet"
      >
        —
      </span>
    );
  }

  /**
   * Careful: **0 and "none" are different**, and 0 can now really happen.
   *
   * This cell used to show the policy's flat 208, which was never 0. Now the number
   * is counted by office days, so 0 arrives legitimately when someone was on leave
   * the whole time or joined at the very end of the month.
   *
   * Important: passed to ProgressBar it would be `max={0}` and show **"0h 0m, 0%"**,
   * meaning "they failed", when the truth is they had no target at all.
   */
  if (row.targetHoursInRange === 0) {
    return (
      <span
        className="num text-ink-3"
        title="No office days for this person in these dates — on leave throughout, or joined at the very end"
      >
        No target
      </span>
    );
  }

  return (
    <span className="inline-flex items-center justify-end gap-2">
      <ProgressBar
        value={row.creditedHours}
        max={row.targetHoursInRange}
        className="w-14"
        ariaLabel="This month"
      />
      <span
        className="num text-ink-3"
        title={
          row.monthTargetEstimated
            ? 'The month is not over — the target drops if a new holiday is declared on a remaining day'
            : undefined
        }
      >
        {row.monthTargetEstimated ? '≈' : ''}
        {formatHoursAsDuration(row.targetHoursInRange)}
      </span>
    </span>
  );
}

// ── Colour legend ───────────────────────────────────────────────────────────

/**
 * Careful: do not remove. The ramp's five greys say nothing by themselves; unless
 *    "black means the day's target is met" is written somewhere, everyone would
 *    make up their own meaning.
 */
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3 text-[11px] text-ink-3">
      <span className="flex items-center gap-1.5">
        Less
        {RAMP.map((tone) => (
          <i key={tone} className={`size-3 rounded-[3px] ${tone}`} />
        ))}
        Day's target met
      </span>

      <span className="flex items-center gap-1.5">
        <i className="size-3 rounded-[3px] bg-brand-bg ring-1 ring-brand/25 ring-inset" />
        Workday, <span className="num">0</span> hours
      </span>
      <span className="flex items-center gap-1.5">
        <i className="size-3 rounded-[3px] border border-line" style={OFF_PATTERN} />
        Weekly off / holiday
      </span>
      <span className="flex items-center gap-1.5">
        <i className="size-3 rounded-[3px] bg-ink/45 ring-1 ring-brand ring-inset" />
        Worked on a day off
      </span>
      {/*
        Important: without the row in the legend the cell's look would be a puzzle,
        and people assume the worst answer to a puzzle.
      */}
      <span className="flex items-center gap-1.5">
        <i className="size-3 rounded-[3px] border border-dotted border-line" />
        Not tracked yet
      </span>
      <span className="flex items-center gap-1.5">
        <i className="size-3 rounded-[3px] border border-dashed border-line" />
        Not here yet
      </span>
      <span className="flex items-center gap-1.5">
        <i className="size-3 rounded-[3px] border border-dotted border-line/60 opacity-50" />
        Outside their time here
      </span>
    </div>
  );
}
