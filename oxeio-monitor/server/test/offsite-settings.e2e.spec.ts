import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  b2Verdict,
  keyHint,
  offsiteView,
  resolveOffsite,
  OFFSITE_SETTING_KEY,
} from '../src/ops/offsite.settings';
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
 * **R5 — the offsite backup config, from the screen.**
 *
 * The one most important job of this file: the application key must never
 * go back to the browser in any way. Everything else can be repaired; a
 * leaked key cannot.
 */

const KEY_ID = '005c1fee02c86c20000000002';
const APP_KEY = 'K005abcdefghijklmnopqrstuvwxyz1';

let h: Harness;
let owner: Session;

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

const save = (body: Record<string, string>) =>
  owner.http
    .patch('/api/v1/settings/offsite')
    .set('X-CSRF-Token', owner.csrf)
    .send(body);

// ════════════════════════════════════════════════════════════════════════════
// Pure rules
// ════════════════════════════════════════════════════════════════════════════

describe('keyHint — how much is safe to show', () => {
  it('the last four characters', () => {
    expect(keyHint(APP_KEY)).toBe(`…${APP_KEY.slice(-4)}`);
  });

  /** A very short value — showing part gains nothing and risks showing all of it */
  it('nothing when fewer than four characters', () => {
    expect(keyHint('abc')).toBeNull();
    expect(keyHint('   ')).toBeNull();
  });
});

describe('resolveOffsite — which one applies', () => {
  const full = { keyId: 'a', appKey: 'b', bucket: 'c' };

  it('when all three fields are filled, the database wins', () => {
    const r = resolveOffsite(full, { keyId: 'x', appKey: 'y', bucket: 'z' });
    expect(r.source).toBe('database');
    expect(r.settings?.keyId).toBe('a');
  });

  /**
   * The most important rule: a half-filled database must not be able to break
   * a working config. Otherwise filling one field on screen and pressing save
   * would silently switch offsite off.
   */
  it('when one database field is empty, the server\'s config applies', () => {
    const r = resolveOffsite(
      { keyId: 'a', appKey: '', bucket: 'c' },
      { keyId: 'x', appKey: 'y', bucket: 'z' },
    );
    expect(r.source).toBe('env');
    expect(r.settings?.keyId).toBe('x');
  });

  it('none when there is no full set anywhere', () => {
    expect(resolveOffsite(null, {}).source).toBe('none');
    expect(resolveOffsite({ keyId: 'a' }, { bucket: 'z' }).source).toBe('none');
  });
});

describe('b2Verdict — reading B2\'s answer', () => {
  it('401 means the key is wrong, and the action to take is stated too', () => {
    const v = b2Verdict({ status: 401 }, 'oxeio-backups');
    expect(v.ok).toBe(false);
    expect(v.message).toContain('shown only once');
  });

  it('200 + the same bucket = fine', () => {
    const v = b2Verdict(
      { status: 200, allowed: { bucketName: 'oxeio-backups' } },
      'oxeio-backups',
    );
    expect(v.ok).toBe(true);
    expect(v.boundTo).toBe('oxeio-backups');
  });

  /**
   * The key is right, but bound to another bucket — a classic source of
   * silent failure: everything looked green and the backup went somewhere
   * else (or nowhere).
   */
  it('a key bound to another bucket is caught', () => {
    const v = b2Verdict(
      { status: 200, allowed: { bucketName: 'someone-else' } },
      'oxeio-backups',
    );
    expect(v.ok).toBe(false);
    expect(v.message).toContain('someone-else');
  });

  it('works even when not restricted', () => {
    expect(b2Verdict({ status: 200, allowed: {} }, 'oxeio-backups').ok).toBe(true);
  });

  it('on any other error B2\'s own message is shown', () => {
    const v = b2Verdict({ status: 503, message: 'service unavailable' }, 'b');
    expect(v.ok).toBe(false);
    expect(v.message).toContain('service unavailable');
  });
});

describe('offsiteView — what goes to the screen', () => {
  /** The most important test in the whole file */
  it('the full application key is never in the view', () => {
    const view = offsiteView(
      resolveOffsite({ keyId: KEY_ID, appKey: APP_KEY, bucket: 'b' }, {}),
    );
    expect(JSON.stringify(view)).not.toContain(APP_KEY);
    expect(view.keyHint).toBe(`…${APP_KEY.slice(-4)}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HTTP
// ════════════════════════════════════════════════════════════════════════════

describe('GET/PATCH /settings/offsite', () => {
  it('none when nothing is set', async () => {
    const res = await owner.http.get('/api/v1/settings/offsite').expect(200);
    expect(res.body.source).toBe('none');
    expect(res.body.configured).toBe(false);
  });

  it('can be set, and only a hint comes back', async () => {
    const res = await save({
      keyId: KEY_ID,
      appKey: APP_KEY,
      bucket: 'oxeio-backups',
    }).expect(200);

    expect(res.body.configured).toBe(true);
    expect(res.body.source).toBe('database');
    expect(res.body.bucket).toBe('oxeio-backups');
    expect(res.body.keyId).toBe(KEY_ID);
    // Never the key itself
    expect(JSON.stringify(res.body)).not.toContain(APP_KEY);
  });

  /**
   * A B2 application key is shown only once — so if correcting the bucket
   * name wiped it, the owner would have to create a new key. An empty field
   * means "keep the existing one".
   */
  it('changing the bucket does not wipe the key', async () => {
    await save({ keyId: KEY_ID, appKey: APP_KEY, bucket: 'first' }).expect(200);

    const res = await save({ keyId: '', appKey: '', bucket: 'second' }).expect(200);

    expect(res.body.configured).toBe(true);
    expect(res.body.bucket).toBe('second');
    expect(res.body.keyId).toBe(KEY_ID);
    expect(res.body.keyHint).toBe(`…${APP_KEY.slice(-4)}`);
  });

  /** To delete completely, all three fields must be empty */
  it('leaving all three empty deletes it', async () => {
    await save({ keyId: KEY_ID, appKey: APP_KEY, bucket: 'b' }).expect(200);

    const res = await save({ keyId: '', appKey: '', bucket: '' }).expect(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.source).toBe('none');
  });

  /** The manager can see the audit log too — a secret value there could never be removed */
  it('the key does not go to audit, only "whether it was set"', async () => {
    await save({ keyId: KEY_ID, appKey: APP_KEY, bucket: 'b' }).expect(200);

    const row = await h.prisma.auditLog.findFirstOrThrow({
      where: { targetId: OFFSITE_SETTING_KEY },
    });
    expect(JSON.stringify(row.meta)).not.toContain(APP_KEY);
    expect((row.meta as Record<string, unknown>).keySet).toBe(true);
  });

  it('a manager cannot', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/settings/offsite').expect(403);
    await manager.http
      .patch('/api/v1/settings/offsite')
      .set('X-CSRF-Token', manager.csrf)
      .send({ keyId: 'x', appKey: 'y', bucket: 'z' })
      .expect(403);
  });

  /** With nothing set there is no point running the test — but no 500 either */
  it('running the test without config gives a polite answer', async () => {
    const res = await owner.http
      .post('/api/v1/settings/offsite/test')
      .set('X-CSRF-Token', owner.csrf)
      .expect(201);

    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain('Nothing to test');
  });
});
