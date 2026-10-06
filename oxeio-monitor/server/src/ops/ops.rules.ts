/**
 * All the **decisions** about backup and health, as pure functions with no I/O.
 *
 * There is no `fs`, no Prisma, no `new Date()` here; time always arrives as a
 * parameter. The wrong answers to this file's questions are all **silent**:
 * a wrong name means the rotation rule will not recognise the file, a wrong
 * rotation rule deletes the last good copy, and a wrong verdict means running
 * for months without a backup. All three are discovered on exactly the day when
 * nothing can be done, so the decision logic is kept separate from the database
 * and disk, and testable.
 */

import { instantOfWorkWall, workWallOf } from '../agent/util/work-time';
import {
  BACKUP_CRITICAL_DAYS,
  BACKUP_EXT,
  BACKUP_KEEP_DAYS,
  BACKUP_KEEP_MIN,
  BACKUP_PART_EXT,
  BACKUP_PREFIX,
  BACKUP_SHA_EXT,
  BACKUP_STALE_HOURS,
  HEALTH_PENDING_ALERTS_MAX,
  PART_MAX_AGE_HOURS,
} from './ops.constants';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ════════════════════════════════════════════════════════════════════════════
// 1. Backup names: the name is the only metadata
// ════════════════════════════════════════════════════════════════════════════

/**
 * The date is in the file name, and that is the only basis for rotation.
 *
 * Rotating by `mtime` would be possible, but copying to the external drive or
 * restoring a file changes `mtime`; a six-month-old backup would then look like
 * "today's" and never rotate out. The name does not change.
 *
 * Careful: the date is work-zone time. In Asia/Dhaka the 03:30 dump is 21:30 the previous day in
 * UTC; building the name from UTC would shift the file's date, and "which
 * night's backup", by one day.
 *
 * Careful: the name has hours and minutes too. With only a date, a second
 * backup run by hand on the same day would silently overwrite the first.
 */
export function backupFileName(now: Date): string {
  const s = workWallOf(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}` +
    `-${pad(s.getUTCHours())}${pad(s.getUTCMinutes())}`;
  return `${BACKUP_PREFIX}-${stamp}${BACKUP_EXT}`;
}

/** Exactly this name shape counts as a backup, nothing else */
const NAME_RE = new RegExp(
  `^${BACKUP_PREFIX}-(\\d{4})-(\\d{2})-(\\d{2})-(\\d{2})(\\d{2})` +
    `${BACKUP_EXT.replace(/\./g, '\\.')}$`,
);

/**
 * Name → the moment of the backup. `null` if not recognised.
 *
 * Careful: returning `null` means "this is not our file", and the rotation rule
 * **does not touch** such files. A `restore-note.txt` a person left in the
 * backup folder, or a `before-migration.dump` taken by hand, must never be
 * deleted by this job.
 */
export function parseBackupName(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;

  const [, y, mo, d, hh, mm] = m;
  const localUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mm),
  );
  const at = instantOfWorkWall(new Date(localUtc));

  // Careful: `2026-13-45` would pass the regex (two digits each), but Date.UTC
  // would silently roll it into the next month. A junk name would then count as
  // a "backup from the future" and be protected forever. So it is round-tripped.
  return backupFileName(at) === name ? at : null;
}

export function isBackupFile(name: string): boolean {
  return parseBackupName(name) !== null;
}

/** An incomplete dump: `oxeio-….dump.enc.part` */
export function isPartFile(name: string): boolean {
  return (
    name.endsWith(BACKUP_PART_EXT) &&
    isBackupFile(name.slice(0, -BACKUP_PART_EXT.length))
  );
}

export interface BackupFile {
  name: string;
  at: Date;
}

/** The recognised backups, in **newest to oldest** order */
export function listBackups(names: readonly string[]): BackupFile[] {
  const files: BackupFile[] = [];
  for (const name of names) {
    const at = parseBackupName(name);
    if (at) files.push({ name, at });
  }
  return files.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Rotation rule: the most dangerous function in this file
// ════════════════════════════════════════════════════════════════════════════

/**
 * Which backups may be deleted.
 *
 * Three guards, each preventing a different danger:
 *
 *  1. **A name that does not match is never touched.** Whatever else is in the
 *     backup folder (`README-restore.txt`, a dump taken by hand, a `.sha256`
 *     sidecar) is not this job's business.
 *  2. **The newest few always stay** (`keepMin`), whatever their age. If
 *     backups fail for 40 days, the simple age rule would delete the last good
 *     copy: exactly when a backup is needed, the disk is spotless and empty.
 *  3. Among the rest, only those older than `keepDays` go.
 *
 * Careful: a file dated in the future (if the server clock goes back) counts as
 * the newest and so is protected; the mistake errs toward keeping, not deleting.
 */
export function backupsToDelete(
  names: readonly string[],
  now: Date,
  keepDays = BACKUP_KEEP_DAYS,
  keepMin = BACKUP_KEEP_MIN,
): string[] {
  const files = listBackups(names);
  const floor = now.getTime() - keepDays * DAY_MS;

  return files
    .slice(Math.max(0, keepMin))
    .filter((f) => f.at.getTime() < floor)
    .map((f) => f.name);
}

/**
 * An orphan `.sha256`: one whose backup no longer exists.
 *
 * Careful: the sidecar is written **before** the dump (so a backup is never
 * without integrity data, even for a moment). If the process dies between those
 * two renames, the sidecar is left behind and its backup never arrives. A small
 * file, but piling up over years the folder would become one where you cannot
 * tell which are the real backups.
 *
 * Careful: only those whose remaining name part fits **our pattern**. Someone's
 * own `notes.sha256` will never be in this list.
 */
export function orphanSidecars(names: readonly string[]): string[] {
  const present = new Set(names);

  return names.filter((name) => {
    if (!name.endsWith(BACKUP_SHA_EXT)) return false;
    const base = name.slice(0, -BACKUP_SHA_EXT.length);
    if (!isBackupFile(base)) return false;
    return !present.has(base) && !present.has(base + BACKUP_PART_EXT);
  });
}

/**
 * Leftover incomplete dumps: what remains if the process dies midway.
 *
 * Careful: this uses `mtime`, not the date in the name, because the question is
 * not "which night's backup" but "is it **still being written**". The file of a
 * running dump is also `.part`, and deleting it would ruin the backup in progress.
 */
export function stalePartFiles(
  entries: readonly { name: string; mtime: Date }[],
  now: Date,
  maxAgeHours = PART_MAX_AGE_HOURS,
): string[] {
  const floor = now.getTime() - maxAgeHours * HOUR_MS;
  return entries
    .filter((e) => isPartFile(e.name) && e.mtime.getTime() < floor)
    .map((e) => e.name);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. G04: when to speak up about backups
// ════════════════════════════════════════════════════════════════════════════

export type BackupProblem =
  /** No `BACKUP_PASSPHRASE`: backups are not running at all */
  | 'not_configured'
  /** The last attempt failed */
  | 'failed'
  /** Not a single backup has ever succeeded */
  | 'never'
  /** It succeeded, but long ago: the job is no longer running */
  | 'stale'
  /** The dump was made, but not copied to the external drive (K03) */
  | 'copy_failed';

export interface BackupState {
  /** Whether `BACKUP_PASSPHRASE` exists; if not, backups are not run at all */
  configured: boolean;
  lastAttemptAt: Date | null;
  lastOutcome: 'ok' | 'failed' | null;
  lastSuccessAt: Date | null;
  /** How many failures in a row; 0 as soon as one succeeds */
  consecutiveFailures: number;
  /** K03: result of the last copy. `null` = no copy is configured at all */
  lastCopyOutcome: 'ok' | 'failed' | null;
  /**
   * Since when we have been watching (server boot or first record).
   *
   * Without it a freshly installed server would shout "no backup" in its first
   * minute, when the first backup's time has not even come.
   */
  observedSince: Date | null;
}

export interface BackupVerdict {
  problem: BackupProblem;
  severity: 'warning' | 'critical';
  hoursSinceSuccess: number | null;
  daysSinceSuccess: number | null;
}

/**
 * **Says nothing on success**: returns `null`.
 *
 * This is the heart of G04. Reporting "backup done" every day sends that mail
 * to a filter within a week, and with it the message for the day it **did not**
 * happen. Silence here is the good news, and that silence is what gives the
 * message its value.
 *
 * Severity rises after two days (`criticalDays`): a one-night failure is often
 * temporary (drive not plugged in, disk full), but two nights in a row means
 * nobody looked, and then each day pushes back the recoverable past by another day.
 */
export function backupVerdict(
  state: BackupState,
  now: Date,
  staleHours = BACKUP_STALE_HOURS,
  criticalDays = BACKUP_CRITICAL_DAYS,
): BackupVerdict | null {
  const sinceSuccessMs = state.lastSuccessAt
    ? now.getTime() - state.lastSuccessAt.getTime()
    : null;
  const hoursSinceSuccess =
    sinceSuccessMs === null ? null : Math.floor(sinceSuccessMs / HOUR_MS);
  const daysSinceSuccess =
    sinceSuccessMs === null ? null : Math.floor(sinceSuccessMs / DAY_MS);

  const stale = sinceSuccessMs === null || sinceSuccessMs >= staleHours * HOUR_MS;

  // Careful: `consecutiveFailures` is compared directly with days. The job runs
  // once a day, so "2 failures in a row" is about "2 days in a row". If someone
  // ran it by hand repeatedly the count would rise fast, but a higher severity
  // is desirable then: the mistake errs toward shouting, not toward silence.
  const escalated =
    state.consecutiveFailures >= criticalDays ||
    (sinceSuccessMs !== null && sinceSuccessMs >= criticalDays * DAY_MS) ||
    // Never succeeded, yet we have been watching for over two days: serious too
    (state.lastSuccessAt === null &&
      state.observedSince !== null &&
      now.getTime() - state.observedSince.getTime() >= criticalDays * DAY_MS);

  const withSeverity = (problem: BackupProblem): BackupVerdict => ({
    problem,
    severity: escalated ? 'critical' : 'warning',
    hoursSinceSuccess,
    daysSinceSuccess,
  });

  // No config at all is the state to shout loudest about: nothing "failed";
  // backing up is not happening at all, and it is happening silently.
  if (!state.configured) return withSeverity('not_configured');

  if (state.lastOutcome === 'failed') return withSeverity('failed');

  if (state.lastSuccessAt === null) {
    // Nothing has happened yet and we have only just started watching: staying quiet is right
    if (
      state.lastAttemptAt === null &&
      (state.observedSince === null ||
        now.getTime() - state.observedSince.getTime() < staleHours * HOUR_MS)
    ) {
      return null;
    }
    return withSeverity('never');
  }

  if (stale) return withSeverity('stale');

  // The dump is fine but did not reach the external drive: that is a failure
  // too. A backup sitting on the same disk is useless if that disk dies, yet the
  // dashboard would say "backup is fine".
  if (state.lastCopyOutcome === 'failed') {
    return { ...withSeverity('copy_failed'), severity: 'warning' };
  }

  return null;
}

/** Alert title and detail. Careful: no paths, passphrases or hosts. */
export function backupAlertText(verdict: BackupVerdict): {
  title: string;
  detail: string;
} {
  const age =
    verdict.daysSinceSuccess === null
      ? 'There has never been a successful backup'
      : `Last successful backup ${verdict.daysSinceSuccess}d ${(verdict.hoursSinceSuccess ?? 0) % 24}h ago`;

  switch (verdict.problem) {
    case 'not_configured':
      return {
        title: 'Backup is not running — BACKUP_PASSPHRASE is not set',
        detail:
          'Without an encryption passphrase the nightly backup is not run at all. ' +
          'Leaving backup off is better than dropping the salary and screenshot ' +
          'database on disk in plaintext — but you need to know about it. ' +
          'Set BACKUP_PASSPHRASE in `.env` and restart the server.',
      };
    case 'failed':
      return {
        title: 'The nightly backup failed',
        detail: `${age}. Check ops/backup in the server log — is pg_dump available, is there space on disk?`,
      };
    case 'never':
      return {
        title: 'No backup has ever been made',
        detail:
          'The backup job is running, but not one successful dump has been produced so far. ' +
          'Check ops/backup in the server log.',
      };
    case 'stale':
      return {
        title: 'Backup has stopped',
        detail: `${age}. Check whether the job runs at all — was the server up at 3:30 AM?`,
      };
    case 'copy_failed':
      return {
        title: 'Backup was not copied to the external drive',
        detail:
          'The dump was created, but it could not be copied to the BACKUP_COPY_TO drive. ' +
          'Check whether the drive is attached and has space. ' +
          'A backup sitting on the same disk is worthless once that disk dies.',
      };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 4. K04: the server health verdict
// ════════════════════════════════════════════════════════════════════════════

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthFacts {
  dbUp: boolean;
  /** `null` = disk info could not be read */
  diskUsedPct: number | null;
  /** Exactly the **same** verdict as G04; the two places cannot calculate differently */
  backup: BackupVerdict | null;
  activeDevices: number;
  silentDevices: number;
  /** Alerts not yet sent on any channel */
  pendingAlerts: number;
  /**
   * Screenshot store, when it is not the local disk (STORAGE_DRIVER=s3):
   * could the bucket be reached. Absent for the local driver — the disk
   * figures above already speak for it.
   */
  screenshotStore?: { location: string; reachable: boolean };
}

export interface HealthVerdict {
  status: HealthStatus;
  /** Human-readable list of problems; empty means everything is fine */
  problems: string[];
}

/**
 * "Silent devices" never worsen the status; they are only counted.
 *
 * At 19:00 everyone's PC is off, so fifteen of fifteen are silent. Calling that
 * "degraded" would keep the health page red every day from evening to morning,
 * and something red half the time is something nobody looks at. Which silence
 * is really news is already decided by G01 (`isExpectedSilence`); adding a
 * dumber version of it here would give two answers, both unreliable.
 */
export function healthVerdict(facts: HealthFacts): HealthVerdict {
  const problems: string[] = [];

  if (!facts.dbUp) {
    return { status: 'down', problems: ['No connection to the database'] };
  }

  if (facts.diskUsedPct === null) {
    problems.push('Could not read disk info');
  } else if (facts.diskUsedPct >= 95) {
    problems.push(
      `Disk ${Math.round(facts.diskUsedPct)}% full — screenshot ingest could stall at any moment`,
    );
  } else if (facts.diskUsedPct >= 80) {
    problems.push(`Disk ${Math.round(facts.diskUsedPct)}% full`);
  }

  if (facts.screenshotStore && !facts.screenshotStore.reachable) {
    problems.push(
      `Screenshot storage unreachable (${facts.screenshotStore.location}) — new screenshots are being refused`,
    );
  }

  if (facts.backup) {
    problems.push(backupAlertText(facts.backup).title);
  }

  if (facts.pendingAlerts > HEALTH_PENDING_ALERTS_MAX) {
    problems.push(
      `${facts.pendingAlerts} alerts waiting to be sent — is the dispatcher stuck?`,
    );
  }

  return { status: problems.length === 0 ? 'ok' : 'degraded', problems };
}

// ════════════════════════════════════════════════════════════════════════════
// 5. G08: how much goes to Telegram
// ════════════════════════════════════════════════════════════════════════════

/**
 * Telegram messages are built with an **allowlist**, not a denylist.
 *
 * Telegram is an outside service: the message is stored on Telegram's servers,
 * and anyone can be in the group. So an alert's `title`/`detail` is **never**
 * sent as it is; they are free text, and if someone later put a domain, a
 * window title or a money amount in a new alert, a denylist would not recognise
 * it, and the leak would happen silently, every day.
 *
 * What goes here: **the type label, the hostname, when**. That is all.
 * Staff names do not go, because "who did not do what" is never a matter for an
 * outside channel.
 */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  agent_down: 'Agent silent',
  agent_killed: 'Agent stopped or uninstalled',
  disk_warning: 'Server disk filling up',
  disk_critical: 'Server disk almost full',
  backup_failed: 'Backup failed',
  clock_drift: 'Agent clock has drifted',
  no_activity_today: 'Someone has no work all day',
  // This used to say "Multiple staff on one device", the exact **opposite**.
  // G32's case is one staff member on two devices, not two people on one
  // device. That label went to Telegram, and whoever read it looked at the
  // wrong PC.
  device_overlap: 'One person on two devices',
};

/**
 * Filters the hostname.
 *
 * Careful: only `A–Z a–z 0–9 . _ -` are kept, cut to 32 characters. The
 * hostname column can take any string, whatever the agent sends. If someone
 * puts something twisted in a hostname, it must not go straight outside.
 */
export function safeHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32);
  return cleaned.length > 0 ? cleaned : null;
}

export interface TelegramAlertFacts {
  type: string;
  severity: string;
  hostname?: string | null;
  createdAt: Date;
}

/** One alert's single line. Careful: title/detail deliberately never go in here */
export function telegramLine(alert: TelegramAlertFacts, now: Date): string {
  const label = TYPE_LABELS[alert.type] ?? 'Alert';
  const mark = alert.severity === 'critical' ? '🔴' : '🟡';
  const host = safeHostname(alert.hostname);
  const minutes = Math.max(
    0,
    Math.floor((now.getTime() - alert.createdAt.getTime()) / MINUTE_MS),
  );
  const when = minutes < 1 ? 'just now' : `${minutes} min ago`;

  return `${mark} ${label}${host ? ` — ${host}` : ''} · ${when}`;
}

/**
 * The whole message. Careful: it is sent as plain text, without `parse_mode`:
 * with Markdown/HTML a single `_` or `<` in a hostname would break the whole
 * message in Telegram's parser (400), so the very alert that is urgent would not go out.
 */
export function telegramMessage(
  alerts: readonly TelegramAlertFacts[],
  now: Date,
): string {
  const header =
    alerts.length === 1
      ? 'oXeio Monitoring'
      : `oXeio Monitoring — ${alerts.length} alerts`;

  return [header, '', ...alerts.map((a) => telegramLine(a, now))].join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Splitting DATABASE_URL: what pg_dump needs
// ════════════════════════════════════════════════════════════════════════════

export interface PgConnection {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/**
 * `postgresql://user:pass@host:5432/db?schema=public` → the parts for pg_dump.
 *
 * Careful: the username and password are **decoded**. `URL` returns them
 * percent-encoded, so `p@ss` is written as `p%40ss`. Without decoding, pg_dump
 * would send the wrong password and the backup would fail every night with
 * "authentication failed", while the app itself ran fine because Prisma does
 * the decoding. A failure whose cause is hard to find.
 */
export function parsePgUrl(raw: string | undefined | null): PgConnection | null {
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return null;
  }

  const database = decode(url.pathname.replace(/^\//, ''));
  if (!database) return null;

  return {
    // `hostname`, not `host`: `host` comes with the port, and for IPv6 `[::1]`
    // with brackets. pg_dump's `-h` wants neither.
    host: url.hostname || 'localhost',
    port: url.port || '5432',
    user: decode(url.username) || 'postgres',
    password: decode(url.password),
    database,
  };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // An invalid `%` sequence: return it as it is, otherwise the whole backup would be stuck
    return value;
  }
}
