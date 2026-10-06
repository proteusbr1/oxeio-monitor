import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';

import {
  TELEGRAM_BATCH,
  TELEGRAM_CHANNEL_TAG,
  TELEGRAM_MUTED_TYPES,
  TELEGRAM_FAILED_TAG,
  TELEGRAM_MAX_AGE_HOURS,
  TELEGRAM_MAX_ATTEMPTS,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_DOCUMENT_MAX_BYTES,
  TELEGRAM_TIMEOUT_MS,
  TELEGRAM_UPLOAD_TIMEOUT_MS,
} from '../ops/ops.constants';
import { telegramMessage, type TelegramAlertFacts } from '../ops/ops.rules';
import { PrismaService } from '../prisma/prisma.service';
import {
  resolveTelegram,
  TELEGRAM_SETTING_KEY,
  type TelegramSettings,
} from './telegram.settings';

/**
 * Deliberately **few** columns. `title` and `detail` are not even fetched
 * here: what is not pulled in cannot be sent by mistake.
 */
const SWEEP_SELECT = {
  id: true,
  type: true,
  severity: true,
  createdAt: true,
  channelsSent: true,
  device: { select: { hostname: true } },
} satisfies Prisma.AlertSelect;

type SweepAlert = Prisma.AlertGetPayload<{ select: typeof SWEEP_SELECT }>;

export type TelegramOutcome = 'sent' | 'not_configured' | 'failed';

/**
 * **G08**: the Telegram channel for alerts.
 *
 * **Not a rival to email, but a second layer.** `AlertDispatcher` does its
 * own job first (`channels_sent` goes from empty to `email`/`log`/`email_failed`),
 * then this sweep goes over those rows and **adds** the `telegram` tag.
 *
 * Careful: the order could not be reversed. The dispatcher picks exactly the
 * rows whose `channels_sent` is **empty**, and when writing it replaces the
 * whole array (`channelsSent: [channel]`). If Telegram tagged first, the row
 * would no longer be empty, so the alert would never go by email, yet
 * everything would look fine because it went to Telegram. Email is the main
 * channel (the owner's inbox, with details); Telegram is only for saying "look now".
 *
 * **What goes into the message is decided by `ops.rules.ts`, not this
 * file.** Telegram is an external service: messages are stored on their
 * servers, and anyone can be in the group. So an alert's free text is never
 * sent, only the type label + hostname + time (an allowlist, `telegramLine`).
 *
 * Careful: without a token or chat id the whole thing **stays quietly off**,
 * like SMTP. No crash and no complaint every minute.
 */
@Injectable()
export class TelegramChannel {
  private readonly logger = new Logger(TelegramChannel.name);
  /**
   * Careful: the `.env` value is a **fallback**, not final. The real value
   * comes from the database (the `settings` table), because the owner can
   * change it from the screen.
   *
   * So the value **cannot be cached in the constructor**: after a change the
   * old one would keep being used until a server restart, and the owner would
   * think it had not saved. It is read before every send.
   */
  private readonly envToken: string;
  private readonly envChatId: string;
  /** In-memory, like the dispatcher: a restart means the config was fixed */
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.envToken = config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() ?? '';
    this.envChatId = config.get<string>('TELEGRAM_CHAT_ID')?.trim() ?? '';

    // Careful: we cannot say "off" here. The database may hold a value, and
    // the constructor cannot await. Wrongly writing "off" would confuse the
    // owner reading the log even though the config is set on screen.
    if (this.envToken.length === 0 || this.envChatId.length === 0) {
      this.logger.log(
        'No TELEGRAM_* in .env — the Telegram channel will use whatever is set on the Settings page (G08)',
      );
    }
  }

  /**
   * Now **async**, because it has to look at the database. The old synchronous
   * getter was deliberately not kept: if it existed someone would call it by
   * mistake and silently get the stale `.env` answer.
   */
  async resolve(): Promise<TelegramSettings | null> {
    let stored: Partial<TelegramSettings> | null = null;

    try {
      const row = await this.prisma.setting.findUnique({
        where: { key: TELEGRAM_SETTING_KEY },
      });
      stored = (row?.value as Partial<TelegramSettings> | undefined) ?? null;
    } catch (err) {
      // Careful: if the database cannot be read, fall back to `.env`; running
      // on old config is better than Telegram going off.
      this.logger.warn(
        `Could not read the Telegram setting, using .env: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return resolveTelegram(stored, {
      botToken: this.envToken,
      chatId: this.envChatId,
    }).settings;
  }

  /**
   * One sweep; returns how many alerts were settled.
   * Careful: it never throws.
   */
  async runOnce(now = new Date()): Promise<number> {
    const settings = await this.resolve();
    if (settings === null) return 0;

    const pending = await this.prisma.alert.findMany({
      where: {
        // Only rows whose email turn is over; the reason is in the class doc
        channelsSent: { isEmpty: false },
        /**
         * **Muted types are filtered out right here.** `agent_down` used to
         * fire about 39 times a day, burying every other message (see the
         * note on `TELEGRAM_MUTED_TYPES`).
         *
         * Careful: they are filtered in the WHERE, not fetched and then
         * dropped. Otherwise each sweep's batch of 10 would fill with those
         * rows and real alerts would never reach the front.
         * Careful: tagging is not needed either: once past the 24-hour window
         * the rows are no longer considered anyway.
         */
        type: { notIn: [...TELEGRAM_MUTED_TYPES] },
        NOT: {
          channelsSent: { hasSome: [TELEGRAM_CHANNEL_TAG, TELEGRAM_FAILED_TAG] },
        },
        createdAt: {
          gte: new Date(now.getTime() - TELEGRAM_MAX_AGE_HOURS * 3_600_000),
        },
      },
      select: SWEEP_SELECT,
      orderBy: { createdAt: 'asc' },
      take: TELEGRAM_BATCH,
    });

    if (pending.length === 0) return 0;

    const facts: TelegramAlertFacts[] = pending.map((a) => ({
      type: a.type,
      severity: a.severity,
      hostname: a.device?.hostname ?? null,
      createdAt: a.createdAt,
    }));

    const outcome = await this.send(telegramMessage(facts, now));

    if (outcome === 'sent') {
      await this.tag(pending, TELEGRAM_CHANNEL_TAG);
      for (const a of pending) this.attempts.delete(a.id.toString());
      return pending.length;
    }

    if (outcome === 'not_configured') return 0;

    return this.countFailures(pending);
  }

  /**
   * Careful: it never throws, and **never logs the URL**. The bot token is
   * inside the URL, and anyone holding that token can post anything to that
   * group. Telegram's error messages sometimes echo the URL back, so the
   * token is scrubbed from the message too.
   */
  async send(text: string): Promise<TelegramOutcome> {
    return this.post(text, null);
  }

  /**
   * **Monospace message**, for the daily report only.
   *
   * Careful: **why a separate method rather than a flag inside `send()`:**
   * the plain-text nature of `send()` above is a **safeguard**, not a whim.
   * Alert messages contain hostnames, and the underscores in `DESKTOP_A_B`
   * could make Markdown/HTML mode turn the whole message into a 400. With a
   * separate method nobody can send an alert in HTML mode by mistake.
   *
   * Careful: **on failure it retries as plain text.** A formatting problem
   * must never cost "that day's report did not go out". For the second
   * attempt the caller strips the `<pre>` wrapper (`plainFallback`), otherwise
   * the reader would see raw tags.
   */
  async sendHtml(html: string, plainFallback: string): Promise<TelegramOutcome> {
    const outcome = await this.post(html, 'HTML');
    if (outcome !== 'failed') return outcome;

    this.logger.warn('Telegram rejected the formatted message — retrying as plain text');
    return this.post(plainFallback, null);
  }

  /**
   * Careful: it never throws, and **never logs the URL**. The bot token is
   * inside the URL, and anyone holding that token can post anything to that
   * group. Telegram's error messages sometimes echo the URL back, so the
   * token is scrubbed from the message too.
   */
  private async post(
    text: string,
    parseMode: 'HTML' | null,
  ): Promise<TelegramOutcome> {
    const settings = await this.resolve();
    if (settings === null) return 'not_configured';

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${settings.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: settings.chatId,
            text,
            // Careful: no parse_mode by default, so plain text. With Markdown a
            // single `_` in a hostname would turn the whole message into a 400.
            ...(parseMode === null ? {} : { parse_mode: parseMode }),
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.error(
          `Could not send to Telegram (HTTP ${res.status}): ${TelegramChannel.scrub(body, settings.botToken).slice(0, 200)}`,
        );
        return 'failed';
      }

      return 'sent';
    } catch (err) {
      this.logger.error(
        `Could not send to Telegram: ${TelegramChannel.scrub(err instanceof Error ? err.message : 'unknown error', settings.botToken)}`,
      );
      return 'failed';
    }
  }

  /**
   * **R26: sending a file** (Excel/PDF). The twin of `send()` with the same
   * contract: it re-reads the settings every time, never throws and never logs the token.
   *
   * Careful: <b>no `headers` are passed, and that is deliberate.</b> `fetch`
   * sees the `FormData` and sets `multipart/form-data; boundary=...` itself.
   * Writing `content-type` by hand, as `send()` above does, would lose the
   * boundary, and Telegram would return 400 every time, looking like a token problem.
   *
   * Careful: a `Blob`, not a stream: in Node a stream body does not work with
   * the multipart wrapper. A `Buffer` is itself a `Uint8Array`, so it works
   * directly as a `BlobPart`.
   *
   * Careful: no retry, deliberately. On 429 Telegram gives `retry_after`, but
   * sleeping here would hold a request for 60 seconds. The failure is returned
   * to the caller, whose decision it is.
   */
  async sendDocument(
    doc: { bytes: Buffer; filename: string; contentType?: string },
    caption?: string,
  ): Promise<TelegramOutcome> {
    const settings = await this.resolve();
    if (settings === null) return 'not_configured';

    // Careful: measure first, then send; otherwise we would only learn the size
    // after paying for the whole upload
    if (doc.bytes.byteLength > TELEGRAM_DOCUMENT_MAX_BYTES) {
      this.logger.error(
        `Could not send to Telegram — file too large (${doc.filename}, ` +
          `${Math.round(doc.bytes.byteLength / 1024 / 1024)} MB, limit ` +
          `${TELEGRAM_DOCUMENT_MAX_BYTES / 1024 / 1024} MB)`,
      );
      return 'failed';
    }

    // Careful: the name is sanitized; a quote or newline would break the multipart header itself
    const filename =
      doc.filename.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120) || 'report';
    const text = (caption ?? '').trim().slice(0, TELEGRAM_CAPTION_MAX);

    try {
      const form = new FormData();
      form.append('chat_id', settings.chatId);
      // Careful: an empty caption is **not sent at all**; an empty string gives a 400
      if (text) form.append('caption', text);
      form.append(
        'document',
        new Blob([doc.bytes], {
          type: doc.contentType ?? 'application/octet-stream',
        }),
        filename,
      );

      const res = await fetch(
        `https://api.telegram.org/bot${settings.botToken}/sendDocument`,
        {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(TELEGRAM_UPLOAD_TIMEOUT_MS),
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.error(
          `Could not send a document to Telegram (HTTP ${res.status}): ` +
            `${TelegramChannel.scrub(body, settings.botToken).slice(0, 200)}`,
        );
        return 'failed';
      }

      return 'sent';
    } catch (err) {
      this.logger.error(
        `Could not send a document to Telegram: ${TelegramChannel.scrub(
          err instanceof Error ? err.message : 'unknown error',
          settings.botToken,
        )}`,
      );
      return 'failed';
    }
  }

  /** Careful: the whole array is not replaced; the tag is **added** to the existing one */
  private async tag(pending: SweepAlert[], tag: string): Promise<void> {
    for (const a of pending) {
      try {
        await this.prisma.alert.update({
          where: { id: a.id },
          data: { channelsSent: { set: [...a.channelsSent, tag] } },
        });
      } catch (err) {
        this.logger.warn(
          `Could not write channels_sent (alert ${a.id}): ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    }
  }

  private async countFailures(pending: SweepAlert[]): Promise<number> {
    const exhausted: SweepAlert[] = [];

    for (const a of pending) {
      const key = a.id.toString();
      const count = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, count);
      if (count >= TELEGRAM_MAX_ATTEMPTS) exhausted.push(a);
    }

    if (exhausted.length === 0) return 0;

    for (const a of exhausted) this.attempts.delete(a.id.toString());
    await this.tag(exhausted, TELEGRAM_FAILED_TAG);
    this.logger.error(
      `${exhausted.length} alerts could not be sent to Telegram — giving up ` +
        '(they should still have gone by email, that is separate)',
    );
    return exhausted.length;
  }

  /**
   * Keeps the token out of every log line.
   *
   * Careful: the token is now a **parameter**, not a field, because the value
   * is no longer cached (it can change from the screen). The caller must pass
   * it from exactly where it knows the token.
   */
  private static scrub(text: string, token: string): string {
    return token ? text.split(token).join('***') : text;
  }
}
