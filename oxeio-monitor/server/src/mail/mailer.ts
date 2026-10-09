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
  /** no point logging the same complaint every minute — one latch per complaint */
  private warnedNoSmtp = false;
  private warnedNoRecipients = false;

  /** nodemailer in production; tests put a fake here */
  createTransport: TransportFactory = nodemailerTransport;

  constructor(private readonly settings: AppSettingsService) {}

  async isConfigured(): Promise<boolean> {
    try {
      return (await this.settings.smtp()).config !== null;
    } catch {
      return false;
    }
  }

  async send(
    to: readonly string[],
    subject: string,
    body: string,
    attachments?: readonly MailAttachment[],
    html?: string,
  ): Promise<SendOutcome> {
    return (await this.deliver(to, { subject, text: body, html, attachments }))
      .outcome;
  }

  async deliver(
    to: readonly string[],
    message: MailMessage,
  ): Promise<SendResult> {
    try {
      const { config } = await this.settings.smtp();
      if (!config) {
        if (!this.warnedNoSmtp) {
          this.warnedNoSmtp = true;
          this.logger.warn(
            'No SMTP configured — emails are not being sent. Set it on Settings → Notifications or SMTP_HOST in the .env',
          );
        }
        return { outcome: 'not_configured' };
      }
      if (to.length === 0) {
        if (!this.warnedNoRecipients) {
          this.warnedNoRecipients = true;
          this.logger.warn('An email had no recipients');
        }
        return { outcome: 'not_configured' };
      }

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
    if (this.transporter && this.transporterKey === key)
      return this.transporter;

    this.dispose();
    const transporter = this.createTransport(config);
    // an EventEmitter with no 'error' listener kills the process
    transporter.on('error', (err: Error) =>
      this.logger.error(`SMTP connection error: ${err.message}`),
    );
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
