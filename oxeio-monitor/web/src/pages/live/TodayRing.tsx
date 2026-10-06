import { ProgressRing } from '../../components/ProgressRing';
import { formatDuration, formatHours } from '../../lib/format';

/**
 * Ring for **today's** target (`todayWorkedSec / dailyTargetSec`).
 *
 * Important: this is a **thin wrapper** around the shared `components/ProgressRing`,
 *    not a separate SVG.
 *
 *    The whole ring used to be duplicated here for two reasons: `ProgressRing`'s doc
 *    said the ring was monthly, not daily, and its `aria-label` hardcoded "monthly
 *    progress", so screen readers called today's ring "monthly". Both are gone now:
 *    `ProgressRing` takes an `ariaLabel` prop and its doc is fixed.
 *
 * Careful: keeping the copy would put the geometry and colour rules in **two
 *    places**. That has happened before: after the colour rules changed, the live
 *    board's ring kept the old rules and the same dashboard showed two kinds of
 *    ring. With one implementation that cannot happen.
 */
export function TodayRing({
  workedSec,
  targetSec,
  size = 46,
}: {
  workedSec: number;
  /** Careful: the **server's `dailyTargetSec`**, not a hardcoded 8 hours */
  targetSec: number;
  size?: number;
}) {
  return (
    <ProgressRing
      value={workedSec}
      max={targetSec}
      size={size}
      ariaLabel="Today's target"
    />
  );
}

/**
 * The `of 8h` text under the ring, derived **from the server's `dailyTargetSec`**.
 *
 * Whole hours render as `8h`, otherwise the shared `formatDuration` (`7h 42m`).
 *    Using `formatDuration` directly would show `8h 0m`: a pointless zero
 *    minutes on every card, every day.
 *
 * Careful: `formatHours(sec, 0)` is used **only in the whole-hours branch**. It
 *    rounds, so in a 27-workday month it would turn 7h 42m into "8" and show the
 *    target wrongly. With a fraction, use `formatDuration`.
 *
 * Careful: once the shared `format.ts` gets a `formatDurationShort()`, delete this;
 *    duration formatting belongs in one place.
 */
export function targetText(targetSec: number): string {
  return targetSec % 3600 === 0
    ? `${formatHours(targetSec, 0)}h`
    : formatDuration(targetSec);
}

/**
 * Day-off marker in place of the ring, when `todayIsWorkday === false`.
 *
 * Careful: why the text is not "Weekly off"/"Holiday": `GET /live` sends only
 *    `todayIsWorkday` (a bool), **not the reason**. Writing "Holiday" for a
 *    weekly off, or "Weekly off" for a public holiday, would be the wrong word half
 *    the time, and nobody would notice. Once the server sends
 *    `'weekly_off' | 'holiday'` (reports already have `DayType`), the exact word
 *    can be shown here.
 *
 * Careful: a day off does not mean work is forbidden, so the card still shows
 *    today's hours, just without the comparison to the target.
 */
export function DayOffTag() {
  return (
    <span
      title="Weekly off or holiday — nothing is expected today"
      className="flex-none rounded-full border border-line bg-paper px-2 py-1 text-[11px] font-semibold whitespace-nowrap text-ink-3"
    >
      Day off
    </span>
  );
}
