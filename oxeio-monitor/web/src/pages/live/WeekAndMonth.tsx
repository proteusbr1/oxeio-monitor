import { useState } from 'react';

import type { TeamTrend } from '../../api/dashboard';
import { formatDateShort, formatDuration, pctOf, weekdayOf } from '../../lib/format';
import { targetText } from './TodayRing';

/**
 * Two look-back cards for the board: **the last seven days**, and **the current month**.
 *
 * Important: the sources are `daily_summary` and `monthly_summary`, the basis of pay,
 *    which the `summary-refresh` job keeps fresh every 15 minutes.
 */

/**
 * **Seven days, and the one genuinely hard decision here.**
 *
 * Careful: days when tracking had not started are **not zero bars**; they are a
 *    dotted outline. Showing zero would make the chart claim "nobody worked that
 *    day", when the truth is **we were not watching then**. In the first week that
 *    falsehood would make the whole team look like a failure for no reason.
 *
 * Important: this is an old rule of this app, nothing new: `offline` (the employee
 *    left) and `agent_down` (the agent died) are never shown in one colour.
 *    **Calling "I do not know" "none" sends the user to the wrong action.**
 */
export function WeekBars({ days }: { days: TeamTrend['days'] }) {
  /**
   * Careful: the scale includes the target too; otherwise a light day's bar would
   *    fill the full height and the day would look excellent.
   */
  const peak = days.reduce(
    (m, d) => Math.max(m, d.workedSec, d.targetSec),
    0,
  );

  /**
   * The chosen day: **on a phone this is the only way**.
   *
   * Each bar's value used to be only in a `title` tooltip, and the bars were
   * `<div>`s. Careful: tooltips **never appear** on touch screens, and a `<div>` has
   *    nothing to tap, so on a phone the card was seven **unnamed bars**: the shape
   *    was readable, the numbers were not.
   * Important: the design is not new: `DayPulse` has exactly this (a fixed readout
   *    line plus a hit-target spanning the whole column), so it is brought here.
   */
  const [pick, setPick] = useState<string | null>(null);
  const shown = days.find((d) => d.date === pick) ?? null;

  // Careful: the total counts **only the observed days**; adding an unobserved day as
  //    0 would make the number falsely claim "this is all that was done this week".
  const seen = days.filter((d) => d.tracked);
  const seenSec = seen.reduce((s, d) => s + d.workedSec, 0);

  return (
    <div className="px-4 pt-1 pb-3">
      {/*
        One value directly, the rest by touch: the same rule as `DayPulse`. Putting a
           number on every bar would make seven labels pile on top of each other.
      */}
      <div className="mb-2 flex items-end justify-between gap-3">
        <p className="text-xs text-ink-3">
          {shown ? (
            <span className="text-ink-2">
              <span className="num font-semibold text-ink">
                {formatDateShort(shown.date)}
              </span>{' '}
              ·{' '}
              {shown.tracked ? (
                <>
                  <span className="num">{formatDuration(shown.workedSec)}</span>
                  {shown.expectedStaff === 0 && ' · day off'}
                </>
              ) : (
                'not tracked yet'
              )}
            </span>
          ) : (
            <>
              Counted{' '}
              <span className="num font-semibold text-ink">
                {formatDuration(seenSec)}
              </span>
              {/* Careful: how many days were counted is shown **only** when under seven;
                  otherwise a needless number would catch the eye every day. */}
              {seen.length < days.length && (
                <span className="text-ink-3">
                  {' '}
                  · <span className="num">{seen.length}</span> of{' '}
                  <span className="num">{days.length}</span> days tracked
                </span>
              )}
            </>
          )}
        </p>
      </div>

      <div className="relative">
        <div
          className="flex h-24 items-end gap-[3px]"
          onMouseLeave={() => setPick(null)}
        >
          {days.map((d) => {
            const h = peak > 0 ? (d.workedSec / peak) * 100 : 0;
            const off = d.expectedStaff === 0;

            return (
              <button
                key={d.date}
                type="button"
                /*
                 * Careful: the hit-target spans the full column height, not just the bar;
                 *    a 2% bar could not be aimed at with a finger.
                 * Careful: `onClick` is mandatory for phones: Safari (iOS and macOS)
                 *    **does not focus a button on tap**, so relying on `onFocus` would
                 *    do nothing there.
                 */
                className="flex h-full flex-1 cursor-default items-end focus:outline-none"
                onMouseEnter={() => setPick(d.date)}
                onFocus={() => setPick(d.date)}
                onBlur={() => setPick(null)}
                onClick={() => setPick(d.date)}
                title={
                  d.tracked
                    ? `${formatDateShort(d.date)} — ${formatDuration(d.workedSec)}${
                        off ? ' · day off' : ''
                      }`
                    : `${formatDateShort(d.date)} — not tracked yet`
                }
              >
                {d.tracked ? (
                  <span
                    className="w-full rounded-t-[4px] transition-[height,opacity] duration-500"
                    style={{
                      // Careful: 2px even at zero, or "no work" and "no such day"
                      //    would look the same.
                      height: `max(2px, ${h}%)`,
                      backgroundColor: off
                        ? 'var(--color-line)'
                        : 'var(--color-ok)',
                      // Important: when one is picked the rest are dimmed, so which bar
                      //    the number above belongs to can be seen at a glance. Without
                      //    that link on tap, where the number came from would be unclear.
                      opacity: pick === null || pick === d.date ? 1 : 0.45,
                    }}
                  />
                ) : (
                  /*
                    Careful: not filled, a **hollow outline**: instantly different to
                       the eye, and the height claims no value.
                  */
                  <span
                    className="w-full rounded-t-[4px] border border-dashed border-line"
                    style={{
                      height: '70%',
                      opacity: pick === null || pick === d.date ? 1 : 0.45,
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/*
          Important: the target line is a single thin solid line, not dashed. A dash
             would read as an "estimate" or "limit", when this is an exact number.
          Careful: the team's target varies by day (depending on whose leave it is),
             so one line cannot be drawn exactly; the most common target is shown.
        */}
        {peak > 0 && commonTarget(days) > 0 && (
          <div
            className="pointer-events-none absolute inset-x-0 border-t border-ink-3/60"
            style={{ bottom: `${(commonTarget(days) / peak) * 100}%` }}
          />
        )}
      </div>

      <div className="mt-2 flex gap-[3px]">
        {days.map((d) => (
          <span
            key={d.date}
            className="flex-1 text-center text-[10.5px] text-ink-3"
          >
            {weekdayOf(d.date).slice(0, 3)}
          </span>
        ))}
      </div>

      {/*
        Careful: **the legend was removed** (it is not in mockup A).

        Important: nothing is lost: the card's `hint` already says
        *"dashed = before tracking started"*, and the grey bar for a day off gives its
        reason in its own `title`. So the three lines were **saying the same thing a
        second time**, and the chart paid for it: sitting at the same height as the
        row's other two cards, the bars were squeezed almost unreadable.

        Careful: removing colour explanations is generally forbidden in this project
        (see the `StatusLegend` note), but that rule is about **the four status
        colours**, which cannot be guessed. Here the filled-vs-dotted difference is
        stated in a sentence in the hint, not in colour.
      */}
    </div>
  );
}

/**
 * The current month. **Here the explanation matters as much as the number.**
 *
 * Careful: pace runs from the day tracking started, not from the 1st. On the raw
 *    figures the team would have shown **1042 hours behind** in August: the number
 *    is true, the story false: all of that shortfall was 1-12 August, when there
 *    was no monitoring at all.
 *
 * Important: so the date is **written on the card**; an adjustment that became an
 *    invisible assumption would be another kind of falsehood.
 */
export function MonthCard({ month }: { month: TeamTrend['month'] }) {
  const pct = pctOf(month.creditedSec, month.targetSec);
  const ahead = month.paceSec >= 0;

  // Careful: nobody on a target (all no-target): the hours alone, with no "of 0h",
  // no percentage and no pace
  if (month.targetSec <= 0) {
    return (
      <div className="px-4 pt-1 pb-3">
        <span className="num text-2xl leading-none font-semibold">
          {formatDuration(month.creditedSec)}
        </span>
        <p className="mt-2 text-[11.5px] text-ink-3">No hours target set</p>
      </div>
    );
  }

  return (
    <div className="px-4 pt-1 pb-3">
      <div className="flex items-baseline gap-2">
        <span className="num text-2xl leading-none font-semibold">
          {formatDuration(month.creditedSec)}
        </span>
        {/*
          Careful: `targetText`, not plain `formatDuration`: 2272 hours falls on a whole
             hour, so that would write `2272h 0m`. A pointless zero minutes every day
             (see the TodayRing note).
        */}
        <span className="text-xs text-ink-3">
          of <span className="num">{targetText(month.targetSec)}</span>
        </span>
      </div>

      <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-ok transition-[width] duration-700"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11.5px]">
        <span className="text-ink-2">
          <span className="num font-semibold text-ink">{Math.round(pct)}%</span>{' '}
          of the month&rsquo;s target
        </span>
        {/*
          Careful: "behind" is **not red**, deliberately. In this theme solid red means
             "act now" (agent off, error); showing normal mid-month ups and downs in red
             would make red mean "nothing" within two days.
        */}
        <span className={ahead ? 'text-ok' : 'text-ink-2'}>
          <span className="num font-semibold">
            {formatDuration(Math.abs(month.paceSec))}
          </span>{' '}
          {ahead ? 'ahead of pace' : 'behind pace'}
        </span>
      </div>

      {month.trackedFrom && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          {/*
            Careful: no `.num` on the date: tabular figures would make it look loose,
               like `13  Aug`. Equal-width digits are only for numbers aligned in a column.
          */}
          Pace counts whole days from {formatDateShort(month.trackedFrom)}, when
          tracking started — the days before it, and today, are not counted
          against anyone.
        </p>
      )}
    </div>
  );
}

/**
 * **Top performers**: the most hours **of all time**.
 *
 * Careful: the measure is **total hours across all months**, the owner's choice. So
 *    whoever joined earlier stays **permanently** on top; no matter how well a
 *    newcomer does, they cannot catch up. The monthly view at least restarted the
 *    order every month.
 *
 * Important: so **the real hours are written beside each name**, and the bars are
 *    drawn relative to the top person. When everyone is close, the bars are nearly
 *    equal too, so the numbers themselves answer "is the ranking meaningful",
 *    with no separate warning.
 *
 * Careful: the bar is not green but neutral `ink`: this is not a target-reached
 *    calculation, just a comparison. Green would wrongly say "goal met" (the
 *    ProgressBar rule).
 */
/**
 * **Fewest hours.** The owner asked to see the names of the people who worked the
 * least, based on the last several days.
 *
 * Careful: **each name has "over how many days" beneath it, and that line is what
 * keeps this card honest.** Showing just "4 hours" would lead readers to assume the
 * person did not work, when they may have been on leave, ill, or joined last
 * Wednesday. Important: this is the project's rule: **a number that can be read
 * two ways gets, beside it, the words that prevent the misreading** (`Stat`'s `sub`).
 *
 * Careful: **there is no bar here, deliberately.** In `TopPerformers` a bar means
 * "how much compared with the top", which is harmless. But in a low-hours list a
 * long bar would be read as "how bad", and that is a verdict. Important: the card's
 * job is to raise a question ("look at these five"), not to pass judgement; the
 * reason is not on the screen anyway, it is with the person.
 *
 * Careful: the colour is neutral too, not red. Few hours is not an **alert**;
 * leave, illness and new joiners all land here.
 */
export function FewestHours({
  people,
  days,
}: {
  people: TeamTrend['laggards'];
  days: number;
}) {
  if (people.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-ink-3">
        No one to show yet — the list fills in as days are counted.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {people.map((p, i) => (
        <li
          key={p.employeeId}
          className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5"
        >
          <span className="num text-[11px] text-ink-3">{i + 1}</span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{p.fullName}</div>
            {/*
              Careful: the zero-day case is spelled out separately: reading "0 of 7 days
                 counted", the eye skips the zero, and then the person seems to "not
                 have worked" instead of "not have been there".
            */}
            <div className="mt-0.5 text-[11.5px] text-ink-3">
              {p.daysCounted === 0
                ? `Nothing counted in ${days} days`
                : `${p.daysCounted} of ${days} days counted`}
            </div>
          </div>
          <span className="num text-[13px] font-semibold">
            {formatDuration(p.creditedSec)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TopPerformers({ leaders }: { leaders: TeamTrend['leaders'] }) {
  if (leaders.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-ink-3">
        No hours counted yet — the list fills in as people work.
      </p>
    );
  }

  const top = leaders[0].creditedSec;

  return (
    <ul className="divide-y divide-line">
      {leaders.map((p, i) => (
        <li
          key={p.employeeId}
          className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5"
        >
          <span className="num text-[11px] text-ink-3">{i + 1}</span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{p.fullName}</div>
            {/*
              Important: the bar is **green** (`ok`), not white (`ink`): every other
                 chart on the board already draws "counted hours" in this colour (day
                 rhythm, last 7 days). White here would show the same thing in two
                 colours on one screen.

              Careful: this does not mean "target met"; that meaning belongs to
                 `TargetBars`, where a neutral bar **turns** green on reaching the
                 target. Here the bar is only a **ratio**: how much each person has
                 compared with the top. So long means not "good" but "more", and since
                 the number is written beside it, what the ranking stands on is
                 visible on screen.
            */}
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-ok transition-[width] duration-700"
                style={{
                  width: `${top > 0 ? (p.creditedSec / top) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
          <span className="num text-[13px] font-semibold">
            {formatDuration(p.creditedSec)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The most common daily target; the line sits at this.
 *
 * Careful: no average is taken: a day off's zero target would drag the average down,
 *    and the line would sit at a height that is true for no day.
 */
function commonTarget(days: TeamTrend['days']): number {
  const counts = new Map<number, number>();
  for (const d of days) {
    if (d.targetSec > 0) {
      counts.set(d.targetSec, (counts.get(d.targetSec) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestN = 0;
  for (const [target, n] of counts) {
    if (n > bestN) {
      best = target;
      bestN = n;
    }
  }
  return best;
}
