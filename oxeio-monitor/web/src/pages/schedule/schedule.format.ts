import type { Breach } from '../../api/schedule';

/** Minutes since midnight as a clock: 500 → '08:20'; the end of the day is '24:00' */
export function clockOf(min: number | null): string {
  if (min === null) return '—';
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** A balance with its sign: 70 → '+1h10', -12 → '−12min', 0 → '0' */
export function signedDuration(min: number): string {
  if (min === 0) return '0';
  const sign = min > 0 ? '+' : '−';
  const abs = Math.abs(min);
  return abs < 60
    ? `${sign}${abs}min`
    : `${sign}${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, '0')}`;
}

/** English keys, translated where shown */
export const BREACH_LABEL: Record<Breach, string> = {
  late: 'Late',
  early_leave: 'Left early',
  break_short: 'Short break',
  break_missing: 'No break',
  no_show: 'No activity',
};
