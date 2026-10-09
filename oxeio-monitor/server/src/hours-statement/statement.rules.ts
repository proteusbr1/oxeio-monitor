import { payTermsForMonth } from '../payroll/payroll.math';
import { addDays, type PeriodRange } from './pay-period.rules';

export type PayBasisName = 'monthly' | 'hourly' | 'none';

export function monthsTouched(range: PeriodRange): string[] {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) {
    const month = d.slice(0, 7);
    if (out[out.length - 1] !== month) out.push(month);
  }
  return out;
}

/** The last day of a 'YYYY-MM' month */
function monthEnd(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * The days of `range` that fall in months this person was paid by the hour:
 * from the first such day to the last (a period touches at most three
 * months), or `null` when none is. A pay-basis change takes effect from a
 * month, so a period across two months may count only one of them. Reads the
 * basis only: this module never selects an amount.
 */
export function hourlyRange(
  range: PeriodRange,
  currentBasis: PayBasisName,
  slices: readonly { throughMonth: string; payBasis: PayBasisName }[],
): PeriodRange | null {
  const current = {
    payBasis: currentBasis,
    monthlySalary: null,
    hourlyRate: null,
  };
  const history = slices.map((s) => ({
    ...s,
    monthlySalary: null,
    hourlyRate: null,
  }));
  const hourly = monthsTouched(range).filter(
    (month) => payTermsForMonth(month, current, history).payBasis === 'hourly',
  );
  if (hourly.length === 0) return null;
  const first = `${hourly[0]}-01`;
  const last = monthEnd(hourly[hourly.length - 1]);
  return {
    start: first > range.start ? first : range.start,
    end: last < range.end ? last : range.end,
  };
}

export function employedRange(
  range: PeriodRange,
  joinedOn: string | null,
  leftOn: string | null,
): PeriodRange | null {
  const start = joinedOn && joinedOn > range.start ? joinedOn : range.start;
  const end = leftOn && leftOn < range.end ? leftOn : range.end;
  return start <= end ? { start, end } : null;
}

/** ISO weekday of a 'YYYY-MM-DD' date: Mon = 1 … Sun = 7 */
function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function countDays(input: {
  from: string;
  to: string;
  offDays: readonly number[];
  holidays: ReadonlySet<string>;
  leaves: ReadonlySet<string>;
  creditedByDate: ReadonlyMap<string, number>;
}): { leaveDays: number; holidayDays: number; noDataDays: number } {
  let leaveDays = 0;
  let holidayDays = 0;
  let noDataDays = 0;
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
    if (input.offDays.includes(isoWeekday(d))) continue;
    if (input.holidays.has(d)) holidayDays += 1;
    else if (input.leaves.has(d)) leaveDays += 1;
    else if ((input.creditedByDate.get(d) ?? 0) <= 0) noDataDays += 1;
  }
  return { leaveDays, holidayDays, noDataDays };
}
