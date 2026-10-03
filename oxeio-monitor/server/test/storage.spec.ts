import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalScreenshotStorage } from '../src/storage/local.storage';
import { isSafeRelPath } from '../src/storage/screenshot-storage';
import { storageSettings } from '../src/storage/storage.config';

/**
 * Screenshot storage — the settings, the path rule both drivers share, and
 * the local driver (the behaviour that was inline before, now behind one
 * interface). The S3 driver is exercised against a real endpoint in
 * storage-s3.e2e.spec.ts.
 */

const env = (vars: Record<string, string>) => (name: string) => vars[name];

describe('storageSettings', () => {
  it('nothing set → local, as before', () => {
    expect(storageSettings(env({}))).toEqual({ driver: 'local' });
  });

  it('s3 with everything it needs', () => {
    const s = storageSettings(
      env({
        STORAGE_DRIVER: 'S3',
        S3_BUCKET: 'shots',
        S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
        S3_REGION: 'us-west-004',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
        S3_PREFIX: '/oxeio/',
      }),
    );
    expect(s).toEqual({
      driver: 's3',
      s3: {
        bucket: 'shots',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        accessKeyId: 'id',
        secretAccessKey: 'secret',
        forcePathStyle: false,
        prefix: 'oxeio/',
      },
    });
  });

  it.each(['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])(
    'without %s it stops — never a quiet fallback to the local disk',
    (missing) => {
      const vars: Record<string, string> = {
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY_ID: 'i',
        S3_SECRET_ACCESS_KEY: 's',
      };
      delete vars[missing];
      expect(() => storageSettings(env(vars))).toThrow(missing);
    },
  );

  it('an unknown driver stops too', () => {
    expect(() => storageSettings(env({ STORAGE_DRIVER: 'ftp' }))).toThrow(
      /local.*s3/,
    );
  });
});

describe('isSafeRelPath — the same rule for disk and bucket', () => {
  it.each([
    'screenshots/2026/08/10/emp-003/093147_m0.webp',
    'screenshots/2026/08/10/emp-003/thumb/093147_m0.webp',
  ])('accepts %s', (p) => expect(isSafeRelPath(p)).toBe(true));

  it.each([
    '',
    '/etc/passwd',
    'C:/x.webp',
    '../x.webp',
    'a/../../x',
    'a//b',
    './a',
  ])('refuses "%s"', (p) => expect(isSafeRelPath(p)).toBe(false));
});

describe('LocalScreenshotStorage', () => {
  let root: string;
  let store: LocalScreenshotStorage;
  const rel = 'screenshots/2026/08/10/emp-003/093147_m0.webp';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oxeio-store-'));
    store = new LocalScreenshotStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes where it always did — STORAGE_ROOT + the relative path', async () => {
    await store.put(rel, Buffer.from('webp'), 'image/webp');
    expect(await readFile(join(root, rel), 'utf8')).toBe('webp');
    expect(await store.size(rel)).toBe(4);
  });

  it('nothing there → null, not an error', async () => {
    expect(await store.size(rel)).toBeNull();
    expect(await store.open(rel)).toBeNull();
  });

  it('remove says deleted, then missing', async () => {
    await store.put(rel, Buffer.from('x'), 'image/webp');
    expect(await store.remove(rel)).toBe('deleted');
    expect(await store.remove(rel)).toBe('missing');
  });

  it('prunes the folders a removal left empty, and only those', async () => {
    const other = 'screenshots/2026/08/10/emp-004/100000_m0.webp';
    await store.put(rel, Buffer.from('x'), 'image/webp');
    await store.put(other, Buffer.from('x'), 'image/webp');

    await store.remove(rel);
    await store.afterRemove([rel]);

    await expect(
      stat(join(root, 'screenshots/2026/08/10/emp-003')),
    ).rejects.toThrow();
    await expect(
      stat(join(root, 'screenshots/2026/08/10/emp-004')),
    ).resolves.toBeTruthy();
  });

  it('refuses a path that leaves the root', async () => {
    await expect(
      store.put('../outside.webp', Buffer.from('x'), 'image/webp'),
    ).rejects.toThrow(/outside screenshot storage/);
  });

  it('probe passes on a writable folder', async () => {
    await expect(store.probe()).resolves.toBeUndefined();
    expect(await store.reachable()).toBe(true);
  });
});
