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
  'statement.subject': '{org} — hours to post, {start} to {end}',
  'statement.intro':
    'Hours worked by hourly staff from {start} to {end}, ready to post in the payroll system.',
  'statement.line': '{name} ({code}): {hours} to post',
  'statement.carry': 'includes {carry} carried over from earlier periods',
  'statement.leave': 'leave days: {n}',
  'statement.holidays': 'holidays: {n}',
  'statement.warnings': 'Check before posting:',
  'statement.noData': '{name}: {n} workday(s) with no recorded time',
  'statement.negative':
    '{name}: negative result — a correction lowered hours already posted',
  'statement.link': 'Details and day-by-day hours: {url}',
  'statement.markPosted':
    'After posting, mark each person as posted on that screen.',
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
    'statement.subject': '{org} — horas para lançar, de {start} a {end}',
    'statement.intro':
      'Horas trabalhadas pelos horistas de {start} a {end}, prontas para lançar no sistema de folha.',
    'statement.line': '{name} ({code}): {hours} a lançar',
    'statement.carry': 'inclui {carry} de ajuste de períodos anteriores',
    'statement.leave': 'dias de folga: {n}',
    'statement.holidays': 'feriados: {n}',
    'statement.warnings': 'Confira antes de lançar:',
    'statement.noData': '{name}: {n} dia(s) útil(eis) sem tempo registrado',
    'statement.negative':
      '{name}: resultado negativo — uma correção reduziu horas já lançadas',
    'statement.link': 'Detalhes e horas dia a dia: {url}',
    'statement.markPosted':
      'Depois de lançar, marque cada pessoa como lançada nessa tela.',
  },
  es: {
    'smtpTest.subject': '{org} — correo de prueba',
    'smtpTest.body':
      'Este es un correo de prueba de oXeio, enviado por {by}.\nSi puede leer esto, el envío de correos funciona.',
    'unit.hours': 'h',
    'unit.minutes': 'min',
    'statement.subject': '{org} — horas para registrar, del {start} al {end}',
    'statement.intro':
      'Horas trabajadas por el personal por horas del {start} al {end}, listas para registrar en el sistema de nómina.',
    'statement.line': '{name} ({code}): {hours} a registrar',
    'statement.carry': 'incluye {carry} de ajuste de períodos anteriores',
    'statement.leave': 'días de permiso: {n}',
    'statement.holidays': 'feriados: {n}',
    'statement.warnings': 'Revise antes de registrar:',
    'statement.noData': '{name}: {n} día(s) laborable(s) sin tiempo registrado',
    'statement.negative':
      '{name}: resultado negativo — una corrección redujo horas ya registradas',
    'statement.link': 'Detalles y horas día por día: {url}',
    'statement.markPosted':
      'Después de registrar, marque a cada persona como registrada en esa pantalla.',
  },
};

export function mailText(
  lang: Language,
  key: MailKey,
  vars: Record<string, string | number> = {},
): string {
  return MAIL_CATALOG[lang][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}

/** `173 h 25 min` — whole hours and two-digit minutes, as payroll forms ask */
export function hoursAndMinutes(totalMinutes: number, lang: Language): string {
  const whole = Math.trunc(totalMinutes);
  const sign = whole < 0 ? '−' : '';
  const abs = Math.abs(whole);
  const hours = Math.floor(abs / 60);
  const minutes = String(abs % 60).padStart(2, '0');
  return `${sign}${hours} ${mailText(lang, 'unit.hours')} ${minutes} ${mailText(lang, 'unit.minutes')}`;
}

const DAY_LOCALE: Record<Language, string> = {
  en: 'en-GB',
  'pt-BR': 'pt-BR',
  es: 'es-ES',
};

/** A calendar date ('YYYY-MM-DD') written the reader's way */
export function formatDay(date: string, lang: Language): string {
  const options: Intl.DateTimeFormatOptions =
    lang === 'en'
      ? { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }
      : { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' };
  return new Intl.DateTimeFormat(DAY_LOCALE[lang], options).format(
    new Date(`${date}T00:00:00.000Z`),
  );
}
