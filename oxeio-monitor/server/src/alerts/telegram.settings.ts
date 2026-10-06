/**
 * **Telegram settings.** Pure rules, no I/O.
 *
 * Why it was needed: the token and chat id lived only in `.env`, so changing
 * them meant SSH to the VPS, editing the file and restarting the container.
 * That is practically impossible for the owner, and the result was that a
 * wrong Telegram setting stayed wrong for months.
 *
 * It now lives in the database and can be changed from the screen. `.env`
 * **stays as a fallback**: nothing breaks on old installations, and when the
 * database is empty the earlier behavior continues.
 */

/** The key used in the database `settings` table */
export const TELEGRAM_SETTING_KEY = 'telegram';

export interface TelegramSettings {
  botToken: string;
  chatId: string;
}

/**
 * **What goes to the screen: never the token.**
 *
 * Sent to the browser, it would show up in DevTools, proxy logs or screen
 * shares. So only the **last four characters**: enough for the owner to check
 * which one is set, but not enough for anyone to run the bot with it.
 */
export interface TelegramSettingsView {
  configured: boolean;
  /** `...4821`; `null` if no token is set */
  tokenHint: string | null;
  /** The chat id is not secret, so all of it is sent; nothing can be done with it alone */
  chatId: string;
  /** Whether it comes from `.env` or the database; the owner needs to know which applies */
  source: 'database' | 'env' | 'none';
}

/**
 * Nothing is shown if shorter than four characters. A very short token is
 * either a mistake or a test value; in both cases showing a part gains
 * nothing, and there is a risk of showing all of it.
 */
export function tokenHint(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length < 4) return null;

  return `…${trimmed.slice(-4)}`;
}

/**
 * Combines the database and `.env` to decide **which one actually applies**.
 *
 * The database wins, but **only if both fields are filled**. If one were
 * filled and the other empty, Telegram would be half-configured and quietly
 * off while a working value still sits in `.env`, so the screen could be used to **break** it.
 */
export function resolveTelegram(
  db: Partial<TelegramSettings> | null,
  env: Partial<TelegramSettings>,
): { settings: TelegramSettings | null; source: 'database' | 'env' | 'none' } {
  const dbToken = db?.botToken?.trim() ?? '';
  const dbChat = db?.chatId?.trim() ?? '';

  if (dbToken.length > 0 && dbChat.length > 0) {
    return { settings: { botToken: dbToken, chatId: dbChat }, source: 'database' };
  }

  const envToken = env.botToken?.trim() ?? '';
  const envChat = env.chatId?.trim() ?? '';

  if (envToken.length > 0 && envChat.length > 0) {
    return { settings: { botToken: envToken, chatId: envChat }, source: 'env' };
  }

  return { settings: null, source: 'none' };
}

/**
 * The view for the screen.
 *
 * Careful: `source` is sent deliberately. When `.env` has a value and the
 * owner enters a new one on screen, without being told which one applies they
 * would think it had not saved, when it had, and the other one just is not winning.
 */
export function telegramView(
  resolved: ReturnType<typeof resolveTelegram>,
): TelegramSettingsView {
  const s = resolved.settings;

  return {
    configured: s !== null,
    tokenHint: s ? tokenHint(s.botToken) : null,
    chatId: s?.chatId ?? '',
    source: resolved.source,
  };
}
