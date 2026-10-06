/**
 * Choices and previews for Settings → Region — pure, so they can be tested.
 * The server checks every value again; these lists only keep the screen
 * from offering what it would refuse.
 */

/** Minutes east of UTC for `timeZone` on a date, from the browser's Intl */
function offsetOn(timeZone: string, date: Date): number | null {
  try {
    const name =
      new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
        .formatToParts(date)
        .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
    if (!m) return null;
    if (!m[1]) return 0;
    const minutes = Number(m[2]) * 60 + Number(m[3]);
    return m[1] === '-' ? -minutes : minutes;
  } catch {
    return null;
  }
}

/** `+06:00`, `-03:00` */
export function offsetLabel(minutes: number): string {
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${minutes < 0 ? '−' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Zones without daylight saving — the only ones the server takes (every
 * date is cut with one fixed offset). `year` defaults to now.
 */
export function fixedOffsetZones(
  all: readonly string[],
  year = new Date().getUTCFullYear(),
): { value: string; label: string }[] {
  const jan = new Date(Date.UTC(year, 0, 1, 12));
  const jul = new Date(Date.UTC(year, 6, 1, 12));
  return all
    .map((zone) => ({ zone, a: offsetOn(zone, jan), b: offsetOn(zone, jul) }))
    .filter((z) => z.a !== null && z.a === z.b)
    .map((z) => ({
      value: z.zone,
      label: `${z.zone.replace(/_/g, ' ')} (UTC${offsetLabel(z.a!)})`,
    }));
}

/** Currencies with two decimal places — amounts are stored in hundredths */
export function twoDecimalCurrencies(
  all: readonly string[],
): { value: string; label: string }[] {
  return all.flatMap((code) => {
    try {
      const f = new Intl.NumberFormat('en', {
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol',
      });
      if (f.resolvedOptions().maximumFractionDigits !== 2) return [];
      const symbol =
        f.formatToParts(0).find((p) => p.type === 'currency')?.value ?? code;
      return [
        { value: code, label: symbol === code ? code : `${code} — ${symbol}` },
      ];
    } catch {
      return [];
    }
  });
}

/** A short, common list; anything else the server accepts can still be set in .env */
export const LOCALE_CHOICES: readonly { value: string; label: string }[] = [
  { value: '', label: "oXeio's own — 10 August 2026 · 13,000.50" },
  { value: 'pt-BR', label: 'Brazil — 10/08/2026 · 13.000,50' },
  { value: 'en-US', label: 'United States — 08/10/2026 · 13,000.50' },
  { value: 'en-GB', label: 'United Kingdom — 10/08/2026 · 13,000.50' },
  { value: 'en-IN', label: 'India — 10/08/2026 · 13,000.50' },
  { value: 'es-ES', label: 'Spain — 10/08/2026 · 13.000,50' },
  { value: 'pt-PT', label: 'Portugal — 10/08/2026 · 13 000,50' },
  { value: 'fr-FR', label: 'France — 10/08/2026 · 13 000,50' },
  { value: 'de-DE', label: 'Germany — 10.08.2026 · 13.000,50' },
];

/** Intl's lists, when the browser has them (all current ones do) */
export function supportedValues(kind: 'timeZone' | 'currency'): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(kind);
  } catch {
    return [];
  }
}

/** Countries by ISO code, named in the browser's language — for country pickers */
export const COUNTRY_CODES = (
  'AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FR GA GB GD GE GH GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KM KN KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NZ OM PA PE PG PH PK PL PR PS PT PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS SV SY SZ TD TG TH TJ TL TM TN TO TR TT TW TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW'
).split(' ');

export function countryOptions(): { value: string; label: string }[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    names = null;
  }
  return COUNTRY_CODES.map((code) => ({ value: code, label: names?.of(code) ?? code })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

/** The usual currency of a country — a suggestion only, the owner picks */
const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN', UY: 'UYU',
  GB: 'GBP', IE: 'EUR', PT: 'EUR', ES: 'EUR', FR: 'EUR', DE: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR',
  AT: 'EUR', FI: 'EUR', GR: 'EUR', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK',
  IN: 'INR', BD: 'BDT', PK: 'PKR', LK: 'LKR', NP: 'NPR', CN: 'CNY', HK: 'HKD', SG: 'SGD', MY: 'MYR',
  ID: 'IDR', PH: 'PHP', TH: 'THB', VN: 'VND', AU: 'AUD', NZ: 'NZD', ZA: 'ZAR', NG: 'NGN', KE: 'KES',
  EG: 'EGP', AE: 'AED', SA: 'SAR', TR: 'TRY', IL: 'ILS',
};

export function currencyOf(country: string): string | null {
  return COUNTRY_CURRENCY[country] ?? null;
}

/** The format closest to a country, among the ones offered */
export function localeOf(country: string): string {
  const byCountry: Record<string, string> = { BR: 'pt-BR', US: 'en-US', GB: 'en-GB', IN: 'en-IN', ES: 'es-ES', PT: 'pt-PT', FR: 'fr-FR', DE: 'de-DE' };
  return byCountry[country] ?? '';
}
