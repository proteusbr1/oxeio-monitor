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
