import { describe, expect, it } from 'vitest';

import { hoursAndMinutes, MAIL_CATALOG, mailText } from '../src/mail/mail-text';
import { LANGUAGES } from '../src/settings/languages';

describe('mailText', () => {
  it('fills the placeholders, in each language', () => {
    expect(mailText('en', 'smtpTest.subject', { org: 'Acme' })).toBe(
      'Acme — test email',
    );
    expect(mailText('pt-BR', 'smtpTest.subject', { org: 'Acme' })).toBe(
      'Acme — e-mail de teste',
    );
    expect(mailText('es', 'smtpTest.subject', { org: 'Acme' })).toBe(
      'Acme — correo de prueba',
    );
  });

  it('an unknown placeholder stays visible instead of vanishing', () => {
    expect(mailText('en', 'smtpTest.subject')).toBe('{org} — test email');
  });

  it('only the given variables count, not what every object inherits', () => {
    const en = MAIL_CATALOG.en as Record<string, string>;
    const original = en['smtpTest.subject'];
    en['smtpTest.subject'] = '{toString} {org}';
    try {
      expect(mailText('en', 'smtpTest.subject', { org: 'Acme' })).toBe(
        '{toString} Acme',
      );
    } finally {
      en['smtpTest.subject'] = original;
    }
  });

  it('every language has every key, none empty', () => {
    const keys = Object.keys(MAIL_CATALOG.en).sort();
    for (const lang of LANGUAGES) {
      expect(Object.keys(MAIL_CATALOG[lang]).sort()).toEqual(keys);
      for (const key of keys)
        expect(
          MAIL_CATALOG[lang][key as keyof typeof MAIL_CATALOG.en].trim(),
        ).not.toBe('');
    }
  });
});

describe('hoursAndMinutes', () => {
  it('whole hours plus two-digit minutes', () => {
    expect(hoursAndMinutes(10405, 'pt-BR')).toBe('173 h 25 min');
    expect(hoursAndMinutes(0, 'en')).toBe('0 h 00 min');
    expect(hoursAndMinutes(59, 'es')).toBe('0 h 59 min');
  });

  it('a negative amount keeps its sign', () => {
    expect(hoursAndMinutes(-75, 'en')).toBe('−1 h 15 min');
  });

  it('a fraction that truncates to zero has no sign', () => {
    expect(hoursAndMinutes(-0.5, 'en')).toBe('0 h 00 min');
  });
});
