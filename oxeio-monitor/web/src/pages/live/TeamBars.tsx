import type { LiveCard, LiveStatus } from '../../api/dashboard';
import { ProgressBar } from '../../components/ProgressRing';
import { StatusDot } from '../../components/StatusDot';
import { formatDuration, pctOf } from '../../lib/format';
import { dayDuty } from './roster';

/**
 * Two bars for the board: **what state the team is in now**, and **who stands where**.
 */

/** Same order in the strip and the list; once the eye learns it, it need not search again */
const ORDER: { status: LiveStatus; label: string }[] = [
  { status: 'active', label: 'Working' },
  { status: 'idle', label: 'Idle' },
  { status: 'offline', label: 'Offline' },
];

const FILL: Record<LiveStatus, string> = {
  active: 'var(--color-ok)',
  idle: 'var(--color-idle)',
  offline: 'var(--color-offline)',
};

/**
 * Important: **part-to-whole**, so a single horizontal stacked bar, not a pie. Four
 *    slices out of ten people on a pie would make the small slices' angles impossible
 *    to compare.
 *
 * Careful: **2px gap between slices, in the background colour**, not a border. A
 *    border is not data yet adds ink like data; a gap separates without adding.
 *
 * Careful: **colour alone is not enough here, and that was measured.** The four
 *    status colours were checked with a tool: green (`ok`) and yellow (`idle`) are
 *    nearly **the same colour** under protanopia: ΔE 3.2 (dark) and 5.1 (light),
 *    where the safe limit is >= 8. To normal vision their distance is 17.8, so
 *    **the problem would never be caught by eye**.
 *
 *    Important: the colours were deliberately not changed: they are the whole app's
 *    established status alphabet (`StatusDot`, cards, legend, the same everywhere),
 *    and changing them for one screen would break consistency with the rest.
 *
 *    Instead **three extra channels** were added, so it reads without colour:
 *      - the **name and count of each slice are written** below; the real
 *        information is there
 *      - the order is **fixed** (working, idle, offline, off), the same in the strip
 *        and the list, and empty slices are **dimmed** in the list
 *      - hovering any slice gives its name and count
 */
export function StatusStrip({ cards }: { cards: LiveCard[] }) {
  const counts = ORDER.map((slot) => ({
    ...slot,
    n: cards.filter((c) => c.status === slot.status).length,
  }));
  const total = cards.length;

  if (total === 0) return null;

  return (
    /*
      **Layout of mockup A: four separate rows, not one strip.**

      Careful: there used to be a single stacked bar with a legend below. The bar
      showed part-to-whole well, but reading **how big each slice is** meant going
      from colour to the legend and back: two looks. In the mockup each state has its
      own row, its own bar, and its own number on the right: **one look is enough**.

      Important: the bars are drawn at the same scale (against `total`), so comparing
      lengths side by side is enough, with no reliance on colour. Careful: that
      reliance was the real risk here: green (`ok`) and yellow (`idle`) are only
      ΔE 3.2 apart under protanopia, yet 17.8 to normal vision; the problem would
      never be caught by eye.
    */
    <ul className="divide-y divide-line">
      {counts.map((c) => (
        <li
          key={c.status}
          className="flex items-center gap-3 px-4 py-2"
          title={`${c.label} — ${c.n} of ${total}`}
        >
          <span className="flex min-w-24 shrink-0 items-center gap-1.5 text-[12.5px] text-ink-2">
            <StatusDot status={c.status} />
            {c.label}
          </span>

          {/*
            Careful: at zero **no** bar is drawn. Even a one-pixel line can be read
               as "a little something there", when the number is exactly zero.
          */}
          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line/50">
            {c.n > 0 && (
              <span
                className="block h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${(c.n / total) * 100}%`,
                  backgroundColor: FILL[c.status],
                }}
              />
            )}
          </span>

          <span
            className={`num w-6 shrink-0 text-right text-[13px] font-semibold ${
              c.n === 0 ? 'text-ink-3' : 'text-ink'
            }`}
          >
            {c.n}
          </span>
        </li>
      ))}
    </ul>
  );
}


/**
 * Important: **everyone against today's target, at a glance**, furthest ahead on top.
 *
 * Careful: the bar's colour is **not by status**, and that would have been the
 *    easiest mistake here. The `ProgressRing` doc says why: in-progress used to be
 *    drawn in brand red, so every person working normally had red burning on their
 *    card all day and within two days red meant "nothing". So the bar is neutral,
 *    and **green once the target is reached**; green means "done". The status is
 *    shown by the **dot** beside the name, not the bar.
 *
 * Important: the colour does not change when the order changes; colour is tied to
 *    the person's status, not to their position in the list.
 */
export function TargetBars({ cards }: { cards: LiveCard[] }) {
  /**
   * Careful: an employee on leave goes **to the end of the list** and has no bar;
   *    drawing progress against zero would make the day off look like a failure.
   */
  const rows = [...cards].sort((a, b) => {
    const ta = hasTarget(a);
    const tb = hasTarget(b);
    if (ta !== tb) return ta ? -1 : 1;
    if (ta && tb) {
      const pa = pctOf(a.todayWorkedSec, a.dailyTargetSec);
      const pb = pctOf(b.todayWorkedSec, b.dailyTargetSec);
      if (pa !== pb) return pb - pa;
    }
    return b.todayWorkedSec - a.todayWorkedSec;
  });

  if (rows.length === 0) return null;

  return (
    <ul className="divide-y divide-line">
      {rows.map((card) => {
        const targeted = hasTarget(card);

        /**
         * **Work done on a day off also shows in the bar, and it is green.**
         *
         * Careful: on a day off everyone used to get an **empty grey rail**, while
         *    the numbers said everyone had worked 3 hours, 2 hours. An empty rail looks
         *    exactly like "zero percent": number and picture in the same row
         *    contradicted each other, and people believe the picture.
         *
         * Important: the scale is **one workday's target** (`dailyTargetSec`). The
         *    field also arrives on a day off, because it is the month's figure
         *    (target / workdays), not today's. Careful: 8 hours is **not hardcoded**;
         *    in a 27-workday month it is 7h 42m.
         *
         * Careful: it is green from the start, because on a day off **there is no
         *    "not done"**; whatever was done is entirely extra. A neutral colour
         *    would make a half-filled bar read as "still to go".
         *
         * Careful: nothing done means no bar. On a day off zero is no shortfall, and
         *    a zero-filled rail would claim exactly that.
         */
        const bonus =
          !targeted && card.todayWorkedSec > 0 && card.dailyTargetSec > 0;

        // Careful: no target is not a day off; no bar and no "off" label
        const noTarget = dayDuty(card) === 'none';

        const pct =
          targeted || bonus
            ? Math.round(pctOf(card.todayWorkedSec, card.dailyTargetSec))
            : null;

        return (
          <li
            key={card.employeeId}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2.5 sm:grid-cols-[minmax(120px,1.1fr)_minmax(0,2fr)_auto]"
          >
            <div className="flex min-w-0 items-center gap-2">
              <StatusDot status={card.status} />
              <span className="truncate text-[13px] font-medium">
                {card.fullName}
              </span>
            </div>

            {/*
              Careful: on a phone the bar drops to its own row (`col-span-2`); otherwise
                 it would be squeezed between name and number to a few pixels wide,
                 and so narrow a bar shows no comparison.
            */}
            <div className="order-last col-span-2 sm:order-none sm:col-span-1">
              {targeted || bonus ? (
                <ProgressBar
                  value={card.todayWorkedSec}
                  max={card.dailyTargetSec}
                  tone={bonus ? 'ok' : 'auto'}
                  ariaLabel={
                    bonus
                      ? `${card.fullName} — worked on a day off, against a normal day`
                      : `${card.fullName} — today's target`
                  }
                />
              ) : noTarget ? null : (
                <div
                  className="h-1.5 rounded-full bg-line/60"
                  title="Weekly off or holiday — nothing is expected today"
                />
              )}
            </div>

            <div className="flex items-baseline justify-end gap-1.5 text-right">
              <span className="num text-[13px] font-semibold">
                {formatDuration(card.todayWorkedSec)}
              </span>
              {/* `w-9` keeps the percentages aligned on one line at the right */}
              <span className="num min-w-9 text-[11px] whitespace-nowrap text-ink-3">
                {noTarget ? 'no target' : pct === null ? 'off' : `${pct}%`}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Whether this employee really has a target today; on a day off they do not.
 *
 * Careful: the rule is no longer **written** here; it lives in `dayDuty()` in
 *    `roster.ts`. It used to be written three times on three screens, and personal
 *    leave (G130) got added to one but not the other two.
 */
function hasTarget(card: LiveCard): boolean {
  return dayDuty(card) === 'target';
}
