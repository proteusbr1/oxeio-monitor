import { assertKnownZone } from '../agent/util/zone';
import { checkDisplayLocale } from '../common/display-locale';
import { parseBackupMode, type BackupMode } from '../ops/backup-mode';
import { checkCurrency, type CurrencyInfo } from '../payroll/currency';
import { isLanguage, LANGUAGES, type Language } from './languages';

/**
 * Settings the owner can change from the dashboard — pure rules, no I/O.
 *
 * Same idea as Telegram (`telegram.settings.ts`): a value saved on screen
 * wins, the environment variable is only the starting value. Someone who
 * never opens the screen keeps exactly what their `.env` says.
 */

export { REGION_SETTING_KEY } from './region-key';
export const BACKUP_SETTING_KEY = 'ops.backup';
export const UPDATE_KEY_SETTING_KEY = 'agent.updateKey';

/** Where a value came from — shown on screen so nobody wonders */
export type Source = 'dashboard' | 'environment' | 'default';

export interface RegionSaved {
  timeZone?: string;
  currency?: string;
  displayLocale?: string | null;
  /** the dashboard's language for anyone who has not chosen their own */
  language?: string;
}

export interface RegionView {
  /** the zone saved for the next start, and where it came from */
  timeZone: { value: string; source: Source };
  /** the zone this server is running on now — differs until a restart */
  runningTimeZone: string;
  currency: CurrencyInfo & { source: Source };
  /** `null` = the dashboard's own formats */
  displayLocale: { value: string | null; source: Source };
  /** the dashboard's default language (each person may pick their own) */
  language: { value: Language; source: Source };
}

const has = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

export function resolveRegion(
  saved: RegionSaved | null,
  env: { WORK_TIMEZONE?: string; CURRENCY?: string; DISPLAY_LOCALE?: string; DEFAULT_LANGUAGE?: string },
  runningTimeZone: string,
): RegionView {
  const tz = has(saved?.timeZone)
    ? { value: saved.timeZone, source: 'dashboard' as const }
    : has(env.WORK_TIMEZONE)
      ? { value: env.WORK_TIMEZONE.trim(), source: 'environment' as const }
      : { value: 'UTC', source: 'default' as const };

  const currencyRaw = has(saved?.currency)
    ? { value: saved.currency, source: 'dashboard' as const }
    : has(env.CURRENCY)
      ? { value: env.CURRENCY, source: 'environment' as const }
      : { value: 'USD', source: 'default' as const };

  // `null` saved on screen is a choice ("the dashboard's own formats"),
  // `undefined` means "never saved"
  const locale =
    saved && saved.displayLocale !== undefined
      ? { value: saved.displayLocale, source: 'dashboard' as const }
      : has(env.DISPLAY_LOCALE)
        ? { value: checkDisplayLocale(env.DISPLAY_LOCALE), source: 'environment' as const }
        : { value: null, source: 'default' as const };

  const language = isLanguage(saved?.language)
    ? { value: saved.language, source: 'dashboard' as const }
    : isLanguage(env.DEFAULT_LANGUAGE?.trim())
      ? { value: env.DEFAULT_LANGUAGE.trim() as Language, source: 'environment' as const }
      : { value: 'en' as const, source: 'default' as const };

  return {
    timeZone: tz,
    runningTimeZone,
    currency: { ...checkCurrency(currencyRaw.value), source: currencyRaw.source },
    displayLocale: locale,
    language,
  };
}

/**
 * What the owner sent, checked with the same rules as the environment
 * variables — an unknown zone, a three-decimal currency or a malformed
 * locale is refused here instead of breaking the next start.
 */
export function validateRegion(input: RegionSaved): RegionSaved {
  const out: RegionSaved = {};
  if (input.timeZone !== undefined) {
    const tz = input.timeZone.trim();
    assertKnownZone(tz); // throws with a readable message
    out.timeZone = tz;
  }
  if (input.currency !== undefined) out.currency = checkCurrency(input.currency).code;
  if (input.displayLocale !== undefined) {
    out.displayLocale =
      input.displayLocale === null || input.displayLocale.trim() === ''
        ? null
        : checkDisplayLocale(input.displayLocale);
  }
  if (input.language !== undefined) {
    if (!isLanguage(input.language)) {
      throw new Error(`The language must be one of: ${LANGUAGES.join(', ')}`);
    }
    out.language = input.language;
  }
  return out;
}

export function resolveBackupMode(
  saved: { mode?: string } | null,
  env: string | undefined,
): { mode: BackupMode; source: Source } {
  if (has(saved?.mode)) return { mode: parseBackupMode(saved.mode), source: 'dashboard' };
  if (has(env)) return { mode: parseBackupMode(env), source: 'environment' };
  return { mode: 'internal', source: 'default' };
}

export function resolveUpdateKey(
  saved: { publicKey?: string | null } | null,
  env: string | undefined,
): { publicKey: string | null; source: Source } {
  if (saved && saved.publicKey !== undefined) {
    return { publicKey: has(saved.publicKey ?? undefined) ? saved.publicKey! : null, source: 'dashboard' };
  }
  if (has(env)) return { publicKey: env.trim(), source: 'environment' };
  return { publicKey: null, source: 'default' };
}
