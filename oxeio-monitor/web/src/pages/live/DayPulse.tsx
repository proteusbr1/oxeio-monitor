import { useState } from 'react';

import type { TeamHour } from '../../api/dashboard';
import { formatDuration } from '../../lib/format';

/**
 * E01: the day's rhythm: how much the whole team worked across 24 hours.
 *
 * Why columns, not a line: the data is bucketed (each hour is a sum), not a
 * sample of a continuous signal. A line would claim "at 10:30 the value was this
 * much", and the data has no answer to that question. Columns say exactly as
 * much as is known.
 *
 * Careful: a single axis. The `people` number (how many) is not drawn, only in
 * the hover. Putting two different measures on two axes in one chart is the
 * best-known lie in charting: where the two lines cross means nothing, yet looks meaningful.
 *
 * The color is green (`ok`), and not arbitrarily: in this system green means
 * "work is happening", and this chart measures exactly that. There is one
 * series, so no legend: the title says what is drawn.
 */
export function DayPulse({
  hours,
  /** The current hour in the work zone, 0-23; `null` if not known. */
  currentHour,
}: {
  hours: TeamHour[];
  currentHour: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const peak = hours.reduce((m, h) => Math.max(m, h.activeSec), 0);
  const peakHour = hours.find((h) => h.activeSec === peak && peak > 0) ?? null;

  /**
   * Careful: when the whole day is zero the chart is not shown at all: 24 zero
   * columns say nothing and only make the page look broken. This is exactly what
   * happened when opening the board at midnight.
   */
  if (peak === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-ink-3">
        No work counted yet today — the shape of the day fills in as people work.
      </p>
    );
  }

  const shown = hover !== null ? hours[hover] : null;

  return (
    <div className="px-4 pt-1 pb-3">
      {/*
        The maximum is written in the title row: putting a number on every column
           would be unreadable clutter. One value directly,
           the rest on hover.
      */}
      <div className="mb-2 flex items-end justify-between gap-3">
        <p className="text-xs text-ink-3">
          {shown ? (
            <span className="text-ink-2">
              <span className="num font-semibold text-ink">
                {hourLabel(shown.hour)}
              </span>{' '}
              · <span className="num">{formatDuration(shown.activeSec)}</span> ·{' '}
              <span className="num">{shown.people}</span>{' '}
              {shown.people === 1 ? 'person' : 'people'}
            </span>
          ) : (
            <>
              Busiest hour{' '}
              <span className="num font-semibold text-ink">
                {peakHour ? hourLabel(peakHour.hour) : '—'}
              </span>{' '}
              · <span className="num">{formatDuration(peak)}</span>
            </>
          )}
        </p>
      </div>

      {/*
        Careful: `items-end`: columns grow from the baseline, otherwise height
           comparison would be false.
        The gap is 2px, in the background color: the gap separates adjacent columns,
           not a border. A border would carry data-like weight without being data ink.
      */}
      <div
        className="flex h-24 items-end gap-[2px]"
        onMouseLeave={() => setHover(null)}
      >
        {hours.map((h) => {
          const pct = (h.activeSec / peak) * 100;
          const isNow = currentHour === h.hour;
          const isHover = hover === h.hour;

          return (
            <button
              key={h.hour}
              type="button"
              // Careful: the hit target spans the column's full height, not just the bar;
              // otherwise the mouse could not aim at a 2%-high early-morning bar.
              className="group relative flex h-full flex-1 cursor-default items-end focus:outline-none"
              onMouseEnter={() => setHover(h.hour)}
              onFocus={() => setHover(h.hour)}
              onBlur={() => setHover(null)}
              /*
               * Careful: for phones, neither `onMouseEnter` nor `onFocus` can be relied on
               * there. Safari (iOS and macOS) does not give focus on a button tap, and a
               * synthetic `mouseenter` varies by browser. So the top row would stay stuck on
               * the "busiest hour" for good, and there would be no way to see the other 23
               * hours' numbers on a phone, even though the hit target was made full-column
               * precisely with touch in mind.
               */
              onClick={() => setHover(h.hour)}
              aria-label={`${hourLabel(h.hour)} — ${formatDuration(h.activeSec)}, ${h.people} people`}
            >
              <span
                className="w-full rounded-t-[4px] transition-[height,opacity] duration-500"
                style={{
                  // Careful: not zero: 1px is kept, otherwise "nobody worked" and "the hour
                  // does not exist" would look the same.
                  height: h.activeSec === 0 ? 1 : `max(2px, ${pct}%)`,
                  backgroundColor:
                    h.activeSec === 0
                      ? 'var(--color-line)'
                      : 'var(--color-ok)',
                  opacity: isHover || isNow || hover === null ? 1 : 0.45,
                }}
              />
              {/*
                The current hour is marked with a thin line below: on the live
                   board the question "where are we in the day" is always present.
              */}
              {isNow && (
                <span className="absolute inset-x-0 -bottom-[3px] h-[2px] rounded-full bg-ink" />
              )}
            </button>
          );
        })}
      </div>

      {/*
        Careful: 24 hour labels do not fit side by side, so one every six hours.
           Showing all would make the labels overlap on a phone.
      */}
      <div className="mt-2 flex justify-between text-[10.5px] text-ink-3">
        {[0, 6, 12, 18, 23].map((h) => (
          <span key={h} className="num">
            {hourLabel(h)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** `09:00`: work-zone local hour, two digits. */
function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}
