import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { isSafeRelPath, type ScreenshotStorage } from './screenshot-storage';

export interface S3StorageOptions {
  bucket: string;
  /** Optional key prefix, e.g. `oxeio/` — keeps one bucket shareable */
  prefix: string;
  region: string;
  /** Backblaze B2, MinIO, … — empty for AWS itself */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO needs path-style URLs (`http://host/bucket/key`) */
  forcePathStyle: boolean;
}

/**
 * STORAGE_DRIVER=s3 — screenshots and thumbnails in an S3-compatible bucket.
 *
 * ⚠️ The bucket stays private. The dashboard never gets a bucket URL: it keeps
 *    using the server's own signed links (`/screenshots/:id/file?token=…`),
 *    and the server streams the object. So the 5-minute tokens, the
 *    owner/manager checks and the view log work as they did on disk, and no
 *    CORS or public-read policy is needed on the bucket.
 */
export class S3ScreenshotStorage implements ScreenshotStorage {
  readonly driver = 's3' as const;
  readonly location: string;
  private readonly client: S3Client;

  constructor(private readonly opts: S3StorageOptions) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
    this.location = `s3://${opts.bucket}/${opts.prefix}`;
  }

  async probe(): Promise<void> {
    const key = '.write-probe';
    try {
      await this.put(key, Buffer.from('ok'), 'text/plain');
      if ((await this.size(key)) === null)
        throw new Error('written object not found');
      await this.remove(key);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Screenshot storage is not writable: ${this.location} (${reason}). ` +
          'Screenshots would be silently lost. Check S3_BUCKET, S3_ENDPOINT, ' +
          'S3_REGION and that the key may put, get and delete objects.',
      );
    }
  }

  async reachable(): Promise<boolean> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.opts.bucket }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async put(relPath: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.key(relPath),
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async size(relPath: string): Promise<number | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.opts.bucket,
          Key: this.key(relPath),
        }),
      );
      return head.ContentLength ?? 0;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async open(
    relPath: string,
  ): Promise<{ stream: Readable; sizeBytes: number } | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.opts.bucket,
          Key: this.key(relPath),
        }),
      );
      if (!(res.Body instanceof Readable))
        throw new Error('unexpected body type');
      return { stream: res.Body, sizeBytes: res.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * ⚠️ S3 DELETE succeeds whether or not the key existed, so "missing" needs
   *    a HEAD first — retention reports the two separately.
   */
  async remove(relPath: string): Promise<'deleted' | 'missing'> {
    if ((await this.size(relPath)) === null) return 'missing';
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.key(relPath),
      }),
    );
    return 'deleted';
  }

  /** A bucket has no folders to prune */
  async afterRemove(): Promise<void> {}

  private key(relPath: string): string {
    if (!isSafeRelPath(relPath)) {
      throw new Error(`path is outside screenshot storage: ${relPath}`);
    }
    return `${this.opts.prefix}${relPath.replace(/\\/g, '/')}`;
  }
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}
