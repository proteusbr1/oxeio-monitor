import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';

import { SMTP_TIMEOUT_MS } from './alerts.constants';

/**
 * Careful: we do not carry nodemailer's whole `Transporter` type, only an
 * interface for what is actually used. That way a library version change shows
 * at a glance what could break in this file.
 */
/**
 * An email attachment. `content` is a plain `Buffer` because
 * `reports.excel.ts` and `reports.pdf.ts` both return a `Buffer`, so no temp
 * file or base64 is needed.
 * The shape is a subset of `ReportFile`, so one can be passed in directly.
 */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface MailSender {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    // Careful: not readonly. nodemailer's own type wants a mutable array, and
    // with readonly the whole Transporter would no longer match this interface
    attachments?: MailAttachment[];
  }): Promise<unknown>;
  close(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export type SendOutcome = 'sent' | 'not_configured' | 'failed';

/**
 * Email channel for alerts.
 *
 * The one inviolable rule of this class: **it must never be able to bring the
 * server down.** Sending email is a supporting job of monitoring, not the main
 * one. A wrong SMTP password, a hung mail server or a bad hostname in DNS must
 * not stop hour counting or agent data intake. So everything from the
 * constructor to each send is wrapped in try/catch, and `verify()` is never called.
 */
@Injectable()
export class AlertMailer implements OnModuleDestroy {
  private readonly logger = new Logger(AlertMailer.name);
  private readonly config: SmtpConfig | null;
  private transporter: MailSender | null = null;
  /** No point logging the same complaint every minute */
  private warnedMissing = false;

  constructor(config: ConfigService) {
    this.config = readSmtpConfig(config);

    if (!this.config) {
      this.logger.log(
        'No SMTP config — alerts will only be written to the log (set SMTP_HOST to enable email)',
      );
    }
  }

  get configured(): boolean {
    return this.config !== null;
  }

  /**
   * Returns what happened; the caller uses it to set `channels_sent`.
   * Careful: it never throws. A failure is a **value**, not an exception.
   */
  async send(
    to: readonly string[],
    subject: string,
    body: string,
    /**
     * Optional, deliberately: the three older callers and two test mocks stay
     * unchanged. Making it required would break all of them at once, and none
     * of them needs an attachment.
     */
    attachments?: readonly MailAttachment[],
  ): Promise<SendOutcome> {
    if (!this.config || to.length === 0) {
      if (!this.warnedMissing) {
        this.warnedMissing = true;
        this.logger.warn(
          this.config
            ? 'No email address to send alerts to (check the owner email or ALERT_EMAIL_TO)'
            : 'No SMTP config — alerts are not being emailed',
        );
      }
      return 'not_configured';
    }

    try {
      const transporter = this.ensureTransport();
      await transporter.sendMail({
        from: this.config.from,
        to: to.join(', '),
        subject,
        text: body,
        // Careful: when empty the key is **not set at all**. Sending
        // `attachments: []` is harmless, but some SMTP servers still build a multipart wrapper
        ...(attachments && attachments.length > 0
          ? { attachments: [...attachments] }
          : {}),
      });
      return 'sent';
    } catch (err) {
      // Careful: log only the message, not the stack. An SMTP error object can
      // carry the sent data (even the auth string), which must not reach the log.
      this.logger.error(
        `Could not send alert email: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      // New connection on the next attempt; we do not hold on to a hung socket
      this.dispose();
      return 'failed';
    }
  }

  onModuleDestroy(): void {
    this.dispose();
  }

  private ensureTransport(): MailSender {
    if (this.transporter) return this.transporter;

    const { host, port, secure, user, pass } = this.config as SmtpConfig;

    const transporter: MailSender = createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
      // Careful: all three timeouts are set explicitly. nodemailer's defaults are
      // so long that a dead mail server would hang every sweep for minutes.
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });

    // Careful: if nobody listens for 'error' on an EventEmitter, Node kills the process.
    // This one line is the last nail in the "a bad SMTP server won't take us down" promise.
    transporter.on('error', (err: Error) => {
      this.logger.error(`SMTP connection error: ${err.message}`);
    });

    this.transporter = transporter;
    return transporter;
  }

  private dispose(): void {
    try {
      this.transporter?.close();
    } catch {
      // Nothing to do if closing fails
    }
    this.transporter = null;
  }
}

/**
 * Careful: without `SMTP_HOST` the whole thing is off. Saying plainly "not
 * configured" is better than starting with half a config.
 */
function readSmtpConfig(config: ConfigService): SmtpConfig | null {
  const host = config.get<string>('SMTP_HOST')?.trim();
  if (!host) return null;

  const port = Number(config.get<string>('SMTP_PORT') ?? 587);
  const user = config.get<string>('SMTP_USER')?.trim() || undefined;
  const pass = config.get<string>('SMTP_PASS') || undefined;

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    // 465 = implicit TLS; other ports use STARTTLS, so secure = false
    secure: (config.get<string>('SMTP_SECURE') ?? '').toLowerCase() === 'true'
      ? true
      : port === 465,
    user,
    pass,
    from: config.get<string>('SMTP_FROM')?.trim() || `oXeio <no-reply@${host}>`,
  };
}
