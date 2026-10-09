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

/**
 * Paid by the hour in any month the period touches. Reads the basis only:
 * this module never selects an amount.
 */
export function hourlyInPeriod(
  months: readonly string[],
  currentBasis: PayBasisName,
  slices: readonly { throughMonth: string; payBasis: PayBasisName }[],
): boolean {
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
  return months.some(
    (month) => payTermsForMonth(month, current, history).payBasis === 'hourly',
  );
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
