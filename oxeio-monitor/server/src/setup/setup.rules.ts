/**
 * First-run setup: the defaults a new install starts from, by country, and
 * the rules for what the wizard sends. Everything here can be changed later
 * on Settings; the wizard only has to get a company going.
 */

/** ISO weekdays: 1 = Monday … 7 = Sunday */
const FRIDAY = 5;
const SATURDAY = 6;
const SUNDAY = 7;

/** Countries whose weekend is not Saturday + Sunday */
const WEEKEND_BY_COUNTRY: Record<string, number[]> = {
  BD: [FRIDAY],
  IR: [FRIDAY],
  AF: [FRIDAY],
  SA: [FRIDAY, SATURDAY],
  EG: [FRIDAY, SATURDAY],
  QA: [FRIDAY, SATURDAY],
  KW: [FRIDAY, SATURDAY],
  BH: [FRIDAY, SATURDAY],
  OM: [FRIDAY, SATURDAY],
  JO: [FRIDAY, SATURDAY],
  IL: [FRIDAY, SATURDAY],
  DZ: [FRIDAY, SATURDAY],
  IQ: [FRIDAY, SATURDAY],
  LY: [FRIDAY, SATURDAY],
  SY: [FRIDAY, SATURDAY],
  YE: [FRIDAY, SATURDAY],
  NP: [SATURDAY],
};

export interface WorkRules {
  monthlyTargetHours: number;
  expectedWorkdays: number;
  weeklyOffDays: number[];
}

/** A sensible starting point for a country: 8-hour days, its usual weekend */
export function defaultWorkRules(country: string | null): WorkRules {
  const code = country?.toUpperCase() ?? '';
  const off = WEEKEND_BY_COUNTRY[code] ?? [SATURDAY, SUNDAY];
  const workdays = Math.round(((7 - off.length) * 52) / 12);
  return { monthlyTargetHours: workdays * 8, expectedWorkdays: workdays, weeklyOffDays: off };
}

export function checkCountry(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error('The country must be a two-letter code, e.g. BR');
  return code;
}

export function checkOrganizationName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new Error('The company name needs at least 2 characters');
  if (name.length > 80) throw new Error('The company name can have at most 80 characters');
  return name;
}

export function checkWorkRules(input: Partial<WorkRules>, fallback: WorkRules): WorkRules {
  const hours = input.monthlyTargetHours ?? fallback.monthlyTargetHours;
  const days = input.expectedWorkdays ?? fallback.expectedWorkdays;
  const off = [...new Set(input.weeklyOffDays ?? fallback.weeklyOffDays)].sort((a, b) => a - b);
  if (!(hours >= 1 && hours <= 744)) throw new Error('Monthly hours must be between 1 and 744');
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error('Workdays per month must be a whole number from 1 to 31');
  if (off.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new Error('Days off are weekdays 1 (Monday) to 7 (Sunday)');
  if (off.length > 6) throw new Error('At least one working day a week is needed');
  return { monthlyTargetHours: hours, expectedWorkdays: days, weeklyOffDays: off };
}
