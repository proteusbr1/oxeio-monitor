/**
 * What a work policy's numbers come to in a real month — for the policy
 * form, before anything is saved.
 *
 * The daily target is `monthly hours ÷ expected workdays`, and a month's
 * target is that times the month's actual workdays. When "Expected workdays"
 * does not match the weekly days off, the month quietly lands somewhere else:
 * 208 h over 26 expected workdays with Sat + Sun off gives 8 h/day × 22 days
 * = 176 h, not the 208 h on the form. Nothing would say so until the reports looked wrong.
 *
 * ⚠️ Holidays are not counted here (the form does not load them), so the
 *    real month can come out a few days shorter. The preview says so.
 */

/** Days in `yearMonth` (`YYYY-MM`) that are not weekly days off (ISO 1–7) */
export function workdaysInMonth(
  yearMonth: string,
  offDays: readonly number[],
): number {
  const [y, m] = yearMonth.split('-').map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return 0;

  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= days; d++) {
    const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (!offDays.includes(js === 0 ? 7 : js)) count++;
  }
  return count;
}

export interface TargetPreview {
  /** Workdays this month with the chosen days off, before holidays */
  workdays: number;
  /** monthly hours ÷ expected workdays */
  dailyHours: number;
  /** what the month's target actually comes to: workdays × daily hours */
  monthHours: number;
  /** the form's numbers disagree with the calendar */
  mismatch: boolean;
}

/** `null` while the numbers on the form are not usable yet */
export function targetPreview(input: {
  yearMonth: string;
  monthlyTargetHours: number;
  expectedWorkdays: number;
  offDays: readonly number[];
}): TargetPreview | null {
  const { monthlyTargetHours, expectedWorkdays } = input;
  if (!(monthlyTargetHours > 0) || !(expectedWorkdays > 0)) return null;

  const workdays = workdaysInMonth(input.yearMonth, input.offDays);
  const dailyHours = monthlyTargetHours / expectedWorkdays;
  return {
    workdays,
    dailyHours,
    monthHours: workdays * dailyHours,
    mismatch: workdays !== expectedWorkdays,
  };
}

/** The policy card's one-line answer to "what counts as worked time" (an English key) */
export function measureSummary(
  measure: 'active' | 'presence',
  gapMin: number,
): string {
  return measure === 'presence'
    ? `Presence (pauses up to ${gapMin} min count)`
    : 'Active time';
}

/**
 * The measure fields of a policy save. The gap field is hidden under active
 * time unless the schedule is checked (the check merges pauses by the gap), so
 * otherwise an active save keeps the saved gap (or the 15-minute default)
 * rather than whatever the hidden field holds — an empty field would send 0
 * and fail.
 */
export function measureBody(
  measure: 'active' | 'presence',
  gapMin: string,
  savedGapMin: number | undefined,
  scheduleChecked = false,
): { hoursMeasure: 'active' | 'presence'; presenceGapMin: number } {
  return {
    hoursMeasure: measure,
    presenceGapMin:
      measure === 'presence' || scheduleChecked
        ? Number(gapMin)
        : (savedGapMin ?? 15),
  };
}
