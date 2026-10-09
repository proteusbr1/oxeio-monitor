import { describe, expect, it } from 'vitest';

import { Mailer } from '../src/mail/mailer';
import {
  resolveSmtp,
  type SmtpConfig,
  type SmtpSaved,
} from '../src/mail/smtp.settings';
import type { AppSettingsService } from '../src/settings/app-settings.service';

/** The mailer reads SMTP at send time, so a change on screen applies at once. */

function harness(initial: SmtpSaved | null) {
  let saved = initial;
  const settings = {
    smtp: async () => resolveSmtp(saved, {}),
  } as unknown as AppSettingsService;
  const mailer = new Mailer(settings);
  const built: SmtpConfig[] = [];
  const sent: Record<string, unknown>[] = [];
  let fail: Error | null = null;
  mailer.createTransport = (config) => {
    built.push(config);
    return {
      sendMail: async (options: Record<string, unknown>) => {
        if (fail) throw fail;
        sent.push(options);
      },
      close: () => undefined,
      on: () => undefined,
    };
  };
  return {
    mailer,
    built,
    sent,
    change: (next: SmtpSaved | null) => (saved = next),
    failWith: (err: Error | null) => (fail = err),
  };
}

describe('Mailer', () => {
  it('without SMTP: not configured, nothing built', async () => {
    const h = harness(null);
    expect(await h.mailer.isConfigured()).toBe(false);
    expect(await h.mailer.send(['a@x.test'], 's', 'b')).toBe('not_configured');
    expect(h.built).toHaveLength(0);
  });

  it('sends text, html and attachments from the configured sender', async () => {
    const h = harness({
      host: 'smtp.test',
      port: 587,
      from: 'Team <t@x.test>',
    });
    const result = await h.mailer.deliver(['a@x.test', 'b@x.test'], {
      subject: 'Hi',
      text: 'plain',
      html: '<p>rich</p>',
      attachments: [
        {
          filename: 'f.xlsx',
          content: Buffer.from('x'),
          contentType: 'application/x',
        },
      ],
    });
    expect(result).toEqual({ outcome: 'sent' });
    expect(h.sent[0]).toMatchObject({
      from: 'Team <t@x.test>',
      to: 'a@x.test, b@x.test',
      subject: 'Hi',
      text: 'plain',
      html: '<p>rich</p>',
    });
    expect((h.sent[0].attachments as unknown[]).length).toBe(1);
  });

  it('no recipients: not configured, nothing sent', async () => {
    const h = harness({ host: 'smtp.test', port: 587 });
    expect(await h.mailer.send([], 's', 'b')).toBe('not_configured');
    expect(h.sent).toHaveLength(0);
  });

  it('a change of settings rebuilds the transport on the next send', async () => {
    const h = harness({ host: 'one.test', port: 587 });
    await h.mailer.send(['a@x.test'], 's', 'b');
    await h.mailer.send(['a@x.test'], 's', 'b');
    expect(h.built.map((c) => c.host)).toEqual(['one.test']);
    h.change({ host: 'two.test', port: 587 });
    await h.mailer.send(['a@x.test'], 's', 'b');
    expect(h.built.map((c) => c.host)).toEqual(['one.test', 'two.test']);
  });

  it('a server error is a value with its text, never an exception', async () => {
    const h = harness({ host: 'smtp.test', port: 587 });
    h.failWith(new Error('535 Authentication Credentials Invalid'));
    expect(
      await h.mailer.deliver(['a@x.test'], { subject: 's', text: 'b' }),
    ).toEqual({
      outcome: 'failed',
      error: '535 Authentication Credentials Invalid',
    });
  });
});
