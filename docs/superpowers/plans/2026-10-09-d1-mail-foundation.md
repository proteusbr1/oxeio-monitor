# Delivery 1 — Mail foundation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email gets its own module: SMTP set on screen (with a test email), recipients chosen per kind of email, and email text in the company's language.

**Architecture:** The SMTP sender moves from `alerts/` into a global `mail/` module and reads its configuration from the settings service at send time (screen › `.env` › off), so a save applies without a restart. Pure rule files (`smtp.settings.ts`, `recipients.rules.ts`, `mail-text.ts`) hold every decision; services only fetch and send.

**Tech Stack:** NestJS 11, Prisma 6, nodemailer, vitest (server); React 19, i18next, vitest (web).

**Spec:** `docs/superpowers/specs/2026-10-09-work-hours-and-pay-period-design.md` § 4 (and § 1a). Index and working rules: `docs/superpowers/plans/2026-10-09-work-hours-index.md`.

## Global Constraints

- Settings precedence for every subject: saved on screen › environment variable › built-in default.
- The SMTP password is write-only: never returned to the screen, never written to the audit log or the server log.
- A mail failure never throws out of the mailer; it is a returned value (`'sent' | 'not_configured' | 'failed'`).
- Managers never receive emails that carry everyone's figures; recipients come only from saved lists, the env fallbacks or active owners.
- Generic: no company, provider or country names in code, text or tests (SES is only named in deployment notes).
- Text in English in code; email text in `en`, `pt-BR`, `es`; screen text through `t()` with English keys and `pt-BR`/`es` catalogs.
- Branch `feat/mail-foundation` off `pericialmed`.

## Review Focus

1. Saving the SMTP card with the password field empty must keep the stored password (fixing only the host must not erase it) — test in Task 1 (`mergeSmtpSave`) and Task 4 (e2e).
2. Changing SMTP on screen must take effect on the next send without restart (transport rebuilt when the config changes) — test in Task 2.
3. A saved, empty recipient list for a kind must fall back to today's rule, not silently send to nobody — test in Task 5.
4. Upper/lower-case duplicates and blank entries in recipient lists (`A@x.com, a@x.com,,`) are sent once — test in Task 5.
5. The test email with an unreachable server must answer with the server's error text, not a 500 — test in Task 4.

---

### Task 1: SMTP settings rules (pure)

**Files:**
- Create: `oxeio-monitor/server/src/mail/smtp.settings.ts`
- Test: `oxeio-monitor/server/test/smtp-settings.spec.ts`

**Interfaces:**
- Produces:
  - `SMTP_SETTING_KEY = 'smtp'`
  - `interface SmtpConfig { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }`
  - `interface SmtpSaved { host?: string; port?: number; secure?: boolean | null; user?: string; pass?: string; from?: string }`
  - `type SmtpSource = 'database' | 'env' | 'none'`
  - `interface ResolvedSmtp { config: SmtpConfig | null; source: SmtpSource }`
  - `interface SmtpView { configured: boolean; source: SmtpSource; host: string; port: number; secure: boolean; user: string; passwordSet: boolean; from: string }`
  - `interface SmtpInput { host: string; port: number; secure?: boolean | null; user?: string; pass?: string; from?: string }`
  - `resolveSmtp(saved: SmtpSaved | null, env: Record<string, string | undefined>): ResolvedSmtp`
  - `smtpView(resolved: ResolvedSmtp): SmtpView`
  - `smtpSaveProblem(input: SmtpInput): string | null`
  - `mergeSmtpSave(previous: SmtpSaved | null, input: SmtpInput): SmtpSaved`

- [ ] **Step 1: Write the failing test**

```ts
// oxeio-monitor/server/test/smtp-settings.spec.ts
import { describe, expect, it } from 'vitest';

import {
  mergeSmtpSave,
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
      config: { host: 'mail.example.com', port: 587, secure: false, user: 'u', pass: 'p', from: 'Team <team@example.com>' },
    });
    expect(resolveSmtp(null, { SMTP_HOST: 'h', SMTP_PORT: '465' }).config?.secure).toBe(true);
    expect(resolveSmtp(null, { SMTP_HOST: 'h', SMTP_SECURE: 'true' }).config?.secure).toBe(true);
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
    expect(r.config).toEqual({ host: 'smtp.saved.test', port: 2525, secure: false, user: 'su', pass: undefined, from: 'oXeio <no-reply@smtp.saved.test>' });
  });

  it('a saved row without a host does not hide a working .env', () => {
    expect(resolveSmtp({ host: '  ' }, { SMTP_HOST: 'env.test' }).source).toBe('env');
  });
});

describe('smtpView — what the screen may see', () => {
  it('says whether a password is set, never the password', () => {
    const view = smtpView(resolveSmtp({ host: 'h', port: 587, user: 'u', pass: 'secret' }, {}));
    expect(view).toEqual({ configured: true, source: 'database', host: 'h', port: 587, secure: false, user: 'u', passwordSet: true, from: 'oXeio <no-reply@h>' });
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  it('off reads as an empty form', () => {
    expect(smtpView({ config: null, source: 'none' })).toEqual({ configured: false, source: 'none', host: '', port: 587, secure: false, user: '', passwordSet: false, from: '' });
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
    expect(smtpSaveProblem({ host: 'h', port: 587, from: 'Team' })).toMatch(/sender/);
    expect(smtpSaveProblem({ host: 'h', port: 587, from: 'Team <t@example.com>' })).toBeNull();
  });
});

describe('mergeSmtpSave', () => {
  it('an empty password keeps the stored one (fixing the host must not erase it)', () => {
    const next = mergeSmtpSave({ host: 'old', port: 587, user: 'u', pass: 'kept' }, { host: 'new', port: 587, user: 'u', pass: '' });
    expect(next).toEqual({ host: 'new', port: 587, secure: null, user: 'u', pass: 'kept', from: '' });
  });

  it('a typed password replaces it; fields are trimmed', () => {
    const next = mergeSmtpSave(null, { host: ' h ', port: 465, secure: true, user: ' u ', pass: 'new', from: ' a@b.c ' });
    expect(next).toEqual({ host: 'h', port: 465, secure: true, user: 'u', pass: 'new', from: 'a@b.c' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `oxeio-monitor/server`): `npm test -- test/smtp-settings.spec.ts`
Expected: FAIL — `Cannot find module '../src/mail/smtp.settings'`.

- [ ] **Step 3: Write the implementation**

```ts
// oxeio-monitor/server/src/mail/smtp.settings.ts
/**
 * SMTP settings — pure rules, no I/O.
 *
 * Saved on screen (Settings → Notifications) › the `SMTP_*` environment
 * variables › off. The screen only wins once it has a host, and its fields are
 * never mixed with the environment's: half of one and half of the other would
 * be a configuration nobody wrote.
 *
 * ⚠️ The password is write-only. `smtpView()` says whether one is set and
 *    nothing more; it never goes to the browser, the audit log or the log.
 */

export const SMTP_SETTING_KEY = 'smtp';

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = TLS from the first byte (port 465); false = STARTTLS */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface SmtpSaved {
  host?: string;
  port?: number;
  /** null = decide from the port (465 → true) */
  secure?: boolean | null;
  user?: string;
  pass?: string;
  from?: string;
}

export type SmtpSource = 'database' | 'env' | 'none';

export interface ResolvedSmtp {
  config: SmtpConfig | null;
  source: SmtpSource;
}

export interface SmtpView {
  configured: boolean;
  source: SmtpSource;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passwordSet: boolean;
  from: string;
}

/** What the SMTP card sends. An empty `pass` means "keep the stored one". */
export interface SmtpInput {
  host: string;
  port: number;
  secure?: boolean | null;
  user?: string;
  pass?: string;
  from?: string;
}

const DEFAULT_PORT = 587;
const IMPLICIT_TLS_PORT = 465;

function portOf(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

function senderOf(from: string | undefined, host: string): string {
  return from?.trim() || `oXeio <no-reply@${host}>`;
}

export function resolveSmtp(
  saved: SmtpSaved | null,
  env: Record<string, string | undefined>,
): ResolvedSmtp {
  const dbHost = saved?.host?.trim() ?? '';
  if (dbHost) {
    const port = portOf(saved?.port);
    return {
      source: 'database',
      config: {
        host: dbHost,
        port,
        secure: typeof saved?.secure === 'boolean' ? saved.secure : port === IMPLICIT_TLS_PORT,
        user: saved?.user?.trim() || undefined,
        pass: saved?.pass || undefined,
        from: senderOf(saved?.from, dbHost),
      },
    };
  }

  const envHost = env.SMTP_HOST?.trim() ?? '';
  if (envHost) {
    const port = portOf(env.SMTP_PORT);
    return {
      source: 'env',
      config: {
        host: envHost,
        port,
        // the rule the .env always had: SMTP_SECURE=true forces TLS, otherwise 465 means TLS
        secure: (env.SMTP_SECURE ?? '').toLowerCase() === 'true' ? true : port === IMPLICIT_TLS_PORT,
        user: env.SMTP_USER?.trim() || undefined,
        pass: env.SMTP_PASS || undefined,
        from: senderOf(env.SMTP_FROM, envHost),
      },
    };
  }

  return { config: null, source: 'none' };
}

export function smtpView(resolved: ResolvedSmtp): SmtpView {
  const c = resolved.config;
  return {
    configured: c !== null,
    source: resolved.source,
    host: c?.host ?? '',
    port: c?.port ?? DEFAULT_PORT,
    secure: c?.secure ?? false,
    user: c?.user ?? '',
    passwordSet: Boolean(c?.pass),
    from: c?.from ?? '',
  };
}

/** `null` if the card can be saved, otherwise the reason (English; translated on screen) */
export function smtpSaveProblem(input: SmtpInput): string | null {
  if (!input.host?.trim()) return 'Give the SMTP server host';
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return 'The SMTP port must be a number from 1 to 65535';
  }
  const from = input.from?.trim() ?? '';
  if (from && !/[^\s@<>]+@[^\s@<>]+/.test(from)) {
    return 'The sender must contain an email address';
  }
  return null;
}

/** The row to store: trimmed, with the old password kept when none was typed */
export function mergeSmtpSave(previous: SmtpSaved | null, input: SmtpInput): SmtpSaved {
  const typed = input.pass ?? '';
  return {
    host: input.host.trim(),
    port: input.port,
    secure: typeof input.secure === 'boolean' ? input.secure : null,
    user: input.user?.trim() ?? '',
    pass: typed.length > 0 ? typed : previous?.pass ?? '',
    from: input.from?.trim() ?? '',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/smtp-settings.spec.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add oxeio-monitor/server/src/mail/smtp.settings.ts oxeio-monitor/server/test/smtp-settings.spec.ts
git commit -m "feat(server): SMTP settings rules — screen over .env, write-only password"
```

---

### Task 2: The `mail/` module — mailer moved out of alerts, configured from settings

**Files:**
- Create: `oxeio-monitor/server/src/mail/mailer.ts`, `oxeio-monitor/server/src/mail/mail.module.ts`
- Delete: `oxeio-monitor/server/src/alerts/alerts.mailer.ts`
- Modify: `oxeio-monitor/server/src/settings/app-settings.service.ts` (add `smtp()`, `smtpSaved()`)
- Modify: `oxeio-monitor/server/src/app.module.ts` (import `MailModule`)
- Modify: `oxeio-monitor/server/src/alerts/alerts.module.ts`, `alerts/alerts.dispatcher.ts`, `alerts/alerts.constants.ts` (drop `SMTP_TIMEOUT_MS`)
- Modify: `oxeio-monitor/server/src/digest/digest.module.ts`, `digest/digest.service.ts`, `digest/weekly.service.ts`
- Modify: `oxeio-monitor/server/src/reports/reports.module.ts`, `reports/month-delivery.service.ts`
- Modify: `oxeio-monitor/server/test/digest.service.spec.ts`, `oxeio-monitor/server/test/weekly-digest.spec.ts`
- Test: `oxeio-monitor/server/test/mailer.spec.ts`

**Interfaces:**
- Consumes: `resolveSmtp`, `ResolvedSmtp`, `SmtpConfig`, `SmtpSaved`, `SMTP_SETTING_KEY` (Task 1).
- Produces:
  - `class Mailer` (global provider) with
    - `isConfigured(): Promise<boolean>`
    - `send(to: readonly string[], subject: string, body: string, attachments?: readonly MailAttachment[], html?: string): Promise<SendOutcome>`
    - `deliver(to: readonly string[], message: MailMessage): Promise<SendResult>`
    - `createTransport: TransportFactory` (public field, replaced in tests)
  - `interface MailAttachment { filename: string; content: Buffer; contentType: string }`
  - `interface MailMessage { subject: string; text: string; html?: string; attachments?: readonly MailAttachment[] }`
  - `type SendOutcome = 'sent' | 'not_configured' | 'failed'`
  - `interface SendResult { outcome: SendOutcome; error?: string }`
  - `AppSettingsService.smtp(): Promise<ResolvedSmtp>`, `AppSettingsService.smtpSaved(): Promise<SmtpSaved | null>`

- [ ] **Step 1: Write the failing test**

```ts
// oxeio-monitor/server/test/mailer.spec.ts
import { describe, expect, it } from 'vitest';

import { Mailer } from '../src/mail/mailer';
import { resolveSmtp, type SmtpConfig, type SmtpSaved } from '../src/mail/smtp.settings';
import type { AppSettingsService } from '../src/settings/app-settings.service';

/** The mailer reads SMTP at send time, so a change on screen applies at once. */

function harness(initial: SmtpSaved | null) {
  let saved = initial;
  const settings = { smtp: async () => resolveSmtp(saved, {}) } as unknown as AppSettingsService;
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
    const h = harness({ host: 'smtp.test', port: 587, from: 'Team <t@x.test>' });
    const result = await h.mailer.deliver(['a@x.test', 'b@x.test'], {
      subject: 'Hi',
      text: 'plain',
      html: '<p>rich</p>',
      attachments: [{ filename: 'f.xlsx', content: Buffer.from('x'), contentType: 'application/x' }],
    });
    expect(result).toEqual({ outcome: 'sent' });
    expect(h.sent[0]).toMatchObject({ from: 'Team <t@x.test>', to: 'a@x.test, b@x.test', subject: 'Hi', text: 'plain', html: '<p>rich</p>' });
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
    expect(await h.mailer.deliver(['a@x.test'], { subject: 's', text: 'b' })).toEqual({
      outcome: 'failed',
      error: '535 Authentication Credentials Invalid',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/mailer.spec.ts`
Expected: FAIL — `Cannot find module '../src/mail/mailer'`.

- [ ] **Step 3: Write the mailer and the module**

```ts
// oxeio-monitor/server/src/mail/mailer.ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import { AppSettingsService } from '../settings/app-settings.service';
import type { SmtpConfig } from './smtp.settings';

/**
 * The one way out for email: alerts, summaries, reports, the hours statement.
 *
 * The rule of this class: **it must never bring the server down.** A wrong
 * password, a hung server or a bad host name is a returned value, never an
 * exception, and `verify()` is never called.
 *
 * SMTP is read from the settings on every send (cached by the settings
 * service), so a change on screen applies to the next email; the transport is
 * rebuilt only when the configuration actually changed.
 */

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  subject: string;
  text: string;
  /** optional rich version; mail clients that cannot show it use `text` */
  html?: string;
  attachments?: readonly MailAttachment[];
}

export type SendOutcome = 'sent' | 'not_configured' | 'failed';

export interface SendResult {
  outcome: SendOutcome;
  /** the server's own words when it failed (shown by the test email) */
  error?: string;
}

/** Only what is used of nodemailer's Transporter, so an upgrade shows what breaks */
interface MailSender {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    attachments?: MailAttachment[];
  }): Promise<unknown>;
  close(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type TransportFactory = (config: SmtpConfig) => MailSender;

/** nodemailer's own timeouts are minutes long; a dead server would hang every sweep */
export const SMTP_TIMEOUT_MS = 10_000;

const nodemailerTransport: TransportFactory = (c) =>
  createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

@Injectable()
export class Mailer implements OnModuleDestroy {
  private readonly logger = new Logger(Mailer.name);
  private transporter: MailSender | null = null;
  private transporterKey = '';
  /** no point logging the same complaint every minute */
  private warnedMissing = false;

  /** nodemailer in production; tests put a fake here */
  createTransport: TransportFactory = nodemailerTransport;

  constructor(private readonly settings: AppSettingsService) {}

  async isConfigured(): Promise<boolean> {
    return (await this.settings.smtp()).config !== null;
  }

  async send(
    to: readonly string[],
    subject: string,
    body: string,
    attachments?: readonly MailAttachment[],
    html?: string,
  ): Promise<SendOutcome> {
    return (await this.deliver(to, { subject, text: body, html, attachments })).outcome;
  }

  async deliver(to: readonly string[], message: MailMessage): Promise<SendResult> {
    const { config } = await this.settings.smtp();
    if (!config || to.length === 0) {
      if (!this.warnedMissing) {
        this.warnedMissing = true;
        this.logger.warn(config ? 'An email had no recipients' : 'No SMTP configured — emails are not being sent');
      }
      return { outcome: 'not_configured' };
    }

    try {
      await this.transportFor(config).sendMail({
        from: config.from,
        to: to.join(', '),
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        // when empty the key is left out: some servers still wrap an empty multipart
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: [...message.attachments] }
          : {}),
      });
      return { outcome: 'sent' };
    } catch (err) {
      // the message only: an SMTP error object can carry the auth string
      const error = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`Could not send email: ${error}`);
      this.dispose();
      return { outcome: 'failed', error };
    }
  }

  onModuleDestroy(): void {
    this.dispose();
  }

  private transportFor(config: SmtpConfig): MailSender {
    const key = JSON.stringify(config);
    if (this.transporter && this.transporterKey === key) return this.transporter;

    this.dispose();
    const transporter = this.createTransport(config);
    // an EventEmitter with no 'error' listener kills the process
    transporter.on('error', (err: Error) => this.logger.error(`SMTP connection error: ${err.message}`));
    this.transporter = transporter;
    this.transporterKey = key;
    return transporter;
  }

  private dispose(): void {
    try {
      this.transporter?.close();
    } catch {
      // nothing to do if closing fails
    }
    this.transporter = null;
    this.transporterKey = '';
  }
}
```

```ts
// oxeio-monitor/server/src/mail/mail.module.ts
import { Global, Module } from '@nestjs/common';

import { Mailer } from './mailer';

/**
 * Email for every module. Global, like settings and features, so alerts,
 * digests and reports share one transport instead of each providing its own.
 */
@Global()
@Module({
  providers: [Mailer],
  exports: [Mailer],
})
export class MailModule {}
```

- [ ] **Step 4: Give the settings service its SMTP reader**

In `oxeio-monitor/server/src/settings/app-settings.service.ts` add the import and two methods (next to `errorReporting()`):

```ts
import { resolveSmtp, SMTP_SETTING_KEY, type ResolvedSmtp, type SmtpSaved } from '../mail/smtp.settings';
```

```ts
  /** SMTP — Settings → Notifications, or SMTP_* in the .env */
  async smtp(): Promise<ResolvedSmtp> {
    return resolveSmtp(await this.smtpSaved(), process.env);
  }

  async smtpSaved(): Promise<SmtpSaved | null> {
    return this.read<SmtpSaved>(SMTP_SETTING_KEY);
  }
```

- [ ] **Step 5: Wire the module and move every caller**

1. `app.module.ts`: add `MailModule` to `imports` (import from `./mail/mail.module`).
2. Delete `src/alerts/alerts.mailer.ts`. Remove `SMTP_TIMEOUT_MS` from `src/alerts/alerts.constants.ts` (now in `mail/mailer.ts`).
3. Remove `AlertMailer` from the `providers` arrays (and its import) in `alerts/alerts.module.ts`, `digest/digest.module.ts`, `reports/reports.module.ts`. Delete the comments in `digest.module.ts` and `reports.module.ts` that explain why `AlertMailer` was provided again — the reason is gone.
4. In `alerts/alerts.dispatcher.ts`, `digest/digest.service.ts`, `digest/weekly.service.ts`, `reports/month-delivery.service.ts`: replace
   `import { AlertMailer ... } from '../alerts/alerts.mailer';` with `import { Mailer ... } from '../mail/mailer';` and the constructor type `AlertMailer` with `Mailer` (keep the field name `mailer`).
5. Replace each `this.mailer.configured` (three places: `alerts.dispatcher.ts:78`, `weekly.service.ts:145`, `month-delivery.service.ts:144`) with `(await this.mailer.isConfigured())`.
6. Tests: in `test/digest.service.spec.ts` and `test/weekly-digest.spec.ts` change `import type { AlertMailer, SendOutcome } from '../src/alerts/alerts.mailer'` to `import type { Mailer, SendOutcome } from '../src/mail/mailer'`, the cast `as unknown as AlertMailer` to `as unknown as Mailer`, and any `configured: <bool>` in the fake to `isConfigured: async () => <bool>`.
7. Check nothing still points at the old file:

Run: `grep -rn "alerts.mailer\|AlertMailer" oxeio-monitor/server/src oxeio-monitor/server/test`
Expected: no output.

- [ ] **Step 6: Run the tests**

Run: `npm test -- test/mailer.spec.ts test/digest.service.spec.ts test/weekly-digest.spec.ts test/month-delivery.spec.ts test/alerts.rules.spec.ts`
Expected: PASS. Then `npm run typecheck` — expected: no errors.

- [ ] **Step 7: Update the architecture map and commit**

In `docs/ARCHITECTURE.md`, API table: add the row
`| `mail/` | sending email for every module (SMTP from Settings → Notifications or the .env), recipients per kind of email, email text in the company language |`
and in the `alerts/` row replace "dispatch to email / Telegram / Teams" with "dispatch to email (through `mail/`) / Telegram / Teams".

```bash
git add -A oxeio-monitor/server docs/ARCHITECTURE.md
git commit -m "refactor(server): one mail module for every email, SMTP read from settings at send time"
```

---

### Task 3: Email text in the company language (pure)

**Files:**
- Create: `oxeio-monitor/server/src/mail/mail-text.ts`
- Test: `oxeio-monitor/server/test/mail-text.spec.ts`

**Interfaces:**
- Consumes: `Language`, `LANGUAGES` from `src/settings/languages.ts`.
- Produces:
  - `type MailKey` (keys of the English catalog)
  - `mailText(lang: Language, key: MailKey, vars?: Record<string, string | number>): string`
  - `hoursAndMinutes(totalMinutes: number, lang: Language): string` — `"173 h 25 min"`, sign kept
  - `MAIL_CATALOG: Record<Language, Record<MailKey, string>>` (exported for the completeness test; Delivery 4 adds keys to all three)

- [ ] **Step 1: Write the failing test**

```ts
// oxeio-monitor/server/test/mail-text.spec.ts
import { describe, expect, it } from 'vitest';

import { hoursAndMinutes, MAIL_CATALOG, mailText } from '../src/mail/mail-text';
import { LANGUAGES } from '../src/settings/languages';

describe('mailText', () => {
  it('fills the placeholders, in each language', () => {
    expect(mailText('en', 'smtpTest.subject', { org: 'Acme' })).toBe('Acme — test email');
    expect(mailText('pt-BR', 'smtpTest.subject', { org: 'Acme' })).toBe('Acme — e-mail de teste');
    expect(mailText('es', 'smtpTest.subject', { org: 'Acme' })).toBe('Acme — correo de prueba');
  });

  it('an unknown placeholder stays visible instead of vanishing', () => {
    expect(mailText('en', 'smtpTest.subject')).toBe('{org} — test email');
  });

  it('every language has every key, none empty', () => {
    const keys = Object.keys(MAIL_CATALOG.en).sort();
    for (const lang of LANGUAGES) {
      expect(Object.keys(MAIL_CATALOG[lang]).sort()).toEqual(keys);
      for (const key of keys) expect(MAIL_CATALOG[lang][key as keyof typeof MAIL_CATALOG.en].trim()).not.toBe('');
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/mail-text.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// oxeio-monitor/server/src/mail/mail-text.ts
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
  'smtpTest.body': 'This is a test email from oXeio, sent by {by}.\nIf you can read this, sending email works.',
  'unit.hours': 'h',
  'unit.minutes': 'min',
} as const;

export type MailKey = keyof typeof EN;

export const MAIL_CATALOG: Record<Language, Record<MailKey, string>> = {
  en: EN,
  'pt-BR': {
    'smtpTest.subject': '{org} — e-mail de teste',
    'smtpTest.body': 'Este é um e-mail de teste do oXeio, enviado por {by}.\nSe você está lendo isto, o envio de e-mails funciona.',
    'unit.hours': 'h',
    'unit.minutes': 'min',
  },
  es: {
    'smtpTest.subject': '{org} — correo de prueba',
    'smtpTest.body': 'Este es un correo de prueba de oXeio, enviado por {by}.\nSi puede leer esto, el envío de correos funciona.',
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/mail-text.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add oxeio-monitor/server/src/mail/mail-text.ts oxeio-monitor/server/test/mail-text.spec.ts
git commit -m "feat(server): email text catalog in English, Portuguese and Spanish"
```

---

### Task 4: SMTP on screen — endpoints, test email, back to .env

**Files:**
- Create: `oxeio-monitor/server/src/mail/smtp.controller.ts`
- Modify: `oxeio-monitor/server/src/mail/mail.module.ts` (add controller)
- Modify: `oxeio-monitor/server/src/settings/settings.controller.ts` (`ENV_SUBJECTS.smtp`)
- Test: `oxeio-monitor/server/test/smtp-settings.e2e.spec.ts`

**Interfaces:**
- Consumes: `Mailer.deliver`, `AppSettingsService.smtp/smtpSaved/replace/region/organization`, `smtpView`, `smtpSaveProblem`, `mergeSmtpSave`, `mailText`.
- Produces (HTTP, owner only):
  - `GET /api/v1/settings/smtp` → `SmtpView`
  - `PATCH /api/v1/settings/smtp` body `SmtpInput` → `SmtpView`
  - `POST /api/v1/settings/smtp/test` body `{ to?: string }` → `{ outcome: SendOutcome; error?: string; to: string }`
  - `DELETE /api/v1/settings/env/smtp` (existing route, new subject)

- [ ] **Step 1: Write the failing e2e test**

```ts
// oxeio-monitor/server/test/smtp-settings.e2e.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

let h: Harness;
let owner: Session;
const saved = { ...process.env };

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  process.env = saved;
  await h.close();
});
beforeEach(async () => {
  delete process.env.SMTP_HOST;
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

const patch = (s: Session, body: object) =>
  s.http.patch('/api/v1/settings/smtp').set('X-CSRF-Token', s.csrf).send(body);
const testMail = (s: Session, body: object = {}) =>
  s.http.post('/api/v1/settings/smtp/test').set('X-CSRF-Token', s.csrf).send(body);

describe('SMTP on screen', () => {
  it('starts off; a save applies and never returns the password', async () => {
    expect((await owner.http.get('/api/v1/settings/smtp').expect(200)).body).toMatchObject({ configured: false, source: 'none' });

    const res = await patch(owner, { host: 'smtp.example.test', port: 587, user: 'u', pass: 'top-secret', from: 'Team <t@example.test>' }).expect(200);
    expect(res.body).toMatchObject({ configured: true, source: 'database', host: 'smtp.example.test', passwordSet: true });
    expect(JSON.stringify(res.body)).not.toContain('top-secret');
  });

  it('saving again with an empty password keeps the stored one', async () => {
    await patch(owner, { host: 'a.test', port: 587, user: 'u', pass: 'kept' }).expect(200);
    await patch(owner, { host: 'b.test', port: 587, user: 'u', pass: '' }).expect(200);
    const row = await h.prisma.setting.findUniqueOrThrow({ where: { key: 'smtp' } });
    expect(row.value).toMatchObject({ host: 'b.test', pass: 'kept' });
  });

  it('the audit log records the change without the password', async () => {
    await patch(owner, { host: 'a.test', port: 587, pass: 'never-logged' }).expect(200);
    const audit = await h.prisma.auditLog.findMany({ where: { targetId: 'smtp' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('never-logged');
  });

  it('a bad port is a 400 with a reason', async () => {
    const res = await patch(owner, { host: 'a.test', port: 0 }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/port/);
  });

  it('"Use the .env value" forgets the screen', async () => {
    process.env.SMTP_HOST = 'env.example.test';
    await patch(owner, { host: 'a.test', port: 587 }).expect(200);
    await owner.http.delete('/api/v1/settings/env/smtp').set('X-CSRF-Token', owner.csrf).expect(200);
    expect((await owner.http.get('/api/v1/settings/smtp').expect(200)).body).toMatchObject({ source: 'env', host: 'env.example.test' });
  });

  it('test email: not configured when nothing is set', async () => {
    const res = await testMail(owner).expect(201);
    expect(res.body).toMatchObject({ outcome: 'not_configured', to: OWNER_EMAIL });
  });

  it('test email: an unreachable server answers with its error text, not a 500', async () => {
    await patch(owner, { host: '127.0.0.1', port: 1 }).expect(200);
    const res = await testMail(owner, { to: 'someone@example.test' }).expect(201);
    expect(res.body.outcome).toBe('failed');
    expect(res.body.to).toBe('someone@example.test');
    expect(typeof res.body.error).toBe('string');
  });

  it('managers cannot read or change it', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/settings/smtp').expect(403);
    await patch(manager, { host: 'a.test', port: 587 }).expect(403);
  });
});
```

`resetDatabase()` creates both the owner and the manager accounts, so `loginReady` works for both.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/smtp-settings.e2e.spec.ts`
Expected: FAIL — 404 on `/api/v1/settings/smtp`.

- [ ] **Step 3: Write the controller**

```ts
// oxeio-monitor/server/src/mail/smtp.controller.ts
import { BadRequestException, Body, Controller, Get, Ip, Patch, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { AppSettingsService } from '../settings/app-settings.service';
import { mailText } from './mail-text';
import { Mailer, type SendResult } from './mailer';
import {
  mergeSmtpSave,
  SMTP_SETTING_KEY,
  smtpSaveProblem,
  smtpView,
  type SmtpView,
} from './smtp.settings';

class SaveSmtpDto {
  @IsString() @MaxLength(255)
  host!: string;

  @IsInt() @Min(1) @Max(65535)
  port!: number;

  /** null = decide from the port */
  @IsOptional() @IsBoolean()
  secure?: boolean | null;

  @IsOptional() @IsString() @MaxLength(255)
  user?: string;

  /** empty = keep the stored password */
  @IsOptional() @IsString() @MaxLength(500)
  pass?: string;

  @IsOptional() @IsString() @MaxLength(255)
  from?: string;
}

class TestSmtpDto {
  @IsOptional() @IsEmail()
  to?: string;
}

/**
 * SMTP from the screen, owner only: who receives everyone's figures is not a
 * manager's decision. The password goes in, never out.
 */
@Roles(UserRole.owner)
@Controller('settings/smtp')
export class SmtpSettingsController {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly mailer: Mailer,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async read(): Promise<SmtpView> {
    return smtpView(await this.settings.smtp());
  }

  @Patch()
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveSmtpDto,
    @Ip() ip: string,
  ): Promise<SmtpView> {
    const problem = smtpSaveProblem(dto);
    if (problem) throw new BadRequestException(problem);

    const next = mergeSmtpSave(await this.settings.smtpSaved(), dto);
    await this.settings.replace(SMTP_SETTING_KEY, { ...next }, actor.userId);

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'setting',
      targetId: SMTP_SETTING_KEY,
      ipAddress: ip,
      // never the password: the audit log is read by managers and kept forever
      meta: { op: 'smtp', host: next.host, port: next.port, passwordChanged: (dto.pass ?? '').length > 0 },
    });

    return this.read();
  }

  /** Sends one email now and says what the server answered */
  @Post('test')
  async test(
    @CurrentUser() actor: SessionUser,
    @Body() dto: TestSmtpDto,
  ): Promise<SendResult & { to: string }> {
    const to = dto.to?.trim() || actor.email;
    const lang = (await this.settings.region()).language.value;
    const org = (await this.settings.organization()).name;

    const result = await this.mailer.deliver([to], {
      subject: mailText(lang, 'smtpTest.subject', { org }),
      text: mailText(lang, 'smtpTest.body', { by: actor.email }),
    });
    return { ...result, to };
  }
}
```

In `mail.module.ts` add `controllers: [SmtpSettingsController]`.

In `settings/settings.controller.ts` import `SMTP_SETTING_KEY` from `'../mail/smtp.settings'` and add `smtp: [SMTP_SETTING_KEY],` to `ENV_SUBJECTS`.

If `SessionUser` has no `email` field, read it the way `alerts/telegram.controller.ts` does (`actor.email` is used there, so it exists).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/smtp-settings.e2e.spec.ts test/settings-ui.e2e.spec.ts test/endpoints.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add oxeio-monitor/server/src/mail oxeio-monitor/server/src/settings/settings.controller.ts oxeio-monitor/server/test/smtp-settings.e2e.spec.ts
git commit -m "feat(server): SMTP on Settings → Notifications with a test email"
```

---

### Task 5: Recipients per kind of email

**Files:**
- Create: `oxeio-monitor/server/src/mail/recipients.rules.ts`, `oxeio-monitor/server/src/mail/recipients.service.ts`, `oxeio-monitor/server/src/mail/recipients.controller.ts`
- Delete: `oxeio-monitor/server/src/digest/digest.recipients.ts`, `oxeio-monitor/server/test/digest-recipients.spec.ts`
- Modify: `mail/mail.module.ts`, `settings/app-settings.service.ts` (`recipients()`), `settings/settings.controller.ts` (`ENV_SUBJECTS.recipients`)
- Modify callers: `alerts/alerts.dispatcher.ts`, `digest/digest.service.ts`, `digest/weekly.service.ts`, `reports/month-delivery.service.ts` and their test fakes in `test/digest.service.spec.ts`, `test/weekly-digest.spec.ts`
- Test: `oxeio-monitor/server/test/recipients.rules.spec.ts`, `oxeio-monitor/server/test/mail-recipients.e2e.spec.ts`

**Interfaces:**
- Produces:
  - `RECIPIENTS_SETTING_KEY = 'mail.recipients'`
  - `MAIL_KINDS = ['alerts', 'dailyDigest', 'weeklyDigest', 'monthClosed'] as const`; `type MailKind`
  - `type RecipientsSaved = Partial<Record<MailKind, string[]>>`
  - `ENV_FALLBACK: Record<MailKind, 'ALERT_EMAIL_TO' | 'DIGEST_EMAIL_TO'>`
  - `cleanAddresses(raw: readonly string[]): string[]`, `splitList(value: string | undefined): string[]`
  - `recipientsFor(input: { kind: MailKind; saved: RecipientsSaved | null; env: Record<string, string | undefined>; owners: readonly string[] }): string[]`
  - `recipientsSaveProblem(value: unknown): string | null`
  - `class MailRecipients { for(kind: MailKind): Promise<string[]> }` (exported from `MailModule`)
  - `AppSettingsService.recipients(): Promise<RecipientsSaved | null>`
  - HTTP (owner): `GET /api/v1/settings/mail-recipients` → `{ kinds: { kind: MailKind; saved: string[]; effective: string[]; envVariable: string }[] }`; `PUT /api/v1/settings/mail-recipients` body `RecipientsSaved` → same shape.
- Delivery 4 extends `MAIL_KINDS` with `'hoursStatement'`; keep the rule a `switch`-free lookup so that change is one line plus one rule.

- [ ] **Step 1: Write the failing rules test**

```ts
// oxeio-monitor/server/test/recipients.rules.spec.ts
import { describe, expect, it } from 'vitest';

import {
  cleanAddresses,
  recipientsFor,
  recipientsSaveProblem,
  splitList,
} from '../src/mail/recipients.rules';

const owners = ['owner@x.test'];

describe('cleanAddresses / splitList', () => {
  it('trims, drops blanks and case-insensitive duplicates, keeps order', () => {
    expect(cleanAddresses([' A@x.test', 'a@x.test', '', 'b@x.test '])).toEqual(['A@x.test', 'b@x.test']);
    expect(splitList('a@x.test,, b@x.test ,')).toEqual(['a@x.test', 'b@x.test']);
    expect(splitList(undefined)).toEqual([]);
  });
});

describe('recipientsFor — saved list › env › owners', () => {
  it('a saved list wins', () => {
    expect(recipientsFor({ kind: 'dailyDigest', saved: { dailyDigest: ['d@x.test'] }, env: { DIGEST_EMAIL_TO: 'e@x.test' }, owners })).toEqual(['d@x.test']);
  });

  it('a saved but empty list falls back to today’s rule — never to nobody', () => {
    expect(recipientsFor({ kind: 'dailyDigest', saved: { dailyDigest: [] }, env: {}, owners })).toEqual(owners);
  });

  it('each kind keeps its old environment variable', () => {
    const env = { ALERT_EMAIL_TO: 'ops@x.test', DIGEST_EMAIL_TO: 'boss@x.test' };
    expect(recipientsFor({ kind: 'alerts', saved: null, env, owners })).toEqual(['ops@x.test']);
    expect(recipientsFor({ kind: 'dailyDigest', saved: null, env, owners })).toEqual(['boss@x.test']);
    expect(recipientsFor({ kind: 'weeklyDigest', saved: null, env, owners })).toEqual(['boss@x.test']);
    expect(recipientsFor({ kind: 'monthClosed', saved: null, env, owners })).toEqual(['boss@x.test']);
  });

  it('alerts never fall back to DIGEST_EMAIL_TO, nor digests to ALERT_EMAIL_TO', () => {
    expect(recipientsFor({ kind: 'alerts', saved: null, env: { DIGEST_EMAIL_TO: 'boss@x.test' }, owners })).toEqual(owners);
    expect(recipientsFor({ kind: 'dailyDigest', saved: null, env: { ALERT_EMAIL_TO: 'ops@x.test' }, owners })).toEqual(owners);
  });
});

describe('recipientsSaveProblem', () => {
  it('accepts known kinds with email lists', () => {
    expect(recipientsSaveProblem({ alerts: ['a@x.test'], monthClosed: [] })).toBeNull();
  });
  it('refuses unknown kinds, non-lists and bad addresses', () => {
    expect(recipientsSaveProblem({ nope: [] })).toMatch(/kind/);
    expect(recipientsSaveProblem({ alerts: 'a@x.test' })).toMatch(/list/);
    expect(recipientsSaveProblem({ alerts: ['not-an-email'] })).toMatch(/not-an-email/);
    expect(recipientsSaveProblem({ alerts: Array.from({ length: 21 }, (_, i) => `p${i}@x.test`) })).toMatch(/20/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- test/recipients.rules.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the rules**

```ts
// oxeio-monitor/server/src/mail/recipients.rules.ts
/**
 * Who receives each kind of email — pure rules.
 *
 * The mistake this guards against is big: these emails carry every person's
 * name and hours, and once sent they cannot be taken back. So the order is
 * fixed and the same for every kind: the list saved on screen › the kind's
 * old environment variable › the active owners. Managers are never added.
 */

export const RECIPIENTS_SETTING_KEY = 'mail.recipients';

export const MAIL_KINDS = ['alerts', 'dailyDigest', 'weeklyDigest', 'monthClosed'] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export type RecipientsSaved = Partial<Record<MailKind, string[]>>;

/** The variable each kind read before this screen existed (alerts and digests never shared one) */
export const ENV_FALLBACK: Record<MailKind, 'ALERT_EMAIL_TO' | 'DIGEST_EMAIL_TO'> = {
  alerts: 'ALERT_EMAIL_TO',
  dailyDigest: 'DIGEST_EMAIL_TO',
  weeklyDigest: 'DIGEST_EMAIL_TO',
  monthClosed: 'DIGEST_EMAIL_TO',
};

const MAX_PER_KIND = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isMailKind(value: unknown): value is MailKind {
  return typeof value === 'string' && (MAIL_KINDS as readonly string[]).includes(value);
}

/** Trimmed, blanks dropped, `A@x` and `a@x` sent once — first spelling kept */
export function cleanAddresses(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const email = entry.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export function splitList(value: string | undefined): string[] {
  return cleanAddresses((value ?? '').split(','));
}

export interface RecipientsInput {
  kind: MailKind;
  saved: RecipientsSaved | null;
  env: Record<string, string | undefined>;
  owners: readonly string[];
}

export function recipientsFor(input: RecipientsInput): string[] {
  const saved = cleanAddresses(input.saved?.[input.kind] ?? []);
  if (saved.length > 0) return saved;

  const fromEnv = splitList(input.env[ENV_FALLBACK[input.kind]]);
  if (fromEnv.length > 0) return fromEnv;

  return cleanAddresses(input.owners);
}

/** `null` if the body can be stored, otherwise the reason */
export function recipientsSaveProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'Send an object of email lists, one per kind of email';
  }
  for (const [kind, list] of Object.entries(value)) {
    if (!isMailKind(kind)) return `Unknown kind of email: ${kind}`;
    if (!Array.isArray(list)) return `The ${kind} recipients must be a list`;
    if (list.length > MAX_PER_KIND) return `At most ${MAX_PER_KIND} addresses per kind of email`;
    for (const email of list) {
      if (typeof email !== 'string' || !EMAIL.test(email.trim())) {
        return `Not an email address: ${String(email)}`;
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the rules test**

Run: `npm test -- test/recipients.rules.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the service and controller**

```ts
// oxeio-monitor/server/src/mail/recipients.service.ts
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { recipientsFor, type MailKind } from './recipients.rules';

/** The addresses for one kind of email, right now */
@Injectable()
export class MailRecipients {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AppSettingsService,
  ) {}

  async for(kind: MailKind): Promise<string[]> {
    const [saved, owners] = await Promise.all([
      this.settings.recipients(),
      this.prisma.user.findMany({
        where: { role: 'owner', isActive: true },
        select: { email: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    return recipientsFor({ kind, saved, env: process.env, owners: owners.map((o) => o.email) });
  }
}
```

```ts
// oxeio-monitor/server/src/mail/recipients.controller.ts
import { BadRequestException, Body, Controller, Get, Ip, Put } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { AppSettingsService } from '../settings/app-settings.service';
import {
  cleanAddresses,
  ENV_FALLBACK,
  MAIL_KINDS,
  RECIPIENTS_SETTING_KEY,
  recipientsSaveProblem,
  type MailKind,
  type RecipientsSaved,
} from './recipients.rules';
import { MailRecipients } from './recipients.service';

export interface RecipientsView {
  kinds: { kind: MailKind; saved: string[]; effective: string[]; envVariable: string }[];
}

/** Who receives which email — owner only, like every list that carries everyone's hours */
@Roles(UserRole.owner)
@Controller('settings/mail-recipients')
export class MailRecipientsController {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly recipients: MailRecipients,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async read(): Promise<RecipientsView> {
    const saved = (await this.settings.recipients()) ?? {};
    const kinds = await Promise.all(
      MAIL_KINDS.map(async (kind) => ({
        kind,
        saved: cleanAddresses(saved[kind] ?? []),
        effective: await this.recipients.for(kind),
        envVariable: ENV_FALLBACK[kind],
      })),
    );
    return { kinds };
  }

  /**
   * The body is validated by `recipientsSaveProblem` instead of a DTO class:
   * its keys are the kinds of email, and a class would have to list them twice.
   */
  @Put()
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() body: unknown,
    @Ip() ip: string,
  ): Promise<RecipientsView> {
    const problem = recipientsSaveProblem(body);
    if (problem) throw new BadRequestException(problem);

    const next: RecipientsSaved = {};
    for (const [kind, list] of Object.entries(body as Record<MailKind, string[]>)) {
      next[kind as MailKind] = cleanAddresses(list);
    }
    await this.settings.replace(RECIPIENTS_SETTING_KEY, next, actor.userId);
    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'setting',
      targetId: RECIPIENTS_SETTING_KEY,
      ipAddress: ip,
      meta: { op: 'mail_recipients', counts: Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v.length])) },
    });
    return this.read();
  }
}
```

The global `ValidationPipe` (`app.setup.ts`) runs with `whitelist` and `forbidNonWhitelisted`, but it only validates class types: `@Body() body: unknown` reaches the handler as sent, and `recipientsSaveProblem` is the validation.

In `mail.module.ts`: `providers: [Mailer, MailRecipients]`, `exports: [Mailer, MailRecipients]`, `controllers: [SmtpSettingsController, MailRecipientsController]`.

In `app-settings.service.ts`:

```ts
import { RECIPIENTS_SETTING_KEY, type RecipientsSaved } from '../mail/recipients.rules';
```

```ts
  /** Saved recipient lists per kind of email (Settings → Notifications) */
  async recipients(): Promise<RecipientsSaved | null> {
    return this.read<RecipientsSaved>(RECIPIENTS_SETTING_KEY);
  }
```

In `settings.controller.ts` add `recipients: [RECIPIENTS_SETTING_KEY],` to `ENV_SUBJECTS`.

- [ ] **Step 6: Move every sender to `MailRecipients`**

1. `alerts/alerts.dispatcher.ts`: inject `private readonly recipientsOf: MailRecipients`; delete the `explicitRecipients` field and its constructor code; make `recipients()` return `this.recipientsOf.for('alerts')`. Drop the `ConfigService` parameter if nothing else uses it.
2. `digest/digest.service.ts`: same, with `for('dailyDigest')`; delete `explicitRecipients` and the comment about `ALERT_EMAIL_TO` (the rule now lives in `ENV_FALLBACK`).
3. `digest/weekly.service.ts`: same with `for('weeklyDigest')`; delete `digestEmailTo`.
4. `reports/month-delivery.service.ts`: in `emailIt()` replace the owners query and `digestRecipients(...)` with `const to = await this.recipients.for('monthClosed');`; delete `digestEmailTo`.
5. Delete `digest/digest.recipients.ts` and `test/digest-recipients.spec.ts` (its cases now live in `recipients.rules.spec.ts`).
6. In `test/digest.service.spec.ts` and `test/weekly-digest.spec.ts`, pass a fake `{ for: async () => ['owner@x.test'] } as unknown as MailRecipients` where the services are constructed, replacing any `DIGEST_EMAIL_TO` the fake config carried; adjust expectations that relied on `DIGEST_EMAIL_TO` to the fake's list.

Run: `grep -rn "digestRecipients\|DIGEST_EMAIL_TO\|ALERT_EMAIL_TO" oxeio-monitor/server/src`
Expected: only `mail/recipients.rules.ts`.

- [ ] **Step 7: Write the e2e test**

```ts
// oxeio-monitor/server/test/mail-recipients.e2e.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

let h: Harness;
let owner: Session;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  delete process.env.DIGEST_EMAIL_TO;
  delete process.env.ALERT_EMAIL_TO;
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

const put = (body: object) =>
  owner.http.put('/api/v1/settings/mail-recipients').set('X-CSRF-Token', owner.csrf).send(body);

describe('recipients per kind of email', () => {
  it('by default every kind goes to the owners', async () => {
    const res = await owner.http.get('/api/v1/settings/mail-recipients').expect(200);
    for (const k of res.body.kinds) expect(k.effective).toEqual([OWNER_EMAIL]);
  });

  it('a saved list replaces the owners for that kind only', async () => {
    const res = await put({ dailyDigest: ['Boss@x.test', 'boss@x.test'] }).expect(200);
    const byKind = Object.fromEntries(res.body.kinds.map((k: { kind: string; effective: string[] }) => [k.kind, k.effective]));
    expect(byKind.dailyDigest).toEqual(['Boss@x.test']);
    expect(byKind.alerts).toEqual([OWNER_EMAIL]);
  });

  it('a bad address is a 400 naming it', async () => {
    const res = await put({ alerts: ['nope'] }).expect(400);
    expect(JSON.stringify(res.body)).toContain('nope');
  });
});
```

- [ ] **Step 8: Run the server suites**

Run: `npm test -- test/recipients.rules.spec.ts test/mail-recipients.e2e.spec.ts test/digest.service.spec.ts test/weekly-digest.spec.ts test/month-delivery.spec.ts test/endpoints.e2e.spec.ts`
Expected: PASS. Then `npm run typecheck && npm run lint` — expected: clean.

- [ ] **Step 9: Commit**

```bash
git add -A oxeio-monitor/server
git commit -m "feat(server): recipients chosen per kind of email (screen › env › owners)"
```

---

### Task 6: Dashboard — Email cards on Settings → Notifications

**Files:**
- Create: `oxeio-monitor/web/src/pages/settings/EmailCards.tsx`, `oxeio-monitor/web/src/pages/settings/email.math.ts`
- Modify: `oxeio-monitor/web/src/api/settings.ts` (types + calls; `EnvSubject` gains `'smtp' | 'recipients'`)
- Modify: `oxeio-monitor/web/src/pages/settings/NotificationsTab.tsx` (render the cards above Telegram)
- Modify: `oxeio-monitor/web/src/i18n/locales/pt-BR/settings-system.json`, `oxeio-monitor/web/src/i18n/locales/es/settings-system.json`, and both `server.json` (new server messages)
- Test: `oxeio-monitor/web/test/email-settings.spec.ts`

**Interfaces:**
- Consumes (HTTP): Task 4 and Task 5 endpoints.
- Produces: `parseAddressList(text: string): string[]`, `formatAddressList(list: readonly string[]): string`, `testResultKey(outcome: 'sent' | 'not_configured' | 'failed'): string` in `email.math.ts`; `SmtpCard`, `RecipientsCard` components.

- [ ] **Step 1: Write the failing test**

```ts
// oxeio-monitor/web/test/email-settings.spec.ts
import { describe, expect, it } from 'vitest';

import { formatAddressList, parseAddressList, testResultKey } from '../src/pages/settings/email.math';

describe('address lists typed in a text box', () => {
  it('accepts commas, semicolons and new lines; drops blanks and duplicates', () => {
    expect(parseAddressList('a@x.test, b@x.test;\nA@x.test\n\n')).toEqual(['a@x.test', 'b@x.test']);
  });
  it('shows one address per line', () => {
    expect(formatAddressList(['a@x.test', 'b@x.test'])).toBe('a@x.test\nb@x.test');
  });
});

describe('test email result', () => {
  it('maps each outcome to a sentence key', () => {
    expect(testResultKey('sent')).toBe('✓ Sent. Check the inbox (and the spam folder).');
    expect(testResultKey('not_configured')).toBe('Email is not set up yet — fill in the server above and save.');
    expect(testResultKey('failed')).toBe('The mail server refused or could not be reached:');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (in `oxeio-monitor/web`): `npm test -- test/email-settings.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `email.math.ts` and the API calls**

```ts
// oxeio-monitor/web/src/pages/settings/email.math.ts
/** Address lists typed by hand: any of , ; or new line separates them */
export function parseAddressList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,;\n]/)) {
    const email = part.trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(email);
  }
  return out;
}

export function formatAddressList(list: readonly string[]): string {
  return list.join('\n');
}

/** English sentence keys, translated where shown */
export function testResultKey(outcome: 'sent' | 'not_configured' | 'failed'): string {
  switch (outcome) {
    case 'sent':
      return '✓ Sent. Check the inbox (and the spam folder).';
    case 'not_configured':
      return 'Email is not set up yet — fill in the server above and save.';
    default:
      return 'The mail server refused or could not be reached:';
  }
}
```

Append to `oxeio-monitor/web/src/api/settings.ts`:

```ts
/** SMTP — server `mail/smtp.controller.ts`. The password never comes back, only whether one is set. */
export interface SmtpView {
  configured: boolean;
  source: 'database' | 'env' | 'none';
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passwordSet: boolean;
  from: string;
}
export interface SmtpInput {
  host: string;
  port: number;
  secure: boolean | null;
  user: string;
  /** empty = keep the stored password */
  pass: string;
  from: string;
}
export function getSmtpSettings(signal?: AbortSignal): Promise<SmtpView> {
  return api<SmtpView>('/settings/smtp', { signal });
}
export function saveSmtpSettings(body: SmtpInput): Promise<SmtpView> {
  return api<SmtpView>('/settings/smtp', { method: 'PATCH', body });
}
export function testSmtp(to?: string): Promise<{ outcome: 'sent' | 'not_configured' | 'failed'; error?: string; to: string }> {
  return api('/settings/smtp/test', { method: 'POST', body: to ? { to } : {} });
}

export type MailKind = 'alerts' | 'dailyDigest' | 'weeklyDigest' | 'monthClosed';
export interface RecipientsView {
  kinds: { kind: MailKind; saved: string[]; effective: string[]; envVariable: string }[];
}
export function getMailRecipients(signal?: AbortSignal): Promise<RecipientsView> {
  return api<RecipientsView>('/settings/mail-recipients', { signal });
}
export function saveMailRecipients(body: Partial<Record<MailKind, string[]>>): Promise<RecipientsView> {
  return api<RecipientsView>('/settings/mail-recipients', { method: 'PUT', body });
}
```

Add `| 'smtp' | 'recipients'` to the `EnvSubject` union in the same file.

- [ ] **Step 4: Write the cards**

```tsx
// oxeio-monitor/web/src/pages/settings/EmailCards.tsx
import { useEffect, useState } from 'react';

import {
  getMailRecipients,
  getSmtpSettings,
  saveMailRecipients,
  saveSmtpSettings,
  testSmtp,
  type MailKind,
} from '../../api/settings';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import {
  CheckboxField,
  MiniButton,
  Notice,
  ServerError,
  TextAreaField,
  TextField,
  useMutation,
} from '../../components/ui';
import { useT } from '../../i18n';
import { BackToEnv } from './BackToEnv';
import { formatAddressList, parseAddressList, testResultKey } from './email.math';

/**
 * The SMTP server every email leaves through. Any provider works (a company
 * mail server, a transactional email service); the password is never shown
 * again after saving — an empty field keeps it.
 */
export function SmtpCard() {
  const t = useT();
  const smtp = useApi(getSmtpSettings, []);
  const save = useMutation();
  const probe = useMutation();
  const [form, setForm] = useState({ host: '', port: '587', user: '', pass: '', from: '' });
  const [forceTls, setForceTls] = useState(false);
  const [result, setResult] = useState<{ key: string; error?: string } | null>(null);

  useEffect(() => {
    const v = smtp.data;
    if (!v) return;
    setForm({ host: v.host, port: String(v.port), user: v.user, pass: '', from: v.from });
    setForceTls(v.secure && v.port !== 465);
  }, [smtp.data]);

  if (smtp.loading && !smtp.data) return <Loading />;
  if (smtp.error && !smtp.data) return <ErrorBox error={smtp.error} retry={smtp.reload} />;
  const current = smtp.data;
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Card title={t('Email (SMTP)')} hint={t('The server every email is sent through')}>
      <div className="space-y-3.5 p-4">
        <div className="text-[13px]">
          {current?.source === 'database' && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-ok">{t('Set here')}</span>
              <BackToEnv subject="smtp" onDone={() => smtp.reload()} />
            </span>
          )}
          {current?.source === 'env' && <span className="text-idle">{t('Currently using the server’s .env')}</span>}
          {current?.source === 'none' && <span className="text-ink-3">{t('Not set — no email is being sent')}</span>}
        </div>

        <TextField label={t('Server')} value={form.host} onChange={set('host')} mono placeholder="smtp.example.com" />
        <TextField label={t('Port')} type="number" value={form.port} onChange={set('port')} mono min={1} max={65535}
          hint={t('587 for STARTTLS (most providers), 465 for TLS from the start.')} />
        <CheckboxField label={t('Use TLS from the first byte even though the port is not 465')} checked={forceTls} onChange={setForceTls} />
        <TextField label={t('User')} value={form.user} onChange={set('user')} mono />
        <TextField label={t('Password')} type="password" value={form.pass} onChange={set('pass')} mono
          placeholder={current?.passwordSet ? t('leave empty to keep the current one') : ''} />
        <TextField label={t('Sender')} value={form.from} onChange={set('from')} mono placeholder="Company <no-reply@example.com>"
          hint={t('The address must be one your provider allows you to send from.')} />

        <ServerError error={save.error ?? probe.error} />
        {result && (
          <Notice tone={result.key.startsWith('✓') ? 'info' : 'attention'}>
            {t(result.key)} {result.error && <span className="num">{result.error}</span>}
          </Notice>
        )}

        <div className="flex gap-2">
          <MiniButton
            disabled={save.busy}
            onClick={() =>
              save.run(async () => {
                const port = Number(form.port);
                await saveSmtpSettings({
                  host: form.host.trim(),
                  port,
                  secure: port === 465 ? true : forceTls ? true : null,
                  user: form.user.trim(),
                  pass: form.pass,
                  from: form.from.trim(),
                });
                setForm((f) => ({ ...f, pass: '' }));
                smtp.reload();
              })
            }
          >
            {t('Save')}
          </MiniButton>
          <MiniButton
            disabled={probe.busy}
            onClick={() =>
              probe.run(async () => {
                const r = await testSmtp();
                setResult({ key: testResultKey(r.outcome), error: r.error });
              })
            }
          >
            {t('Send test email')}
          </MiniButton>
        </div>
      </div>
    </Card>
  );
}

const KIND_LABEL: Record<MailKind, string> = {
  alerts: 'Alerts',
  dailyDigest: 'Daily summary',
  weeklyDigest: 'Weekly summary',
  monthClosed: 'Month closed',
};

/** Who receives each kind of email. Empty = the old rule (the .env list, otherwise the owners). */
export function RecipientsCard() {
  const t = useT();
  const view = useApi(getMailRecipients, []);
  const save = useMutation();
  const [text, setText] = useState<Partial<Record<MailKind, string>>>({});

  useEffect(() => {
    if (!view.data) return;
    setText(Object.fromEntries(view.data.kinds.map((k) => [k.kind, formatAddressList(k.saved)])));
  }, [view.data]);

  if (view.loading && !view.data) return <Loading />;
  if (view.error && !view.data) return <ErrorBox error={view.error} retry={view.reload} />;

  return (
    <Card title={t('Who receives each email')} hint={t('Leave a list empty to keep the default: the .env list, otherwise the owners')}>
      <div className="space-y-3.5 p-4">
        {view.data?.kinds.map((k) => (
          <TextAreaField
            key={k.kind}
            label={t(KIND_LABEL[k.kind])}
            value={text[k.kind] ?? ''}
            onChange={(value: string) => setText((prev) => ({ ...prev, [k.kind]: value }))}
            hint={t('Now going to: {{list}}', { list: k.effective.join(', ') || t('nobody') })}
          />
        ))}
        <ServerError error={save.error} />
        <MiniButton
          disabled={save.busy}
          onClick={() =>
            save.run(async () => {
              const body = Object.fromEntries(
                (Object.keys(KIND_LABEL) as MailKind[]).map((kind) => [kind, parseAddressList(text[kind] ?? '')]),
              );
              await saveMailRecipients(body);
              view.reload();
            })
          }
        >
          {t('Save')}
        </MiniButton>
      </div>
    </Card>
  );
}
```

Before writing, open `components/ui.tsx` and match the real prop names of `CheckboxField` (`checked`/`onChange`), `TextAreaField` and `Notice` (`tone`); adjust the JSX above to them if they differ.

In `NotificationsTab.tsx`, import `{ SmtpCard, RecipientsCard }` from `./EmailCards` and render `<SmtpCard />` and `<RecipientsCard />` as the first two children of the outer `<div className="space-y-3">`, before the Telegram card.

- [ ] **Step 5: Translations**

Add every new English key used above (card titles, labels, hints, the three `testResultKey` sentences, `KIND_LABEL` values, `'Now going to: {{list}}'`, `'nobody'`) to `web/src/i18n/locales/pt-BR/settings-system.json` and `.../es/settings-system.json`. Portuguese examples: `"Email (SMTP)": "E-mail (SMTP)"`, `"Send test email": "Enviar e-mail de teste"`, `"Who receives each email": "Quem recebe cada e-mail"`, `"Daily summary": "Resumo diário"`. Add the new server messages (`'Give the SMTP server host'`, `'The SMTP port must be a number from 1 to 65535'`, `'The sender must contain an email address'`, `'At most 20 addresses per kind of email'`, and the patterns `'Not an email address: {{x}}'`, `'Unknown kind of email: {{x}}'`) to both `server.json` files in the format the existing entries use (see `web/src/i18n/server-messages.ts`).

- [ ] **Step 6: Run the web suites**

Run (in `oxeio-monitor/web`): `npm test && npm run typecheck && npm run lint`
Expected: PASS / clean. If `test/api-callers.spec.ts` checks that every API function has a caller, the new ones are used by `EmailCards.tsx`.

- [ ] **Step 7: Check in the browser**

Start the stack the usual way (`npm run start:dev` in `server/`, `npm run dev` in `web/`), sign in as the owner, open Settings → Notifications: save an SMTP server with a password, reload (password field empty, "Set here" shown), press "Send test email" (expect the "could not be reached" notice with the error text against a fake host), save a recipient list and see "Now going to" change.

- [ ] **Step 8: Commit**

```bash
git add -A oxeio-monitor/web
git commit -m "feat(web): SMTP and recipients on Settings → Notifications"
```

---

### Task 7: Docs and full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md` (Settings table), `oxeio-monitor/deploy/README.md` (email section)

- [ ] **Step 1: Update the settings table**

In `docs/ARCHITECTURE.md`, table "Settings: screen first, then the environment", add:
`| Settings → Notifications › Email (SMTP) | `smtp` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |`
`| Settings → Notifications › Who receives each email | `mail.recipients` | `ALERT_EMAIL_TO` (alerts), `DIGEST_EMAIL_TO` (summaries, month closed) |`
and change the sentence "Emails, Telegram, PDF and Excel output are still English." to "Email text written through `mail/mail-text.ts` follows the company language; the older emails, Telegram, PDF and Excel output are still English."

- [ ] **Step 2: Deployment note**

In `oxeio-monitor/deploy/README.md`, in the email/SMTP section (create a short one if none exists): SMTP can be set on Settings → Notifications instead of the `.env`; any SMTP provider works; for Amazon SES use the region's SMTP endpoint (`email-smtp.<region>.amazonaws.com`, port 587), SMTP credentials generated in the SES console (not IAM access keys), a verified sending domain (DKIM, SPF, DMARC) and an account out of the SES sandbox.

- [ ] **Step 3: Run every suite**

Run (in `oxeio-monitor/server`): `npm test && npm run typecheck && npm run lint`
Run (in `oxeio-monitor/web`): `npm test && npm run typecheck && npm run lint`
Run (in `oxeio-monitor/agent`): `dotnet test tests/oXeio.Core.Tests` (Core only on Linux)
Run (in `oxeio-monitor`): `docker compose build api web`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md oxeio-monitor/deploy/README.md
git commit -m "docs: email settings on screen, recipients per kind, SES notes"
```
