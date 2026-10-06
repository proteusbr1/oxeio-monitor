/**
 * The dashboard's languages (web/src/i18n). The company sets a default on
 * Settings → Company & region; each person may choose their own on Account.
 */
export const LANGUAGES = ['en', 'pt-BR', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}
