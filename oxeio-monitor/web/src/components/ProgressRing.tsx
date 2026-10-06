import { useT } from '../i18n';
import { pctOf } from '../lib/format';

/**
 * E02: progress ring.
 *
 * Careful: what the ring measures is decided by the caller, not by this
 * component. The aria-label used to be hard-coded to "monthly progress"; after
 * the live board moved the ring to today's target, that text silently lied: the
 * screen showed the day while a screen reader said "monthly". Hence `ariaLabel`.
 *
 * Careful: do not put a ring for the day's target and one for the month's on the
 * same page in the same shape; if one shape means two different things, nobody
 * trusts either.
 *
 * The ring is green: as much as has been done is green.
 *
 * The in-progress state used to be neutral `ink` (white in the dark theme), and
 * it turned green only after the target was reached. The owner saw it on screen
 * and said the white did not fit, and the reasoning holds: work done is good
 * news, even before the 8 hours are complete. A white ring read as "nothing
 * done yet".
 *
 * Careful: "done" and "in progress" must still stay distinguishable, or the moment
 * of reaching the target would be lost. So there are two steps: light green
 * (`ok/70`) while in progress, dark green once the target is reached, and the
 * circle is then complete with no gap. Color and shape together carry the news,
 * not color alone (which colour-blind users also need).
 *
 * Careful: the in-progress state used to be brand red, and that was the real
 * mistake caught in Midnight: `--color-attention` and `--color-brand` are the
 * same hex. So the difference "thin red = brand, solid red = warning" cannot be
 * seen from color, only from weight, and a 4px solid arc leans toward "warning".
 * Every working person's card would then show a red ring all day, and in two days
 * red would mean "nothing" (see the rule in index.css). Red is now only for
 * shortfall and agent off.
 */
export function ProgressRing({
  value,
  max,
  size = 46,
  label,
  ariaLabel: ariaLabelProp,
}: {
  /** Amount done (seconds or hours; any unit, as long as it is the same one). */
  value: number;
  /** Amount expected. Careful: if zero or invalid the ring shows empty, not NaN. */
  max: number;
  size?: number;
  /**
   * Centre text. Percentage if omitted.
   * Careful: `null` shows nothing; in a small ring (under 36px) the text cannot be read anyway.
   */
  label?: string | null;
  /**
   * What the progress is of: `"Today's target"`, `"This month"`. The percentage is
   * appended automatically, so write only the name here.
   */
  ariaLabel?: string;
}) {
  const t = useT();
  const ariaLabel = ariaLabelProp ?? t('Progress');
  const pct = pctOf(value, max);
  // Careful: the fill stops even above 100%; otherwise at 140% the circle would
  // start drawing again from the beginning and look like 40%.
  const shown = Math.min(100, Math.max(0, pct));
  const met = pct >= 100;

  const stroke = size < 36 ? 3 : 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - shown / 100);

  const text = label === null ? null : (label ?? `${Math.round(pct)}`);

  return (
    <div
      className="relative flex-none"
      style={{ width: size, height: size }}
      role="img"
      aria-label={t('{{label}} — {{pct}} percent', { label: ariaLabel, pct: Math.round(pct) })}
      title={t('{{label}} — {{pct}}%', { label: ariaLabel, pct: Math.round(pct) })}
    >
      {/* Rotated by -90 degrees so the fill starts at the top */}
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-line"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={`transition-[stroke-dashoffset] duration-700 ${
            met ? 'stroke-ok' : 'stroke-ok/70'
          }`}
        />
      </svg>

      {text !== null && (
        <span
          className={`num absolute inset-0 grid place-items-center font-bold ${
            met ? 'text-ink' : 'text-ink-2'
          }`}
          style={{ fontSize: size < 36 ? 9 : 10.5 }}
        >
          {text}
        </span>
      )}
    </div>
  );
}

/**
 * Thin horizontal bar: for where a ring is too much (table rows, lists).
 *
 * Careful: the color rule is exactly the ring's. On one page the same measure
 * (how much work today) appears in two shapes; if the two had different colors the
 * reader would think they said different things. So when the ring's color
 * changes, this changes with it.
 */
export function ProgressBar({
  value,
  max,
  className = '',
  ariaLabel: ariaLabelProp,
  tone = 'auto',
}: {
  value: number;
  max: number;
  className?: string;
  /** Like the ring: what the progress is of. */
  ariaLabel?: string;
  /**
   * `'ok'`: dark green from the start.
   *
   * Careful: since 17 August `'auto'` is green too, only lighter, so the difference
   * is now "dark or not", not "green or not". The meaning is exactly as before:
   * where there is no target at all, the question "done or not" does not arise
   * (work done on a day off), so there is no reason to show the bar incomplete.
   */
  tone?: 'auto' | 'ok';
}) {
  const t = useT();
  const ariaLabel = ariaLabelProp ?? t('Progress');
  const pct = pctOf(value, max);
  const shown = Math.min(100, Math.max(0, pct));
  const met = tone === 'ok' || pct >= 100;

  return (
    <div
      className={`h-1.5 overflow-hidden rounded-full bg-line ${className}`}
      role="img"
      aria-label={t('{{label}} — {{pct}} percent', { label: ariaLabel, pct: Math.round(pct) })}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-700 ${
          met ? 'bg-ok' : 'bg-ok/70'
        }`}
        style={{ width: `${shown}%` }}
      />
    </div>
  );
}

/**
 * Today's meter: three different truths, three different looks.
 *
 * `ProgressBar` knows only one story: "how much is done". But the roster has
 * three kinds of rows side by side, and they must not be confused:
 *
 * | State | Look | Meaning |
 * |---|---|---|
 * | `counted` | solid green | measured, this much work done |
 * | `zero` | dashed empty | measured, zero today |
 * | `unknown` | hatched | not measured at all (agent not installed / never responded) |
 *
 * Careful: the last two used to be the same empty bar, so "agent never installed"
 * silently became an accusation of "did nothing today". The split here is made
 * with texture, not color, so the difference survives color blindness (the lesson
 * of `TeamBars`' measured ΔE: hue cannot be relied on).
 *
 * Careful: minimum width 2px; otherwise 0.3% of work would round to zero, and
 * "a little" and "nothing" would look the same.
 */
export function TodayMeter({
  kind,
  value,
  max,
  className = '',
  ariaLabel: ariaLabelProp,
}: {
  kind: 'counted' | 'zero' | 'unknown';
  value: number;
  max: number;
  className?: string;
  ariaLabel?: string;
}) {
  const t = useT();
  const ariaLabel = ariaLabelProp ?? t("Today's target");
  if (kind !== 'counted') {
    const unknown = kind === 'unknown';
    return (
      <div
        className={`h-1.5 rounded-full ${
          unknown
            ? // hatched: "not counted at all"
              'bg-[repeating-linear-gradient(135deg,var(--color-line)_0_3px,transparent_3px_6px)]'
            : // dashed empty cell: "counted, zero"
              'border border-dashed border-line'
        } ${className}`}
        role="img"
        aria-label={
          unknown
            ? t('{{label}} — not counted yet', { label: ariaLabel })
            : t('{{label}} — nothing counted today', { label: ariaLabel })
        }
      />
    );
  }

  const pct = pctOf(value, max);
  const shown = Math.min(100, Math.max(0, pct));
  const met = pct >= 100;

  return (
    <div
      className={`h-1.5 overflow-hidden rounded-full bg-line ${className}`}
      role="img"
      aria-label={t('{{label}} — {{pct}} percent', { label: ariaLabel, pct: Math.round(pct) })}
    >
      <div
        className={`h-full min-w-[2px] rounded-full transition-[width] duration-700 ${
          met ? 'bg-ok' : 'bg-ok/70'
        }`}
        style={{ width: `${shown}%` }}
      />
    </div>
  );
}
