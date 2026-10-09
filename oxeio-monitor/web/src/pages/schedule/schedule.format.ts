import type {
  Breach,
  ScheduleDayView,
  ScheduleMonthView,
} from '../../api/schedule';
import { translate } from '../../i18n';
import { formatDuration } from '../../lib/format';

/** Minutes since midnight as a clock: 500 → '08:20'; the end of the day is '24:00' */
export function clockOf(min: number | null): string {
  if (min === null) return '—';
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** A length in minutes, in the app's duration format: 90 → '1h 30m' */
export function minutesText(min: number): string {
  return formatDuration(min * 60);
}

/** A balance with its sign: 70 → '+1h 10m', -12 → '−12m', 0 → '0m' */
export function signedDuration(min: number): string {
  if (min === 0) return minutesText(0);
  return `${min > 0 ? '+' : '−'}${minutesText(Math.abs(min))}`;
}

/** English keys, translated where shown */
export const BREACH_LABEL: Record<Breach, string> = {
  late: 'Late',
  early_leave: 'Left early',
  break_short: 'Short break',
  break_missing: 'No break',
  no_show: 'No activity',
};

/** A day's breaches for the Notes column, saying how late and how early */
export function breachNotes(
  day: Pick<ScheduleDayView, 'breaches' | 'lateMin' | 'earlyLeaveMin'>,
): string {
  return day.breaches
    .map((b) => {
      if (b === 'late' && day.lateMin > 0) {
        return translate('Late {{duration}}', {
          duration: minutesText(day.lateMin),
        });
      }
      if (b === 'early_leave' && day.earlyLeaveMin > 0) {
        return translate('Left early {{duration}}', {
          duration: minutesText(day.earlyLeaveMin),
        });
      }
      return translate(BREACH_LABEL[b]);
    })
    .join(' · ');
}

/** The checked schedule for the screen's header; null when none is checked */
export function scheduleLine(
  view: Pick<ScheduleMonthView, 'officeFrom' | 'officeTo' | 'requiredBreakMin'>,
): string | null {
  if (!view.officeFrom || !view.officeTo) return null;
  const range = { from: view.officeFrom, to: view.officeTo };
  return view.requiredBreakMin
    ? translate('Scheduled {{from}}–{{to}}, with a {{duration}} break', {
        ...range,
        duration: minutesText(view.requiredBreakMin),
      })
    : translate('Scheduled {{from}}–{{to}}', range);
}
