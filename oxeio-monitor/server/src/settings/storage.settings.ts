import { keyHint } from '../ops/offsite.settings';
import type { S3StorageOptions } from '../storage/s3.storage';
import { storageSettings, type StorageSettings } from '../storage/storage.config';
import type { Source } from './app-settings.rules';

/**
 * Where screenshots are kept, as chosen on Settings → Storage & backup —
 * pure rules, no I/O.
 *
 * Saved on screen it wins; otherwise STORAGE_DRIVER / S3_* from the
 * environment, as before. The secret never goes back to the browser: the
 * screen only sees whether one is set and a short hint of the key id.
 */
export const STORAGE_SETTING_KEY = 'storage';

export type Provider = 'b2' | 's3';

export interface StorageSaved {
  driver?: 'local' | 's3';
  provider?: Provider;
  bucket?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
  forcePathStyle?: boolean;
  /** take the key from the backup copy (Settings → Backup › Offsite copy) */
  useBackupKey?: boolean;
}

export interface StorageView {
  driver: 'local' | 's3';
  provider: Provider;
  bucket: string;
  endpoint: string;
  region: string;
  prefix: string;
  forcePathStyle: boolean;
  useBackupKey: boolean;
  keyIdHint: string | null;
  secretSet: boolean;
  source: Source;
  /** what this server is using now — differs from the above until a restart */
  running: { driver: 'local' | 's3'; location: string };
  restartNeeded: boolean;
}

export interface BackupKey {
  keyId: string;
  appKey: string;
}

/**
 * The settings the server starts with. `backupKey` is the offsite copy's
 * Backblaze key, used when the owner ticked "use the same key".
 */
export function resolveStorage(
  saved: StorageSaved | null,
  env: (name: string) => string | undefined,
  backupKey: BackupKey | null,
): { settings: StorageSettings; source: Source } {
  if (saved?.driver === 'local') return { settings: { driver: 'local' }, source: 'dashboard' };

  if (saved?.driver === 's3') {
    const keyId = saved.useBackupKey ? backupKey?.keyId : saved.accessKeyId;
    const secret = saved.useBackupKey ? backupKey?.appKey : saved.secretAccessKey;
    if (!saved.bucket || !keyId || !secret) {
      throw new Error(
        'Screenshot storage on Settings is set to a bucket but its key is missing — ' +
          'set it again on Settings → Storage & backup',
      );
    }
    return {
      settings: {
        driver: 's3',
        s3: {
          bucket: saved.bucket,
          region: saved.region || 'us-east-1',
          endpoint: saved.endpoint || undefined,
          accessKeyId: keyId,
          secretAccessKey: secret,
          forcePathStyle: saved.forcePathStyle === true,
          prefix: normalisePrefix(saved.prefix),
        },
      },
      source: 'dashboard',
    };
  }

  const fromEnv = storageSettings(env);
  const anyEnv = (env('STORAGE_DRIVER') ?? '').trim() !== '';
  return { settings: fromEnv, source: anyEnv ? 'environment' : 'default' };
}

/** `oxeio`, `/oxeio/` and `oxeio/` all mean the folder `oxeio/` */
export function normalisePrefix(prefix: string | undefined): string {
  const p = (prefix ?? '').trim().replace(/^\/+|\/+$/g, '');
  return p === '' ? '' : `${p}/`;
}

/**
 * Backblaze's S3 address carries the region: `https://s3.us-west-004.backblazeb2.com`
 * → `us-west-004`. `null` when the URL is not one of those.
 */
export function b2RegionOf(s3ApiUrl: string): string | null {
  const m = /^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com\/?$/.exec(s3ApiUrl.trim());
  return m ? m[1] : null;
}

export function storageView(
  saved: StorageSaved | null,
  resolved: { settings: StorageSettings; source: Source },
  running: { driver: 'local' | 's3'; location: string },
): StorageView {
  const s3: S3StorageOptions | null = resolved.settings.driver === 's3' ? resolved.settings.s3 : null;
  const location = s3 ? `s3://${s3.bucket}/${s3.prefix}` : running.driver === 'local' ? running.location : '';
  return {
    driver: resolved.settings.driver,
    provider: saved?.provider ?? (s3?.endpoint?.includes('backblazeb2.com') ? 'b2' : 's3'),
    bucket: s3?.bucket ?? '',
    endpoint: s3?.endpoint ?? '',
    region: s3?.region ?? '',
    prefix: s3?.prefix ?? '',
    forcePathStyle: s3?.forcePathStyle ?? false,
    useBackupKey: saved?.useBackupKey === true,
    keyIdHint: s3 ? keyHint(s3.accessKeyId) : null,
    secretSet: s3 !== null && s3.secretAccessKey !== '',
    source: resolved.source,
    running,
    restartNeeded:
      resolved.settings.driver !== running.driver ||
      (resolved.settings.driver === 's3' && location !== running.location),
  };
}
