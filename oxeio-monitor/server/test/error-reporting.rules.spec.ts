import { describe, expect, it } from 'vitest';

import {
  pagePattern,
  redact,
  scrub,
  testOutcome,
} from '../src/error-reporting/error-reporter.service';
import {
  checkDsn,
  checkEnvironment,
  dsnHost,
  resolveErrorReporting,
} from '../src/error-reporting/error-reporting.rules';

const DSN = 'https://abc123@o45.ingest.sentry.io/4507123456';

describe('checkDsn', () => {
  it('takes what Sentry and GlitchTip hand out', () => {
    expect(checkDsn(`  ${DSN} `)).toBe(DSN);
    expect(checkDsn('https://key@glitchtip.example.com/3')).toBe(
      'https://key@glitchtip.example.com/3',
    );
    expect(checkDsn('https://key@sentry.example.com/sub/path/7')).toBeTruthy();
  });

  it('refuses what would fail silently on the first crash', () => {
    expect(() => checkDsn('not a url')).toThrow(/not a DSN/);
    expect(() => checkDsn('ftp://k@h/1')).toThrow(/https/);
    expect(() => checkDsn('https://o45.ingest.sentry.io/1')).toThrow(/no key/);
    expect(() => checkDsn('https://k@o45.ingest.sentry.io/')).toThrow(/project number/);
  });
});

describe('checkEnvironment', () => {
  it('defaults to production, refuses spaces', () => {
    expect(checkEnvironment('')).toBe('production');
    expect(checkEnvironment(' staging ')).toBe('staging');
    expect(() => checkEnvironment('my prod')).toThrow(/short name/);
  });
});

describe('resolveErrorReporting', () => {
  it('off when nothing is set', () => {
    expect(resolveErrorReporting(null, {})).toEqual({
      dsn: null,
      environment: 'production',
      browser: false,
      source: 'default',
    });
  });

  it('the .env when nothing is saved on screen', () => {
    expect(
      resolveErrorReporting(null, {
        SENTRY_DSN: DSN,
        SENTRY_ENVIRONMENT: 'staging',
        SENTRY_BROWSER: 'true',
      }),
    ).toEqual({ dsn: DSN, environment: 'staging', browser: true, source: 'environment' });
  });

  it('the screen wins; a cleared DSN falls back to the .env', () => {
    expect(
      resolveErrorReporting({ dsn: DSN, browser: false }, { SENTRY_DSN: 'https://x@y/1' })
        .source,
    ).toBe('dashboard');
    expect(
      resolveErrorReporting({ dsn: '' }, { SENTRY_DSN: 'https://x@y/1' }).source,
    ).toBe('environment');
  });

  it('the dashboard checkbox and environment work with a DSN from the .env', () => {
    expect(
      resolveErrorReporting(
        { dsn: '', environment: 'staging', browser: true },
        { SENTRY_DSN: DSN },
      ),
    ).toEqual({ dsn: DSN, environment: 'staging', browser: true, source: 'environment' });
  });

  it('no DSN anywhere → the dashboard checkbox means nothing', () => {
    expect(resolveErrorReporting({ browser: true }, {}).browser).toBe(false);
  });

  it('shows only the host', () => {
    expect(dsnHost(DSN)).toBe('o45.ingest.sentry.io');
    expect(dsnHost(null)).toBeNull();
  });
});

describe('what leaves the server', () => {
  it('emails are masked', () => {
    expect(redact('no user rima@studio.com here')).toBe('no user [email] here');
  });

  it('pages lose their ids and query strings', () => {
    expect(pagePattern('/staff/12?tab=x')).toBe('/staff/:id');
    expect(pagePattern('/settings?tab=backup')).toBe('/settings');
    expect(pagePattern('')).toBe('/');
  });

  it('request, user, breadcrumbs and host name are dropped', () => {
    const event = scrub({
      type: undefined,
      request: { url: 'https://x/api?token=1', cookies: { a: 'b' } },
      user: { email: 'a@b.co', ip_address: '1.2.3.4' },
      breadcrumbs: [{ message: 'x' }],
      contexts: { os: { name: 'linux' } },
      server_name: 'vps-123.example.net',
      exception: { values: [{ type: 'Error', value: 'mail to a@b.co failed' }] },
    });
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.contexts).toBeUndefined();
    expect(event.server_name).toBe('oxeio-api');
    expect(event.exception?.values?.[0]?.value).toBe('mail to [email] failed');
  });
});

describe('testOutcome — Sentry\'s answer in words', () => {
  it('2xx is sent, with the event id', () => {
    expect(testOutcome(200, 'abc')).toMatchObject({ ok: true, eventId: 'abc' });
  });

  it('says what to fix', () => {
    expect(testOutcome(401, 'x').message).toMatch(/refused the key/);
    expect(testOutcome(404, 'x').message).toMatch(/project/);
    expect(testOutcome(429, 'x').message).toMatch(/rate-limiting/);
    expect(testOutcome(500, 'x').message).toMatch(/HTTP 500/);
    expect(testOutcome(null, 'x').message).toMatch(/Could not reach/);
    expect(testOutcome(null, 'x').ok).toBe(false);
  });
});
