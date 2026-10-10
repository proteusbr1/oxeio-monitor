import { translate } from '../../i18n';
import { periodLabel } from '../hours/hours.format';

const MS_PER_DAY = 86_400_000;

/** Whole days from today to the period's last day (`YYYY-MM-DD`); 0 on the day, never negative */
export function daysToCutoff(todayIso: string, endIso: string): number {
  const days = Math.round(
    (Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) /
      MS_PER_DAY,
  );
  return Math.max(0, days);
}

/** '26 Sep – 25 Oct 2026 · cutoff in 16 days' — the hours card's hint */
export function cutoffHint(
  period: { start: string; end: string },
  todayIso: string,
): string {
  const label = periodLabel(period.start, period.end);
  const count = daysToCutoff(todayIso, period.end);
  return count === 0
    ? translate('{{period}} · cutoff today', { period: label })
    : translate('{{period}} · cutoff in {{count}} days', {
        period: label,
        count,
      });
}
