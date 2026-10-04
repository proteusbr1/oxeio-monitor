import { B2_AUTH_TIMEOUT_MS } from '../ops/ops.constants';
import { b2Verdict } from '../ops/offsite.settings';
import { S3ScreenshotStorage, type S3StorageOptions } from '../storage/s3.storage';
import { b2RegionOf, normalisePrefix, type Provider } from './storage.settings';

export interface StorageForm {
  provider: Provider;
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  forcePathStyle?: boolean;
}

/**
 * Turns what the owner typed into S3 settings that actually work — or a
 * message saying why not. Nothing is saved until this passes.
 *
 * Backblaze: the key is checked with `b2_authorize_account` (as the backup
 * copy does), which also says where the bucket's S3 address is — so the
 * owner only gives the bucket and the key. Any provider: a probe object is
 * written, read and deleted, the same check the server makes at start.
 */
export async function checkStorage(
  form: StorageForm,
): Promise<{ ok: true; options: S3StorageOptions } | { ok: false; message: string }> {
  const bucket = form.bucket.trim();
  if (!bucket) return { ok: false, message: 'Fill in the bucket name.' };
  if (!form.accessKeyId.trim() || !form.secretAccessKey.trim()) {
    return { ok: false, message: 'Fill in the key ID and the secret (application key).' };
  }

  let endpoint = form.endpoint?.trim() || undefined;
  let region = form.region?.trim() || 'us-east-1';

  if (form.provider === 'b2') {
    try {
      const auth = Buffer.from(`${form.accessKeyId.trim()}:${form.secretAccessKey.trim()}`).toString('base64');
      const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(B2_AUTH_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as {
        allowed?: { bucketName?: string | null };
        apiInfo?: { storageApi?: { s3ApiUrl?: string } };
        s3ApiUrl?: string;
        message?: string;
      };
      const verdict = b2Verdict({ status: res.status, allowed: body.allowed, message: body.message }, bucket);
      if (!verdict.ok) return { ok: false, message: verdict.message };

      const s3ApiUrl = body.apiInfo?.storageApi?.s3ApiUrl ?? body.s3ApiUrl ?? '';
      const found = b2RegionOf(s3ApiUrl);
      if (!found) return { ok: false, message: 'Backblaze did not say where the bucket\'s S3 address is.' };
      endpoint = s3ApiUrl.replace(/\/$/, '');
      region = found;
    } catch (error) {
      return {
        ok: false,
        message: `Could not reach Backblaze — ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
  }

  const options: S3StorageOptions = {
    bucket,
    endpoint,
    region,
    accessKeyId: form.accessKeyId.trim(),
    secretAccessKey: form.secretAccessKey.trim(),
    forcePathStyle: form.forcePathStyle === true,
    prefix: normalisePrefix(form.prefix),
  };

  try {
    await new S3ScreenshotStorage(options).probe();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, options };
}
