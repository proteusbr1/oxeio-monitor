import { afterEach, describe, expect, it } from 'vitest';

import i18n from '../src/i18n';
import { SERVER_MESSAGE_PATTERNS, translateServerMessage } from '../src/i18n/server-messages';
import es from '../src/i18n/locales/es/server.json';
import ptBR from '../src/i18n/locales/pt-BR/server.json';

describe('translateServerMessage', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('leaves English as the server wrote it', () => {
    expect(translateServerMessage('Staff member not found')).toBe('Staff member not found');
    expect(translateServerMessage('No rule with id 42')).toBe('No rule with id 42');
    expect(translateServerMessage('Too many failed attempts. Try again in 1 minute.')).toBe(
      'Too many failed attempts. Try again in 1 minute.',
    );
  });

  it('translates a known message exactly', async () => {
    await i18n.changeLanguage('pt-BR');
    expect(translateServerMessage('Staff member not found')).toBe('Membro da equipe não encontrado');
  });

  it('translates a dynamic message and keeps its values', async () => {
    await i18n.changeLanguage('pt-BR');
    expect(
      translateServerMessage(
        'No MSI at "agent/1.2.0.msi" (looked under the storage root). Copy the built file there first.',
      ),
    ).toBe(
      'Nenhum MSI em "agent/1.2.0.msi" (procurado na raiz do armazenamento). Copie o arquivo gerado para lá primeiro.',
    );
    expect(translateServerMessage('2026-08 is closed — reopen the month first')).toBe(
      '2026-08 está fechado — reabra o mês primeiro',
    );
  });

  it('uses the plural form for a count', async () => {
    await i18n.changeLanguage('pt-BR');
    expect(translateServerMessage('Too many failed attempts. Try again in 1 minute.')).toBe(
      'Muitas tentativas sem sucesso. Tente novamente em 1 minuto.',
    );
    expect(translateServerMessage('Too many failed attempts. Try again in 5 minutes.')).toBe(
      'Muitas tentativas sem sucesso. Tente novamente em 5 minutos.',
    );
  });

  it('translates each item of a validation list', async () => {
    await i18n.changeLanguage('es');
    expect(
      translateServerMessage(
        'property foo should not exist, role must be one of the following values: owner, manager, Email is not valid',
      ),
    ).toBe(
      'la propiedad foo no está permitida, role debe ser uno de los siguientes valores: owner, manager, El correo electrónico no es válido',
    );
    expect(translateServerMessage(['Email is not valid', 'something new'])).toBe(
      'El correo electrónico no es válido, something new',
    );
  });

  it('translates a value that is itself a server message', async () => {
    await i18n.changeLanguage('pt-BR');
    expect(translateServerMessage('Could not reach Backblaze — unknown error')).toBe(
      'Não foi possível contatar o Backblaze — erro desconhecido',
    );
  });

  it('returns an unknown message unchanged', async () => {
    await i18n.changeLanguage('pt-BR');
    expect(translateServerMessage('A brand new server message')).toBe('A brand new server message');
    expect(translateServerMessage('Forbidden resource, really')).toBe('Forbidden resource, really');
  });

  it('recognises every dynamic message, and keeps it whole when its value has commas', async () => {
    const sample = (key: string) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        name === 'count' ? '3' : name === 'status' ? '500' : name === 'property' || name === 'field' ? 'name' : 'X-1',
      );
    for (const key of SERVER_MESSAGE_PATTERNS) {
      await i18n.changeLanguage('en');
      expect(translateServerMessage(sample(key)), key).toBe(sample(key));
      await i18n.changeLanguage('pt-BR');
      expect(translateServerMessage(sample(key)), key).not.toBe(sample(key));
    }
    expect(translateServerMessage('Unknown leave type "trip" — expected one of vacation, sick, other')).toBe(
      'Tipo de afastamento desconhecido "trip" — esperado um de vacation, sick, other',
    );
  });

  it('every dynamic message has its translations', () => {
    for (const key of SERVER_MESSAGE_PATTERNS) {
      for (const catalog of [ptBR, es] as Record<string, string>[]) {
        expect(key in catalog || `${key}_other` in catalog, key).toBe(true);
      }
    }
  });
});
