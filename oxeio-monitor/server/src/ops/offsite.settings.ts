/**
 * **Offsite backup settings (R5 · G39)**: pure rules, no I/O.
 *
 * Why this was needed: setting the B2 key pair meant SSH into the VPS, running
 * `rclone config`, then editing `/etc/oxeio-offsite.env`. That is practically
 * impossible for the owner, and in the field it went wrong exactly that way:
 * a badly pasted key gave `401 bad_auth_token`, and finding the cause meant
 * poking around in a terminal.
 *
 * Now it can be set from the screen and **tested immediately**. `.env` and
 * `/etc/oxeio-offsite.env` **stay as a fallback**, so old installations keep
 * working.
 *
 * Careful: the shape deliberately mirrors `alerts/telegram.settings.ts`. If the
 * rules for keeping secrets and not sending them to the screen differed between
 * the two places, one of them would eventually have a gap.
 */

/** The key under which it is stored in the `settings` table */
export const OFFSITE_SETTING_KEY = 'ops.offsite';

export interface OffsiteSettings {
  /** B2 `keyID`, 25 characters */
  keyId: string;
  /** B2 `applicationKey`, 31 characters. Secret. */
  appKey: string;
  /** e.g. `oxeio-backups` */
  bucket: string;
}

/**
 * **What goes to the screen: never the applicationKey.**
 *
 * Sent to the browser it could show up in DevTools, proxy logs or screen
 * shares. So only the **last four characters** go, so the owner can check which
 * key is set, while nobody can use it to touch the backups.
 */
export interface OffsiteSettingsView {
  configured: boolean;
  /** `…9f2a`, or `null` when nothing is set */
  keyHint: string | null;
  /**
   * The keyID is **not secret**: it is only an identifier and does nothing on
   * its own (like Telegram's `chatId`). It is sent back in full so "keep the
   * previous one" really works on screen; otherwise fixing the bucket would
   * wipe the keyID.
   */
  keyId: string;
  /** The bucket name is not secret: nothing can be done with it */
  bucket: string;
  /** Database or server file: the owner needs to know which one is in effect */
  source: 'database' | 'env' | 'none';
}

/**
 * Nothing is shown below four characters: a very short value is either a
 * mistake or a test value, and showing part of it helps nobody.
 */
export function keyHint(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length < 4) return null;

  return `…${trimmed.slice(-4)}`;
}

/**
 * Merges the database and the server file to decide **which one actually applies**.
 *
 * The database wins, but **only when all three fields are filled**. With two
 * filled and one left empty, offsite would be half configured and silently off
 * while a working value still sits on the server; the screen could be used to
 * **break** it.
 */
export function resolveOffsite(
  db: Partial<OffsiteSettings> | null,
  env: Partial<OffsiteSettings>,
): { settings: OffsiteSettings | null; source: 'database' | 'env' | 'none' } {
  const pick = (s: Partial<OffsiteSettings> | null | undefined) => ({
    keyId: s?.keyId?.trim() ?? '',
    appKey: s?.appKey?.trim() ?? '',
    bucket: s?.bucket?.trim() ?? '',
  });

  const fromDb = pick(db);
  if (fromDb.keyId && fromDb.appKey && fromDb.bucket) {
    return { settings: fromDb, source: 'database' };
  }

  const fromEnv = pick(env);
  if (fromEnv.keyId && fromEnv.appKey && fromEnv.bucket) {
    return { settings: fromEnv, source: 'env' };
  }

  return { settings: null, source: 'none' };
}

/**
 * The picture for the screen.
 *
 * Careful: `source` is sent on purpose. When the server file has a value and a
 * new one is entered on screen, without saying which one is in effect the owner
 * would think the save failed, when it worked and the other one just does not win.
 */
export function offsiteView(
  resolved: ReturnType<typeof resolveOffsite>,
): OffsiteSettingsView {
  const s = resolved.settings;

  return {
    configured: s !== null,
    keyHint: s ? keyHint(s.appKey) : null,
    keyId: s?.keyId ?? '',
    bucket: s?.bucket ?? '',
    source: resolved.source,
  };
}

/**
 * **Whether the B2 key pair really works.** This is the test that had to be done
 * by hand in a terminal during the August incident.
 *
 * B2's `b2_authorize_account` is a plain HTTPS GET with Basic auth
 * (`keyId:appKey`). It works even with a restricted key (no permission to list
 * buckets needed), and the reply's `allowed.bucketName` says **which** bucket
 * the key is bound to, so a wrong bucket is caught too.
 *
 * This is not a pure function (it needs the network), but **the decision** is
 * pure: `b2Verdict()` below only reads the reply and gives a verdict, so it can
 * be tested.
 */
export interface B2AuthReply {
  status: number;
  /** B2's JSON; may have `allowed.bucketName` */
  allowed?: { bucketName?: string | null; capabilities?: string[] };
  /** B2's message on failure */
  message?: string;
}

export interface B2Verdict {
  ok: boolean;
  /** One line fit to show on screen */
  message: string;
  /** The bucket the key is bound to (`null` if unrestricted) */
  boundTo: string | null;
}

export function b2Verdict(reply: B2AuthReply, bucket: string): B2Verdict {
  if (reply.status === 401) {
    return {
      ok: false,
      // This exact mistake happened in the field, so the message says what to do
      message:
        'Backblaze rejected the key (401). The application key is usually the problem — it is shown only once, so copy it again or make a new one.',
      boundTo: null,
    };
  }

  if (reply.status !== 200) {
    return {
      ok: false,
      message: `Backblaze answered ${reply.status}${reply.message ? ` — ${reply.message}` : ''}`,
      boundTo: null,
    };
  }

  const bound = reply.allowed?.bucketName ?? null;

  /**
   * The key is fine but **bound to another bucket**: a perfect source of silent
   * failure. Everything would look green while the backups went elsewhere (or nowhere).
   */
  if (bound !== null && bucket.trim().length > 0 && bound !== bucket.trim()) {
    return {
      ok: false,
      message: `The key works, but it is restricted to the bucket “${bound}”, not “${bucket.trim()}”.`,
      boundTo: bound,
    };
  }

  return {
    ok: true,
    message: bound
      ? `Connected. The key is restricted to “${bound}”, which is what we want.`
      : 'Connected. This key can reach every bucket in the account.',
    boundTo: bound,
  };
}
