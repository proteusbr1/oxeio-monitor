/**
 * Pay periods — pure rules on calendar dates (`YYYY-MM-DD`, work-zone dates).
 *
 * A period runs from the day after one cutoff to the next cutoff, inclusive:
 * with cutoff 25, 26 September – 25 October. "end" means the last day of the
 * month (the calendar month). A period always starts the day after the
 * previous one ended, so changing the cutoff never skips or repeats a day —
 * the period after the change is simply shorter or longer. (Before anything
 * was frozen, a new cutoff re-anchors the first period on today instead:
 * nothing was stated yet, so nothing can be skipped or repeated.)
 *
 * The statement goes out the day after the cutoff at the send time, once that
 * day's hours are complete.
 */

export const PAY_PERIOD_SETTING_KEY = 'payPeriod';

export type CutoffDay = number | 'end';

export interface PayPeriodConfig {
  cutoffDay: CutoffDay;
  /** 'HH:MM', work zone */
  sendTime: string;
}

export const DEFAULT_PAY_PERIOD: PayPeriodConfig = {
  cutoffDay: 'end',
  sendTime: '07:00',
};

export interface PeriodRange {
  start: string;
  end: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

function validCutoff(value: unknown): value is CutoffDay {
  return (
    value === 'end' ||
    (Number.isInteger(value) &&
      (value as number) >= 1 &&
      (value as number) <= 28)
  );
}

export function resolvePayPeriod(
  saved: Partial<PayPeriodConfig> | null,
): PayPeriodConfig {
  return {
    cutoffDay: validCutoff(saved?.cutoffDay)
      ? saved.cutoffDay
      : DEFAULT_PAY_PERIOD.cutoffDay,
    sendTime:
      typeof saved?.sendTime === 'string' && HHMM.test(saved.sendTime)
        ? saved.sendTime
        : DEFAULT_PAY_PERIOD.sendTime,
  };
}

export function payPeriodProblem(input: {
  cutoffDay: unknown;
  sendTime: unknown;
}): string | null {
  if (!validCutoff(input.cutoffDay))
    return 'The cutoff day must be from 1 to 28, or the end of the month';
  if (typeof input.sendTime !== 'string' || !HHMM.test(input.sendTime))
    return "The send time must be in 'HH:MM' format";
  return null;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function shiftMonth(yearMonth: string, by: number): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function cutoffIn(yearMonth: string, cutoff: CutoffDay): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const day =
    cutoff === 'end' ? new Date(Date.UTC(y, m, 0)).getUTCDate() : cutoff;
  return `${yearMonth}-${String(day).padStart(2, '0')}`;
}

export function cutoffOnOrAfter(date: string, cutoff: CutoffDay): string {
  const here = cutoffIn(date.slice(0, 7), cutoff);
  return here >= date
    ? here
    : cutoffIn(shiftMonth(date.slice(0, 7), 1), cutoff);
}

/** The period holding `date` — the very first period, and its re-anchoring on a new cutoff while nothing is frozen yet */
export function periodHolding(date: string, cutoff: CutoffDay): PeriodRange {
  const end = cutoffOnOrAfter(date, cutoff);
  const previous = cutoffIn(shiftMonth(end.slice(0, 7), -1), cutoff);
  return { start: addDays(previous, 1), end };
}

/** The period after one that ended on `lastEnd` */
export function periodAfter(lastEnd: string, cutoff: CutoffDay): PeriodRange {
  const start = addDays(lastEnd, 1);
  return { start, end: cutoffOnOrAfter(start, cutoff) };
}

/**
 * Minutes from a period's send moment (the day after `end`, at `sendTime`)
 * to now: negative before it. `today` and `nowMin` (minutes since midnight)
 * are the work zone's.
 */
export function minutesPastSend(
  end: string,
  today: string,
  nowMin: number,
  sendTime: string,
): number {
  const days =
    (Date.parse(`${today}T00:00:00.000Z`) -
      Date.parse(`${addDays(end, 1)}T00:00:00.000Z`)) /
    DAY_MS;
  const [h, m] = sendTime.split(':').map(Number);
  return days * 1440 + nowMin - (h * 60 + m);
}

/** `today` and `nowMin` (minutes since midnight) are the work zone's */
export function isDue(
  end: string,
  today: string,
  nowMin: number,
  sendTime: string,
): boolean {
  return minutesPastSend(end, today, nowMin, sendTime) >= 0;
}
