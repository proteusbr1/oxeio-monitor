import { describe, expect, it } from 'vitest';

import {
  resolveTelegram,
  telegramView,
  tokenHint,
} from '../src/alerts/telegram.settings';

/**
 * Telegram settings — database vs `.env`, and what goes to the screen.
 *
 * The most important claim of this file is about security: **the bot token
 * never goes to the browser**. If it did, it would be visible in DevTools,
 * proxy logs or a screen share, and anyone could send messages with that bot.
 */
describe('tokenHint', () => {
  it('last four characters', () => {
    expect(tokenHint('123456789:ABCdefGHIjklMNO4821')).toBe('…4821');
  });

  /** Very short means a mistaken or test value — showing part of it is pointless */
  it('nothing if fewer than four characters', () => {
    expect(tokenHint('abc')).toBeNull();
    expect(tokenHint('')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(tokenHint('  ...9999  ')).toBe('…9999');
  });
});

describe('resolveTelegram', () => {
  const env = { botToken: 'env-token-1111', chatId: '111' };
  const db = { botToken: 'db-token-2222', chatId: '222' };

  it('when both are filled, the database wins', () => {
    const r = resolveTelegram(db, env);

    expect(r.source).toBe('database');
    expect(r.settings?.chatId).toBe('222');
  });

  it('when the database is empty, `.env`', () => {
    const r = resolveTelegram(null, env);

    expect(r.source).toBe('env');
    expect(r.settings?.chatId).toBe('111');
  });

  /**
   * **The main test of this file.** One field filled in the database and the
   * other empty — then the working value in `.env` is the one that applies.
   *
   * Otherwise, saving half the fields on screen would silently turn Telegram
   * off, while the working value sits in `.env` — i.e. the screen could be
   * used to **break** it.
   */
  it('when the database is half-filled, `.env` applies', () => {
    expect(resolveTelegram({ botToken: 'x', chatId: '' }, env).source).toBe('env');
    expect(resolveTelegram({ botToken: '', chatId: '9' }, env).source).toBe('env');
  });

  it('none when there is nothing anywhere', () => {
    const r = resolveTelegram(null, {});

    expect(r.source).toBe('none');
    expect(r.settings).toBeNull();
  });

  it('only whitespace means empty', () => {
    expect(resolveTelegram({ botToken: '  ', chatId: '  ' }, {}).source).toBe('none');
  });

  it('whitespace is trimmed', () => {
    const r = resolveTelegram({ botToken: '  t  ', chatId: '  9  ' }, {});

    expect(r.settings).toEqual({ botToken: 't', chatId: '9' });
  });
});

describe('telegramView', () => {
  /**
   * **The most important claim — the token never leaks in any way.**
   */
  it('the full token never goes out', () => {
    const view = telegramView(
      resolveTelegram({ botToken: 'super-secret-4821', chatId: '55' }, {}),
    );

    expect(JSON.stringify(view)).not.toContain('super-secret');
    expect(view.tokenHint).toBe('…4821');
  });

  /** The chat id is not secret — nothing can be done with it, so all of it goes */
  it('the chat id goes out in full', () => {
    const view = telegramView(resolveTelegram({ botToken: 'tok1', chatId: '-100999' }, {}));

    expect(view.chatId).toBe('-100999');
  });

  /**
   * Without telling which one is in effect, the owner would set a new value
   * on screen and think it was not saved — when it was, but the `.env` one is not winning.
   */
  it('the source goes out too', () => {
    expect(telegramView(resolveTelegram(null, { botToken: 'a', chatId: 'b' })).source).toBe(
      'env',
    );
  });

  it('configured is false when there is nothing', () => {
    const view = telegramView(resolveTelegram(null, {}));

    expect(view.configured).toBe(false);
    expect(view.tokenHint).toBeNull();
    expect(view.chatId).toBe('');
  });
});
