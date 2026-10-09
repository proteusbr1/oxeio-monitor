// oxeio-monitor/server/test/smtp-settings.spec.ts
import { describe, expect, it } from 'vitest';

import {
  mergeSmtpSave,
  smtpMergedProblem,
  resolveSmtp,
  smtpSaveProblem,
  smtpView,
} from '../src/mail/smtp.settings';

/** SMTP: saved on screen › .env › off. The password never leaves the server. */

describe('resolveSmtp', () => {
  it('nothing anywhere = off', () => {
    expect(resolveSmtp(null, {})).toEqual({ config: null, source: 'none' });
  });

  it('the .env alone, exactly as before (587 → STARTTLS, 465 → TLS)', () => {
    const r = resolveSmtp(null, {
      SMTP_HOST: ' mail.example.com ',
      SMTP_PORT: '587',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
      SMTP_FROM: 'Team <team@example.com>',
    });
    expect(r).toEqual({
      source: 'env',
      config: {
        host: 'mail.example.com',
        port: 587,
        secure: false,
        user: 'u',
        pass: 'p',
        from: 'Team <team@example.com>',
      },
    });
    expect(
      resolveSmtp(null, { SMTP_HOST: 'h', SMTP_PORT: '465' }).config?.secure,
    ).toBe(true);
    expect(
      resolveSmtp(null, { SMTP_HOST: 'h', SMTP_SECURE: 'true' }).config?.secure,
    ).toBe(true);
  });

  it('a bad port falls back to 587; no sender gives a no-reply on the host', () => {
    const r = resolveSmtp(null, { SMTP_HOST: 'h', SMTP_PORT: 'abc' });
    expect(r.config?.port).toBe(587);
    expect(r.config?.from).toBe('oXeio <no-reply@h>');
  });

  it('the screen wins as soon as it has a host, without mixing in .env fields', () => {
    const r = resolveSmtp(
      { host: 'smtp.saved.test', port: 2525, user: 'su' },
      { SMTP_HOST: 'env.test', SMTP_PASS: 'env-pass' },
    );
    expect(r.source).toBe('database');
    expect(r.config).toEqual({
      host: 'smtp.saved.test',
      port: 2525,
      secure: false,
      user: 'su',
      pass: undefined,
      from: 'oXeio <no-reply@smtp.saved.test>',
    });
  });

  it('a saved row without a host does not hide a working .env', () => {
    expect(resolveSmtp({ host: '  ' }, { SMTP_HOST: 'env.test' }).source).toBe(
      'env',
    );
  });
});

describe('smtpView — what the screen may see', () => {
  it('says whether a password is set, never the password', () => {
    const view = smtpView(
      resolveSmtp({ host: 'h', port: 587, user: 'u', pass: 'secret' }, {}),
    );
    expect(view).toEqual({
      configured: true,
      source: 'database',
      host: 'h',
      port: 587,
      secure: false,
      user: 'u',
      passwordSet: true,
      from: 'oXeio <no-reply@h>',
    });
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('off reads as an empty form', () => {
    expect(smtpView({ config: null, source: 'none' })).toEqual({
      configured: false,
      source: 'none',
      host: '',
      port: 587,
      secure: false,
      user: '',
      passwordSet: false,
      from: '',
    });
  });
});

describe('smtpSaveProblem', () => {
  it('needs a host and a real port', () => {
    expect(smtpSaveProblem({ host: ' ', port: 587 })).toMatch(/host/);
    expect(smtpSaveProblem({ host: 'h', port: 0 })).toMatch(/port/);
    expect(smtpSaveProblem({ host: 'h', port: 70000 })).toMatch(/port/);
    expect(smtpSaveProblem({ host: 'h', port: 587 })).toBeNull();
  });

  it('a sender must contain an address', () => {
    expect(smtpSaveProblem({ host: 'h', port: 587, from: 'Team' })).toMatch(
      /sender/,
    );
    expect(
      smtpSaveProblem({ host: 'h', port: 587, from: 'Team <t@example.com>' }),
    ).toBeNull();
  });
});

describe('smtpMergedProblem', () => {
  it('a user without any password is refused (it would break every email)', () => {
    expect(
      smtpMergedProblem({ host: 'h', port: 587, user: 'u', pass: '' }),
    ).toBe('Type the SMTP password');
    expect(smtpMergedProblem({ host: 'h', port: 587, user: 'u' })).toBe(
      'Type the SMTP password',
    );
  });

  it('a relay without a user, or a user with a password, is fine', () => {
    expect(
      smtpMergedProblem({ host: 'h', port: 587, user: '', pass: '' }),
    ).toBeNull();
    expect(
      smtpMergedProblem({ host: 'h', port: 587, user: 'u', pass: 'p' }),
    ).toBeNull();
  });
});

describe('mergeSmtpSave', () => {
  it('an empty password keeps the stored one (fixing the host must not erase it)', () => {
    const next = mergeSmtpSave(
      { host: 'old', port: 587, user: 'u', pass: 'kept' },
      { host: 'new', port: 587, user: 'u', pass: '' },
    );
    expect(next).toEqual({
      host: 'new',
      port: 587,
      secure: null,
      user: 'u',
      pass: 'kept',
      from: '',
    });
  });

  it('a typed password replaces it; fields are trimmed', () => {
    const next = mergeSmtpSave(null, {
      host: ' h ',
      port: 465,
      secure: true,
      user: ' u ',
      pass: 'new',
      from: ' a@b.c ',
    });
    expect(next).toEqual({
      host: 'h',
      port: 465,
      secure: true,
      user: 'u',
      pass: 'new',
      from: 'a@b.c',
    });
  });
});
