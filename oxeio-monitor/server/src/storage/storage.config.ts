import type { S3StorageOptions } from './s3.storage';

/**
 * `STORAGE_DRIVER` and its `S3_*` settings, checked — pure, no I/O.
 *
 * ⚠️ A missing setting stops the server instead of falling back to the local
 *    disk. Someone who chose a bucket so the disk would not fill up would
 *    otherwise find out when it did.
 */
export type StorageSettings =
  { driver: 'local' } | { driver: 's3'; s3: S3StorageOptions };

export function storageSettings(
  env: (name: string) => string | undefined,
): StorageSettings {
  const driver = (env('STORAGE_DRIVER') ?? '').trim().toLowerCase() || 'local';

  if (driver === 'local') return { driver: 'local' };
  if (driver !== 's3') {
    throw new Error(
      `STORAGE_DRIVER="${driver}" — use "local" (default) or "s3"`,
    );
  }

  const required = (name: string): string => {
    const value = env(name)?.trim();
    if (!value) throw new Error(`STORAGE_DRIVER=s3 needs ${name}`);
    return value;
  };

  // `oxeio` and `oxeio/` both mean the folder `oxeio/`
  const rawPrefix = (env('S3_PREFIX') ?? '').trim().replace(/^\/+|\/+$/g, '');

  return {
    driver: 's3',
    s3: {
      bucket: required('S3_BUCKET'),
      region: env('S3_REGION')?.trim() || 'us-east-1',
      endpoint: env('S3_ENDPOINT')?.trim() || undefined,
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: env('S3_FORCE_PATH_STYLE')?.trim() === 'true',
      prefix: rawPrefix === '' ? '' : `${rawPrefix}/`,
    },
  };
}
