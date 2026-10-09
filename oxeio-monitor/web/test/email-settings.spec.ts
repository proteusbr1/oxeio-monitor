import { afterEach, describe, expect, it } from 'vitest';

import i18n from '../src/i18n';
import { translateServerMessage } from '../src/i18n/server-messages';
import {
  formatAddressList,
  parseAddressList,
  senderFieldValue,
  testResultKey,
} from '../src/pages/settings/email.math';

describe('address lists typed in a text box', () => {
  it('accepts commas, semicolons and new lines; drops blanks and duplicates', () => {
    expect(parseAddressList('a@x.test, b@x.test;\nA@x.test\n\n')).toEqual([
      'a@x.test',
      'b@x.test',
    ]);
  });
  it('shows one address per line', () => {
    expect(formatAddressList(['a@x.test', 'b@x.test'])).toBe(
      'a@x.test\nb@x.test',
    );
  });
});

describe('sender field', () => {
  it('starts empty when the sender is the default built from the host', () => {
    expect(
      senderFieldValue('smtp.x.test', 'oXeio <no-reply@smtp.x.test>'),
    ).toBe('');
  });
  it('keeps a sender that was typed', () => {
    expect(senderFieldValue('smtp.x.test', 'Team <team@x.test>')).toBe(
      'Team <team@x.test>',
    );
    expect(senderFieldValue('smtp.x.test', 'oXeio <no-reply@other.test>')).toBe(
      'oXeio <no-reply@other.test>',
    );
    expect(senderFieldValue('', '')).toBe('');
  });
});

describe('test email result', () => {
  it('maps each outcome to a sentence key', () => {
    expect(testResultKey('sent')).toBe(
      '✓ Sent. Check the inbox (and the spam folder).',
    );
    expect(testResultKey('not_configured')).toBe(
      'Email is not set up yet — fill in the server above and save.',
    );
    expect(testResultKey('failed')).toBe(
      'The mail server refused or could not be reached:',
    );
  });
});

describe('mail messages from the server', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('are translated, keeping the value inside', async () => {
    await i18n.changeLanguage('pt-BR');
    expect(
      translateServerMessage('At most 20 addresses per kind of email'),
    ).toBe('No máximo 20 endereços por tipo de e-mail');
    expect(translateServerMessage('Not an email address: nope')).toBe(
      'Não é um endereço de e-mail: nope',
    );
    await i18n.changeLanguage('es');
    expect(translateServerMessage('Unknown kind of email: weekly')).toBe(
      'Tipo de correo desconocido: weekly',
    );
  });
});
