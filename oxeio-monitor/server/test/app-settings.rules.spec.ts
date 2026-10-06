import { describe, expect, it } from 'vitest';

import {
  resolveBackupMode,
  resolveRegion,
  resolveUpdateKey,
  validateRegion,
} from '../src/settings/app-settings.rules';
import {
  b2RegionOf,
  normalisePrefix,
  resolveStorage,
  storageView,
} from '../src/settings/storage.settings';

/**
 * Settings the owner edits on screen: a value saved there wins, the .env is
 * the starting value, and with neither the built-in default — the same
 * behaviour the server always had.
 */
describe('resolveRegion', () => {
  it('nothing saved, nothing in .env → Dhaka, USD, own formats', () => {
    const r = resolveRegion(null, {}, 'Asia/Dhaka');
    expect(r.timeZone).toEqual({ value: 'Asia/Dhaka', source: 'default' });
    expect(r.currency).toMatchObject({
      code: 'USD',
      symbol: '$',
      source: 'default',
    });
    expect(r.displayLocale).toEqual({ value: null, source: 'default' });
  });

  it('.env is used when nothing is saved', () => {
    const r = resolveRegion(
      null,
      {
        WORK_TIMEZONE: 'America/Sao_Paulo',
        CURRENCY: 'BRL',
        DISPLAY_LOCALE: 'pt-BR',
      },
      'America/Sao_Paulo',
    );
    expect(r.currency).toMatchObject({ code: 'BRL', source: 'environment' });
    expect(r.displayLocale).toEqual({ value: 'pt-BR', source: 'environment' });
  });

  it('what is saved on screen wins over .env', () => {
    const r = resolveRegion(
      { currency: 'EUR', displayLocale: null },
      { CURRENCY: 'BRL', DISPLAY_LOCALE: 'pt-BR' },
      'Asia/Dhaka',
    );
    expect(r.currency).toMatchObject({
      code: 'EUR',
      symbol: '€',
      source: 'dashboard',
    });
    // null saved = "own formats", a choice — not "fall back to .env"
    expect(r.displayLocale).toEqual({ value: null, source: 'dashboard' });
  });
});

describe('validateRegion', () => {
  it('accepts what the server can run on', () => {
    expect(
      validateRegion({
        timeZone: 'America/Sao_Paulo',
        currency: 'brl',
        displayLocale: 'pt-br',
      }),
    ).toEqual({
      timeZone: 'America/Sao_Paulo',
      currency: 'BRL',
      displayLocale: 'pt-BR',
    });
  });

  it('accepts a zone with daylight saving time', () => {
    expect(validateRegion({ timeZone: 'Europe/London' })).toEqual({ timeZone: 'Europe/London' });
  });

  it.each([
    [{ timeZone: 'Mars/Base' }, /IANA/],
    [{ currency: 'JPY' }, /decimal places/],
    [{ displayLocale: 'pt_BR!!' }, /DISPLAY_LOCALE/],
  ])('refuses %j', (input, message) => {
    expect(() => validateRegion(input)).toThrow(message);
  });
});

describe('resolveBackupMode / resolveUpdateKey', () => {
  it('backup: saved > .env > internal', () => {
    expect(resolveBackupMode(null, undefined)).toEqual({
      mode: 'internal',
      source: 'default',
    });
    expect(resolveBackupMode(null, 'external')).toEqual({
      mode: 'external',
      source: 'environment',
    });
    expect(resolveBackupMode({ mode: 'internal' }, 'external')).toEqual({
      mode: 'internal',
      source: 'dashboard',
    });
  });

  it('update key: removing it on screen beats the .env', () => {
    expect(resolveUpdateKey({ publicKey: null }, 'abc')).toEqual({
      publicKey: null,
      source: 'dashboard',
    });
    expect(resolveUpdateKey(null, 'abc')).toEqual({
      publicKey: 'abc',
      source: 'environment',
    });
  });
});

describe('screenshot storage settings', () => {
  const env = (vars: Record<string, string>) => (n: string) => vars[n];

  it('nothing anywhere → local, as before', () => {
    expect(resolveStorage(null, env({}), null)).toEqual({
      settings: { driver: 'local' },
      source: 'default',
    });
  });

  it("a bucket saved with the backup copy's key", () => {
    const r = resolveStorage(
      {
        driver: 's3',
        bucket: 'shots',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        useBackupKey: true,
      },
      env({}),
      { keyId: 'K', appKey: 'S' },
    );
    expect(r.source).toBe('dashboard');
    expect(r.settings).toMatchObject({
      driver: 's3',
      s3: { bucket: 'shots', accessKeyId: 'K', secretAccessKey: 'S' },
    });
  });

  it('a bucket whose key went missing stops the start with a message — never a silent switch to disk', () => {
    expect(() =>
      resolveStorage(
        { driver: 's3', bucket: 'shots', useBackupKey: true },
        env({}),
        null,
      ),
    ).toThrow(/Storage & backup/);
  });

  it('restart needed when what is saved differs from what runs', () => {
    const saved = { driver: 'local' as const };
    const view = storageView(saved, resolveStorage(saved, env({}), null), {
      driver: 's3',
      location: 's3://shots/',
    });
    expect(view.restartNeeded).toBe(true);
    expect(view.secretSet).toBe(false);
  });

  it('Backblaze region from its S3 address; prefix normalised', () => {
    expect(b2RegionOf('https://s3.us-west-004.backblazeb2.com')).toBe(
      'us-west-004',
    );
    expect(b2RegionOf('https://example.com')).toBeNull();
    expect(normalisePrefix('/oxeio/')).toBe('oxeio/');
    expect(normalisePrefix('')).toBe('');
  });
});
