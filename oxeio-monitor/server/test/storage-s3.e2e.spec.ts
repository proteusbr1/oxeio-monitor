import { randomUUID } from 'node:crypto';

import {
  CreateBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Harness } from './setup/harness';

/**
 * STORAGE_DRIVER=s3, the whole path: the agent uploads → the object is in the
 * bucket → the dashboard's signed link streams it → retention deletes it from
 * the bucket.
 *
 * ⚠️ Needs an S3-compatible endpoint, so it only runs when S3_TEST_ENDPOINT is
 *    set — e.g. a local MinIO:
 *      docker run -d -p 9000:9000 -e MINIO_ROOT_USER=minio \
 *        -e MINIO_ROOT_PASSWORD=minio-secret-123 minio/minio server /data
 *      S3_TEST_ENDPOINT=http://localhost:9000 npm test -- storage-s3
 *    Without it the suite is skipped, not failed: CI has no bucket.
 */
const ENDPOINT = process.env.S3_TEST_ENDPOINT;
const KEY_ID = process.env.S3_TEST_ACCESS_KEY_ID ?? 'minio';
const SECRET = process.env.S3_TEST_SECRET_ACCESS_KEY ?? 'minio-secret-123';
const BUCKET = process.env.S3_TEST_BUCKET ?? 'oxeio-test';
const PREFIX = `e2e-${randomUUID().slice(0, 8)}`;

const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
// the thumbnail must be smaller than the image (checkThumb), so pad the image
const WEBP = Buffer.concat([WEBP_HEADER, Buffer.alloc(64)]);
const THUMB = WEBP_HEADER;

describe.skipIf(!ENDPOINT)('screenshots in an S3 bucket', () => {
  let h: Harness;
  let harness: typeof import('./setup/harness');
  let s3: S3Client;
  let device: { token: string; employeeId: number };

  beforeAll(async () => {
    s3 = new S3Client({
      region: 'us-east-1',
      endpoint: ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
    });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => {
      // already there
    });

    // the driver is chosen when the app boots — set it before importing it
    vi.stubEnv('STORAGE_DRIVER', 's3');
    vi.stubEnv('S3_BUCKET', BUCKET);
    vi.stubEnv('S3_ENDPOINT', ENDPOINT!);
    vi.stubEnv('S3_ACCESS_KEY_ID', KEY_ID);
    vi.stubEnv('S3_SECRET_ACCESS_KEY', SECRET);
    vi.stubEnv('S3_FORCE_PATH_STYLE', 'true');
    vi.stubEnv('S3_PREFIX', PREFIX);
    vi.resetModules();

    harness = await import('./setup/harness');
    h = await harness.createHarness();
    await harness.resetDatabase(h.prisma, h.app);

    const { code } = await harness.createEmployeeWithCode(h.prisma);
    device = await harness.enrollDevice(h, code);
  });

  afterAll(async () => {
    await h?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const exists = async (relPath: string): Promise<boolean> =>
    s3
      .send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/${relPath}` }),
      )
      .then(() => true)
      .catch(() => false);

  it('upload → bucket → signed link → retention deletes from the bucket', async () => {
    const now = harness.workNoon();
    const res = await h
      .http()
      .post('/api/v1/agent/screenshots')
      .set('Authorization', `Bearer ${device.token}`)
      .set('X-Client-Time', harness.iso(harness.realNow()))
      .field(
        'meta',
        JSON.stringify({
          clientUuid: randomUUID(),
          slotStart: harness.iso(new Date(now.getTime() - 60_000)),
          capturedAt: harness.iso(now),
          monitorIndex: 0,
        }),
      )
      .attach('file', WEBP, {
        filename: 'shot.webp',
        contentType: 'image/webp',
      })
      .attach('thumb', THUMB, {
        filename: 'thumb.webp',
        contentType: 'image/webp',
      })
      .expect(201);

    const relPath: string = res.body.path;
    expect(await exists(relPath)).toBe(true);

    // the dashboard keeps using the server's signed link; the bytes come from the bucket
    const owner = await harness.loginReady(
      h,
      harness.OWNER_EMAIL,
      harness.OWNER_PASSWORD,
    );
    const date = harness.workTodayIso();
    const page = await owner.http
      .get(`/api/v1/screenshots?employeeId=${device.employeeId}&date=${date}`)
      .expect(200);
    const item = page.body.items[0];
    const file = await owner.http.get(item.fullUrl).buffer(true).expect(200);
    expect(Buffer.compare(file.body as Buffer, WEBP)).toBe(0);
    expect(file.headers['content-type']).toBe('image/webp');

    // 91 days later the retention job removes it — from the bucket, not a disk
    const { RetentionJob } = await import('../src/summary/retention.job');
    const result = await h.app
      .get(RetentionJob)
      .runOnce(new Date(now.getTime() + 91 * 86_400_000));

    expect(result.filesDeleted).toBe(2); // the image and its thumbnail
    expect(result.rowsDeleted).toBe(1);
    expect(await exists(relPath)).toBe(false);
  });
});
