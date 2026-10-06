/**
 * K02 · K03 · K04 · G04 · G08 — all the thresholds for backup, health and Telegram.
 *
 * Kept in a separate file like `alerts.constants.ts`: these numbers are
 * **rules**, not implementation. With what each change costs visible in one
 * place, nobody can quietly say "30 days is a lot, make it 7" and shrink the
 * whole restore window.
 */

// ── K02 · nightly pg_dump ───────────────────────────────────────────────────

/** Spec § 6.4: 02:30 (after the K01 retention job finishes at 02:00) */
export const BACKUP_CRON = '0 30 2 * * *';

/**
 * The only prefix of a backup's name; rotation relies on exactly this pattern.
 * If it changes, old files are no longer recognised as backups, so they would
 * stay on disk forever and only the new ones would rotate.
 */
export const BACKUP_PREFIX = 'oxeio';

/** Extension of the encrypted dump: `pg_dump -Fc` (custom, compressed) */
export const BACKUP_EXT = '.dump.enc';

/** Extension of an incomplete file; it gets its real name only after success */
export const BACKUP_PART_EXT = '.part';

/** The integrity file beside it; `sha256sum -c` reads exactly this format */
export const BACKUP_SHA_EXT = '.sha256';

/**
 * 30 days: 07 § 6.4 ("keep 30 days"). The task description said "e.g. 14 days"
 * as an example; when they conflict the doc is the source of truth (09 § 4),
 * so 30. Can be changed with the `BACKUP_KEEP_DAYS` env var.
 */
export const BACKUP_KEEP_DAYS = 30;

/**
 * However old, the newest **two** backups are never deleted.
 *
 * If backups fail for 40 days, the simple rule "delete everything older than
 * 30 days" would delete exactly the last good copy, so on the day a backup is
 * **needed** nothing would be left. Two are kept so that if the newest turns
 * out to be bad, the one before it is still there.
 */
export const BACKUP_KEEP_MIN = 2;

/**
 * After this long, "last night's backup did not happen" is assumed.
 *
 * 26 hours, not 24: the job runs at 02:30 and the check a little later. At
 * exactly 24, an alert would fire for "stale" 24 hours and 1 minute after a
 * successful backup, when the next one is not due yet.
 */
export const BACKUP_STALE_HOURS = 26;

/** G04: severity rises to critical after this many days with no successful backup */
export const BACKUP_CRITICAL_DAYS = 2;

/**
 * A leftover `.part` file older than this is deleted. If the process dies
 * midway, a half dump stays on disk; piled up until the disk is full, they
 * would block the very ingest the backup exists to protect.
 */
export const PART_MAX_AGE_HOURS = 12;

/**
 * A hung pg_dump is killed after this long. Without it one stuck dump would
 * block the next day's dump too (RunLock), a hang turning into permanent silence.
 */
export const BACKUP_TIMEOUT_MS = 30 * 60_000;

/**
 * PBKDF2 rounds: `openssl enc -pbkdf2 -iter` will want exactly this number at
 * restore time. Changing it makes old files unopenable, so it is effectively
 * **permanent**. To change it, put a version in the file name.
 */
export const PBKDF2_ITERATIONS = 200_000;

// ── K04 · health ────────────────────────────────────────────────────────────

/**
 * With this many alerts waiting to be sent, the dispatcher is assumed stuck.
 * The number is large (100) because in a real storm (everyone's PC off at once)
 * a few dozen queued is normal, but 100 means nobody is sending.
 */
export const HEALTH_PENDING_ALERTS_MAX = 100;

/** Threshold for counting as "silent" in health; matches G01 (alerts.constants) */
export const HEALTH_SILENCE_MIN = 10;

/** G04: how often the stale-backup check runs; a few times a day is enough */
export const BACKUP_CHECK_TICK_MS = 60 * 60_000;

// ── G08 · Telegram ──────────────────────────────────────────────────────────

/** So a hung Telegram API cannot block the whole sweep */
export const TELEGRAM_TIMEOUT_MS = 10_000;

/**
 * A **separate**, much larger timeout for file uploads.
 *
 * The 10 seconds above is sized for a text POST. For a workbook of a few MB
 * over the VPS link it failed regularly, and the failure looked exactly like a
 * "wrong token". The one above stays small, otherwise a hung upload would
 * block the 60-second alert sweep.
 */
export const TELEGRAM_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Telegram's **own** ceiling, not our choice: the bot API's `sendDocument`
 * takes nothing over 50 MB. Without measuring first, the rejection would come
 * **after** the whole upload cost was spent.
 * A database dump is usually bigger than this; backups are not meant to go this way.
 */
export const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

/** The caption limit is 1024 (not the message's 4096); over it, the whole call is a 400 */
export const TELEGRAM_CAPTION_MAX = 1024;

/** The most alerts that go in one message per round */
export const TELEGRAM_BATCH = 10;

/**
 * Alerts older than this no longer go to Telegram, for the same reason as the
 * email `DISPATCH_MAX_AGE_HOURS`: after a week off, three hundred stale
 * messages coming out at once is just another flood.
 */
export const TELEGRAM_MAX_AGE_HOURS = 24;

export const TELEGRAM_TICK_MS = 60_000;

/**
 * This tag in `channels_sent` means the message went to Telegram.
 *
 * The email tags (`email` · `log` · `email_failed`) are **set** by
 * AlertDispatcher (`channelsSent: [channel]`, which replaces the whole array).
 * So Telegram only touches rows whose `channels_sent` is **not empty**, i.e.
 * email's turn is over. The other way round, Telegram would set its tag first,
 * the dispatcher's `isEmpty` filter would no longer pick the row up, and the
 * alert would never go out by email.
 */
export const TELEGRAM_CHANNEL_TAG = 'telegram';

/**
 * Set after three failed attempts. Otherwise a wrong token would retry the same
 * ten alerts every minute forever, and the newer ones piling up behind them
 * would never reach the front of the queue.
 */
export const TELEGRAM_FAILED_TAG = 'telegram_failed';

export const TELEGRAM_MAX_ATTEMPTS = 3;

/**
 * **Alerts that do not go to Telegram** *(18 August 2026)*.
 *
 * Measured in the field: in the last 24 hours `agent_down` fired **39 times**,
 * **168 times** in a week. 13 PCs shut down daily, sleep at lunch, the network
 * flickers, and each one is a message. The owner said they do not want this
 * type of alert.
 *
 * This is exactly the flood that led to dropping the real-time idle alert
 * ([10-Roadmap](../../../docs/10-Roadmap.md): "then nobody would read any
 * message"); this time it just came through another door.
 *
 * **The alert is not deleted**: this is only a **channel** filter. The row is
 * created, goes by email, appears on the Alerts page, and closes itself (§ 3.v2).
 * Only the per-alert phone message is skipped; once a day, at the end of the
 * daily report, they are counted in one line.
 *
 * **What must not go here:** `backup_failed` · `disk_low` · `agent_tamper`.
 * These are rare, and each one really needs to be known right now.
 */
export const TELEGRAM_MUTED_TYPES = ['agent_down'] as const;

// ── R5 · offsite (Backblaze B2) ─────────────────────────────────────────────

/**
 * Limit for the screen's "Test the connection" button. Kept small on purpose:
 * the owner is sitting there after pressing the button, so the answer should be
 * quick. If B2 does not respond, "could not reach it" is enough; no need to spin for 30 seconds.
 */
export const B2_AUTH_TIMEOUT_MS = 10_000;
