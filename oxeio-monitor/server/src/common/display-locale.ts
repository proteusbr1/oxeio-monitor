/**
 * How the dashboard writes dates and numbers — `DISPLAY_LOCALE`, a BCP 47 tag
 * such as `pt-BR`. Empty by default: the dashboard keeps exactly the formats
 * it always had (`10 August 2026`, `13,000.50`).
 *
 * ⚠️ Formatting only, never translation. With a locale set, dates become
 *    numeric in that locale's order (`10/08/2026` for pt-BR) and numbers use
 *    its separators (`13.000,50`) — no month or weekday name changes
 *    language, and every label stays as it is.
 */
export function checkDisplayLocale(raw: string | undefined): string | null {
  const tag = raw?.trim();
  if (!tag) return null;

  let canonical: string[];
  try {
    canonical = Intl.getCanonicalLocales(tag);
  } catch {
    throw new Error(
      `DISPLAY_LOCALE="${raw}" is not a locale tag (example: pt-BR, en-GB, de-DE)`,
    );
  }
  if (Intl.DateTimeFormat.supportedLocalesOf(canonical).length === 0) {
    throw new Error(
      `DISPLAY_LOCALE="${raw}" is not supported by this server's Intl data`,
    );
  }
  return canonical[0];
}

/** Read at import time, like WORK_TIMEZONE and CURRENCY: a wrong value stops the server */
export const DISPLAY_LOCALE: string | null = checkDisplayLocale(
  process.env.DISPLAY_LOCALE,
);
