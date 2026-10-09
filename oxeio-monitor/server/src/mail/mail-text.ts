import type { Language } from '../settings/languages';

/**
 * Text of the emails written by the server, in the company's default
 * language (Settings → Company & region). A small typed catalog rather than
 * a library: the server writes a handful of emails, and a missing
 * translation must be a compile error, not a blank line in someone's inbox.
 *
 * Older emails (alerts, summaries) are still English; move them here when
 * they are translated.
 */
const EN = {
  'smtpTest.subject': '{org} — test email',
  'smtpTest.body':
    'This is a test email from oXeio, sent by {by}.\nIf you can read this, sending email works.',
  'unit.hours': 'h',
  'unit.minutes': 'min',
} as const;

export type MailKey = keyof typeof EN;

export const MAIL_CATALOG: Record<Language, Record<MailKey, string>> = {
  en: EN,
  'pt-BR': {
    'smtpTest.subject': '{org} — e-mail de teste',
    'smtpTest.body':
      'Este é um e-mail de teste do oXeio, enviado por {by}.\nSe você está lendo isto, o envio de e-mails funciona.',
    'unit.hours': 'h',
    'unit.minutes': 'min',
  },
  es: {
    'smtpTest.subject': '{org} — correo de prueba',
    'smtpTest.body':
      'Este es un correo de prueba de oXeio, enviado por {by}.\nSi puede leer esto, el envío de correos funciona.',
    'unit.hours': 'h',
    'unit.minutes': 'min',
  },
};

export function mailText(
  lang: Language,
  key: MailKey,
  vars: Record<string, string | number> = {},
): string {
  return MAIL_CATALOG[lang][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** `173 h 25 min` — whole hours and two-digit minutes, as payroll forms ask */
export function hoursAndMinutes(totalMinutes: number, lang: Language): string {
  const sign = totalMinutes < 0 ? '−' : '';
  const abs = Math.abs(Math.trunc(totalMinutes));
  const hours = Math.floor(abs / 60);
  const minutes = String(abs % 60).padStart(2, '0');
  return `${sign}${hours} ${mailText(lang, 'unit.hours')} ${minutes} ${mailText(lang, 'unit.minutes')}`;
}
