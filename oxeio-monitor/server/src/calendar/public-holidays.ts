import { isRealDate, type ImportResult } from './holiday-import';

/**
 * Public holidays for any country, from Nager.Date (https://date.nager.at) —
 * a free, keyless calendar covering about 120 countries. Used by the setup
 * wizard and by Settings → Policies & holidays › "Public holidays".
 *
 * Only nationwide public holidays are taken (`global` and type `Public`):
 * regional ones (a state's own holiday) would wrongly shorten everyone's
 * month. The owner adds regional or company days by hand.
 */

const BASE = process.env.PUBLIC_HOLIDAYS_URL?.trim() || 'https://date.nager.at/api/v3';
const TIMEOUT_MS = 10_000;

export interface PublicHolidayCountry {
  code: string;
  name: string;
}

interface NagerHoliday {
  date: string;
  localName: string;
  name: string;
  global: boolean;
  types?: string[];
}

export class PublicHolidaysError extends Error {}

async function get<T>(path: string, fetchImpl: typeof fetch): Promise<T | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${BASE}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new PublicHolidaysError(
      'The public holiday calendar could not be reached — check that this server can reach date.nager.at, or import a file instead.',
    );
  }
  // 204/404: the calendar has no data for that country or year
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) {
    throw new PublicHolidaysError(`The public holiday calendar answered HTTP ${res.status}.`);
  }
  return (await res.json()) as T;
}

/** The countries the calendar knows, sorted by name */
export async function publicHolidayCountries(
  fetchImpl: typeof fetch = fetch,
): Promise<PublicHolidayCountry[]> {
  const rows = (await get<{ countryCode: string; name: string }[]>('/AvailableCountries', fetchImpl)) ?? [];
  return rows
    .map((r) => ({ code: r.countryCode, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One country's nationwide public holidays for a year, in the shape the file
 * import produces — so the same preview and past-month rules apply. The
 * local name is kept, with the English one beside it when it differs.
 */
export async function publicHolidays(
  country: string,
  year: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ImportResult> {
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new PublicHolidaysError('The country must be a two-letter code, e.g. BR');
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new PublicHolidaysError('The year must be between 2000 and 2100');

  const rows = (await get<NagerHoliday[]>(`/PublicHolidays/${year}/${code}`, fetchImpl)) ?? [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const holidays: ImportResult['holidays'] = [];

  for (const r of rows) {
    const nationwide = r.global && (r.types ?? ['Public']).includes('Public');
    if (!nationwide) continue;
    if (!isRealDate(r.date)) {
      problems.push(`${r.date}: not a date — skipped`);
      continue;
    }
    // one holiday per date: the first name wins, the rest are reported
    if (seen.has(r.date)) {
      problems.push(`${r.date}: two holidays on one day — kept the first, skipped "${r.localName}"`);
      continue;
    }
    seen.add(r.date);
    const local = r.localName.trim() || r.name.trim();
    const name = (r.name && r.name !== local ? `${local} (${r.name})` : local).slice(0, 120);
    holidays.push({
      entry: { date: r.date, name, nameEn: r.name || local, approximate: false },
      type: 'public',
    });
  }

  if (rows.length === 0) {
    problems.push(`The calendar has no public holidays for ${code} in ${year}.`);
  }
  return { holidays, problems };
}
