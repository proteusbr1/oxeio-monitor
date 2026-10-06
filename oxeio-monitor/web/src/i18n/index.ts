import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';

/**
 * The dashboard's languages. The English text itself is the key
 * (`t('Add tasks')`): a string nobody has translated yet still reads
 * correctly, and the code stays readable.
 *
 * Catalogs live in `locales/<language>/<area>.json`, one file per area of
 * the app (so people translating different screens never edit the same
 * file); they are merged here at build time. `en` holds only what English
 * itself needs: the plural forms (`"{{count}} task_one"` /
 * `"{{count}} task_other"`) — every other English string is its own key.
 *
 * Conventions for code:
 *  · components: `const t = useT();` then `t('Save')`, `t('{{name}} left', { name })`
 *  · plurals: `t('{{count}} tasks', { count })` — the key is the plural form,
 *    with `_one`/`_other` entries in en and the other catalogs
 *  · outside React (format.ts, api helpers): `translate('…')`
 *  · never build a sentence from pieces — word order differs between languages
 */

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'es', label: 'Español' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'oxeio.language';

type Catalog = Record<string, string>;

/** every `locales/<lang>/*.json`, merged per language */
function catalogs(): Record<string, { translation: Catalog }> {
  const files = import.meta.glob<Catalog>('./locales/*/*.json', { eager: true, import: 'default' });
  const out: Record<string, { translation: Catalog }> = {};
  for (const [path, catalog] of Object.entries(files)) {
    const lang = path.split('/')[2];
    out[lang] ??= { translation: {} };
    Object.assign(out[lang].translation, catalog);
  }
  return out;
}

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((l) => l.code === value);
}

/** The closest supported language to a browser tag: pt-PT → pt-BR, es-MX → es */
export function matchLanguage(tag: string | null | undefined): Language | null {
  if (!tag) return null;
  if (isLanguage(tag)) return tag;
  const base = tag.toLowerCase().split('-')[0];
  if (base === 'pt') return 'pt-BR';
  if (base === 'es') return 'es';
  if (base === 'en') return 'en';
  return null;
}

function remembered(): Language | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

function browserLanguage(): Language | null {
  if (typeof navigator === 'undefined') return null;
  for (const tag of navigator.languages ?? [navigator.language]) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return null;
}

void i18n.use(initReactI18next).init({
  resources: catalogs(),
  lng: remembered() ?? browserLanguage() ?? 'en',
  fallbackLng: 'en',
  // natural-language keys: "Save", "Use the .env value", "3 of 5"
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

const listeners = new Set<(language: Language) => void>();

/**
 * Which language wins: the person's own choice (Account page, remembered in
 * this browser too) › the company's default (Settings → Company & region) ›
 * the browser's language › English.
 */
let companyDefault: Language | null = null;

function apply(language: Language): void {
  if (i18n.language !== language) void i18n.changeLanguage(language);
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = language;
  listeners.forEach((l) => l(language));
}

/** The person chose (or `null`: back to the company's default) */
export function setLanguage(language: Language | null): void {
  try {
    if (language) localStorage.setItem(STORAGE_KEY, language);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // not remembered: it still applies until the page is reloaded
  }
  apply(language ?? companyDefault ?? browserLanguage() ?? 'en');
}

/** The company's default, from the server — applies unless the person chose */
export function setCompanyLanguage(language: string | null | undefined): void {
  companyDefault = isLanguage(language) ? language : null;
  if (!remembered() && companyDefault) apply(companyDefault);
}

/** The language currently on screen */
export function currentLanguage(): Language {
  return isLanguage(i18n.language) ? i18n.language : 'en';
}

/** format.ts and others that cache language-dependent text */
export function onLanguageChange(listener: (language: Language) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For components: `const t = useT();` — re-renders when the language changes */
export function useT() {
  return useTranslation().t;
}

/** Outside React — read at call time, so call it where the text is used */
export function translate(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options) as string;
}

if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = currentLanguage();

export default i18n;
