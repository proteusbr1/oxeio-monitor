import { formatDay, hoursAndMinutes, mailText } from '../mail/mail-text';
import type { Language } from '../settings/languages';

export interface StatementMailLine {
  fullName: string;
  empCode: string;
  toPostMin: number;
  carryInSec: number;
  leaveDays: number;
  holidayDays: number;
  noDataDays: number;
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Stands in for the address while the sentence around the link is translated */
const URL_MARK = '\u0000';

/**
 * The hours statement email: hours and days only — no rate, no money, the
 * same reasoning as every email here (it sits in mailboxes for years).
 */
export function statementMail(input: {
  lang: Language;
  org: string;
  start: string;
  end: string;
  lines: readonly StatementMailLine[];
  link: string | null;
}): { subject: string; text: string; html: string } {
  const { lang } = input;
  const start = formatDay(input.start, lang);
  const end = formatDay(input.end, lang);

  const people = input.lines.map((l) => {
    const head = mailText(lang, 'statement.line', {
      name: l.fullName,
      code: l.empCode,
      hours: hoursAndMinutes(l.toPostMin, lang),
    });
    const extras = [
      l.carryInSec !== 0
        ? mailText(lang, 'statement.carry', {
            carry: hoursAndMinutes(Math.trunc(l.carryInSec / 60), lang),
          })
        : null,
      l.leaveDays > 0
        ? mailText(lang, 'statement.leave', { n: l.leaveDays })
        : null,
      l.holidayDays > 0
        ? mailText(lang, 'statement.holidays', { n: l.holidayDays })
        : null,
    ].filter((x): x is string => x !== null);
    return { head, extras };
  });

  const warnings = input.lines.flatMap((l) => [
    ...(l.noDataDays > 0
      ? [
          mailText(lang, 'statement.noData', {
            name: l.fullName,
            n: l.noDataDays,
          }),
        ]
      : []),
    ...(l.toPostMin < 0
      ? [mailText(lang, 'statement.negative', { name: l.fullName })]
      : []),
  ]);

  const closing = [
    ...(input.link
      ? [mailText(lang, 'statement.link', { url: input.link })]
      : []),
    mailText(lang, 'statement.markPosted'),
  ];
  // the html link is an anchor: the sentence is escaped around it, the address
  // escaped once more as an attribute (escapeHtml covers both quotes)
  const linkHtml = input.link
    ? mailText(lang, 'statement.link', { url: URL_MARK })
        .split(URL_MARK)
        .map(escapeHtml)
        .join(
          `<a href="${escapeHtml(input.link)}">${escapeHtml(input.link)}</a>`,
        )
    : null;

  const text = [
    mailText(lang, 'statement.intro', { start, end }),
    '',
    ...people.map((p) =>
      p.extras.length > 0
        ? `• ${p.head} (${p.extras.join('; ')})`
        : `• ${p.head}`,
    ),
    ...(warnings.length > 0
      ? [
          '',
          mailText(lang, 'statement.warnings'),
          ...warnings.map((w) => `• ${w}`),
        ]
      : []),
    '',
    ...closing,
  ].join('\n');

  const html = [
    `<p>${escapeHtml(mailText(lang, 'statement.intro', { start, end }))}</p>`,
    '<ul>',
    ...people.map(
      (p) =>
        `<li><b>${escapeHtml(p.head)}</b>${p.extras.length > 0 ? ` — ${escapeHtml(p.extras.join('; '))}` : ''}</li>`,
    ),
    '</ul>',
    ...(warnings.length > 0
      ? [
          `<p><b>${escapeHtml(mailText(lang, 'statement.warnings'))}</b></p>`,
          '<ul>',
          ...warnings.map((w) => `<li>${escapeHtml(w)}</li>`),
          '</ul>',
        ]
      : []),
    ...(linkHtml ? [`<p>${linkHtml}</p>`] : []),
    `<p>${escapeHtml(mailText(lang, 'statement.markPosted'))}</p>`,
  ].join('\n');

  return {
    subject: mailText(lang, 'statement.subject', {
      org: input.org,
      start,
      end,
    }),
    text,
    html,
  };
}
