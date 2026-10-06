import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TELEGRAM_SETTING_KEY } from '../src/alerts/telegram.settings';
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

/**
 * **G08 — Telegram config from the screen.**
 *
 * The most important claim of this file is about security: **the bot token
 * never goes in a response**. If it did, it would be visible in DevTools,
 * proxy logs or a screen share, and anyone could send messages with that bot.
 */
let h: Harness;
let owner: Session;

const TOKEN = '123456789:AAHfakeTOKENforTESTS4821';

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

const read = () => owner.http.get('/api/v1/settings/telegram');

const save = (botToken: string, chatId: string) =>
  owner.http
    .patch('/api/v1/settings/telegram')
    .set('X-CSRF-Token', owner.csrf)
    .send({ botToken, chatId });

describe('GET /settings/telegram', () => {
  it('none when nothing is set', async () => {
    const res = await read().expect(200);

    expect(res.body.source).toBe('none');
    expect(res.body.configured).toBe(false);
    expect(res.body.tokenHint).toBeNull();
  });

  /** Not a manager — that chat receives employee names and hours */
  it('a manager cannot see it', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await manager.http.get('/api/v1/settings/telegram').expect(403);
  });
});

describe('PATCH /settings/telegram', () => {
  it('can be set, and the database wins', async () => {
    const res = await save(TOKEN, '-100999').expect(200);

    expect(res.body.source).toBe('database');
    expect(res.body.configured).toBe(true);
    expect(res.body.chatId).toBe('-100999');
  });

  /**
   * **The main test of this file.** The full token will be in no response at
   * all — neither in the reply to saving nor in the reply to reading.
   */
  it('the full token does not go in any response', async () => {
    const saved = await save(TOKEN, '55').expect(200);
    const fetched = await read().expect(200);

    expect(JSON.stringify(saved.body)).not.toContain(TOKEN);
    expect(JSON.stringify(fetched.body)).not.toContain(TOKEN);
    expect(JSON.stringify(fetched.body)).not.toContain('AAHfake');
  });

  /** Only the last four characters — so the owner can check which one is set */
  it('a hint of the last four characters is returned', async () => {
    const res = await save(TOKEN, '55').expect(200);

    expect(res.body.tokenHint).toBe('…4821');
  });

  /**
   * **The token does not go in the audit log either.** Both the owner and
   * the manager see the audit log, and once a secret value lands there it cannot be erased.
   */
  it('the token is not written to the audit log', async () => {
    await save(TOKEN, '55').expect(200);

    const rows = await h.prisma.auditLog.findMany({
      where: { targetId: TELEGRAM_SETTING_KEY },
    });

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].meta)).not.toContain(TOKEN);
    expect(rows[0].meta).toMatchObject({ op: 'telegram', tokenSet: true });
  });

  /** Sending empty is valid — it means "delete", otherwise there would be no way to remove a wrong token */
  it('sending empty deletes it', async () => {
    await save(TOKEN, '55').expect(200);

    const res = await save('', '').expect(200);

    expect(res.body.source).toBe('none');
  });

  /**
   * If one field is filled and the other left empty, the database one does
   * **not win** — otherwise Telegram could be silently broken from the screen.
   */
  it('a half-filled config does not take effect', async () => {
    const res = await save(TOKEN, '').expect(200);

    expect(res.body.configured).toBe(false);
    expect(res.body.source).toBe('none');
  });

  it('a manager cannot set it', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await manager.http
      .patch('/api/v1/settings/telegram')
      .set('X-CSRF-Token', manager.csrf)
      .send({ botToken: TOKEN, chatId: '5' })
      .expect(403);
  });

  it('an overlong token gives 400', async () => {
    await save('x'.repeat(300), '5').expect(400);
  });

  /** Setting twice leaves one row — upsert */
  it('setting again keeps the new one', async () => {
    await save(TOKEN, '11').expect(200);
    const res = await save('987654321:BBsecondTOKEN9999', '22').expect(200);

    expect(res.body.tokenHint).toBe('…9999');
    expect(res.body.chatId).toBe('22');

    const rows = await h.prisma.setting.findMany({
      where: { key: TELEGRAM_SETTING_KEY },
    });
    expect(rows).toHaveLength(1);
  });
});
