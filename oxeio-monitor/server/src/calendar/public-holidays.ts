import { isRealDate, type ImportResult } from './holiday-import';

/**
 * Public holidays for any country, from free, keyless calendars. Used by the
 * setup wizard, Settings → Policies & holidays › "Public holidays" and the
 * nightly automatic update (holiday-sync.service.ts).
 *
 * · Every country: Nager.Date (https://date.nager.at), about 120 countries.
 *   Only nationwide public holidays are taken (`global` and type `Public`):
 *   regional ones (a state's own holiday) would wrongly shorten everyone's
 *   month. The owner adds regional or company days by hand.
 * · Brazil: BrasilAPI (https://brasilapi.com.br) first — the national
 *   calendar as Brazilian companies use it, Carnaval included (Nager.Date
 *   lists Carnaval only as "optional", so it would be left out). Nager.Date
 *   is the fallback when BrasilAPI is down.
 */

const BASE = process.env.PUBLIC_HOLIDAYS_URL?.trim() || 'https://date.nager.at/api/v3';
const BRASIL_API = process.env.BRASIL_API_URL?.trim() || 'https://brasilapi.com.br/api';
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

async function get<T>(path: string, fetchImpl: typeof fetch, base = BASE): Promise<T | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
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

  if (code === 'BR') {
    const brazil = await brasilApiHolidays(year, fetchImpl).catch(() => null);
    if (brazil && brazil.holidays.length > 0) return brazil;
  }

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

interface BrasilApiHoliday {
  date: string;
  name: string;
  type: string;
}

/** Brazil's national holidays from BrasilAPI — null-free: throws when unreachable */
async function brasilApiHolidays(year: number, fetchImpl: typeof fetch): Promise<ImportResult> {
  const rows = (await get<BrasilApiHoliday[]>(`/feriados/v1/${year}`, fetchImpl, BRASIL_API)) ?? [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const holidays: ImportResult['holidays'] = [];

  for (const r of rows) {
    if (r.type !== 'national') continue;
    if (!isRealDate(r.date)) {
      problems.push(`${r.date}: not a date — skipped`);
      continue;
    }
    if (seen.has(r.date)) continue;
    seen.add(r.date);
    const name = r.name.trim().slice(0, 120);
    holidays.push({ entry: { date: r.date, name, nameEn: name, approximate: false }, type: 'public' });
  }
  return { holidays, problems };
}
