import { useT } from '../i18n';
import {
  formatDuration,
  formatHours,
  formatHoursAsDuration,
} from '../lib/format';

/**
 * Showing a duration: seconds to `7h 32m`.
 *
 * The `.num` class (tabular-nums) is applied here. Calling `formatDuration()`
 * directly and putting the result in a `<span>` makes it easy to forget the
 * class, and then the live board's hours would jump slightly on every 30-second
 * refresh: restless to look at, and it makes the numbers feel unreliable.
 *
 * Careful: use `tone="muted"` when the time was not counted (idle, locked). Solid
 * `ink` = counted work, grey = not counted; that difference is the brand's rule.
 * (Not "black": in the Midnight theme `ink` is almost white.)
 */
export function Duration({
  seconds,
  tone = 'counted',
  className = '',
}: {
  seconds: number | null | undefined;
  tone?: 'counted' | 'muted';
  className?: string;
}) {
  const t = useT();
  const text = formatDuration(seconds);
  return (
    <span
      className={`num ${tone === 'muted' ? 'text-ink-3' : ''} ${className}`}
      title={
        seconds === null || seconds === undefined
          ? undefined
          : t('{{hours}} hours', { hours: formatHours(seconds, 2) })
      }
    >
      {text}
    </span>
  );
}

/**
 * Decimal hours to `7h 32m`.
 *
 * Careful: the reports API sends hours (`workedHours: 7.53`) while payroll sends
 * hours as a string (`'7.53'`); both work here. Without this bridge the report
 * page would show "7.53" and the live board "7h 32m", and nobody could tell they
 * were the same number.
 */
export function Hours({
  hours,
  tone = 'counted',
  className = '',
}: {
  hours: number | string | null | undefined;
  tone?: 'counted' | 'muted';
  className?: string;
}) {
  return (
    <span className={`num ${tone === 'muted' ? 'text-ink-3' : ''} ${className}`}>
      {formatHoursAsDuration(hours)}
    </span>
  );
}
