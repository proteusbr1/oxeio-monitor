import { spawn } from 'node:child_process';
import { createHash, pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { storageRoot } from '../common/storage.config';
import { RunLock } from '../summary/scheduling';
import { AppSettingsService } from '../settings/app-settings.service';
import { type BackupMode } from './backup-mode';
import { BackupStateStore } from './backup.state';
import {
  BACKUP_KEEP_DAYS,
  BACKUP_PART_EXT,
  BACKUP_SHA_EXT as SHA_EXT,
  BACKUP_TIMEOUT_MS,
  PBKDF2_ITERATIONS,
} from './ops.constants';
import {
  backupFileName,
  backupsToDelete,
  isBackupFile,
  isPartFile,
  orphanSidecars,
  parsePgUrl,
  stalePartFiles,
  type PgConnection,
} from './ops.rules';

/** How many bytes of pg_dump's stderr to keep (memory guard) */
const STDERR_CAP = 4000;

export interface BackupCopyResult {
  /** Whether it was configured; if not, the copy is not "failed", just off */
  configured: boolean;
  ok: boolean;
  error: string | null;
  target: string | null;
}

export interface BackupResult {
  ok: boolean;
  /** Why it was not run; `null` if it ran */
  skipped: 'not_configured' | 'already_running' | 'external' | null;
  fileName: string | null;
  sizeBytes: number | null;
  durationMs: number;
  error: string | null;
  copy: BackupCopyResult;
  /** How many old files were rotated (across both folders) */
  rotated: number;
}

/**
 * **K02 + K03**: the 02:30 `pg_dump`, encryption, copy to the external drive,
 * and rotation of old backups.
 *
 * **Encryption is not optional (G39).** This dump holds 15 people's activity
 * month after month, their salary figures and all the screenshot metadata:
 * the most sensitive thing in the whole system in one file, and that file goes
 * onto an external drive that is easy to carry off. Losing that drive means
 * losing everything. So without `BACKUP_PASSPHRASE` the backup **does not run**;
 * no backup is better than quietly leaving plaintext lying around, as long as
 * someone knows about it (G04 reminds them daily).
 *
 * **The format deliberately matches `openssl enc`.** A custom header plus
 * AES-GCM would give integrity, but opening the file would need a tool of our
 * own, and on the day of a disaster (server burned, no repo) that tool is
 * gone. A backup that cannot be opened with a standard tool is not a backup.
 * For integrity a `.sha256` sidecar is kept beside it; `openssl enc` has no
 * AEAD mode, so this is the best compromise.
 *
 * The command to open it (also written in `README-restore.txt`):
 * ```
 * openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
 *   -in oxeio-2026-08-11-0230.dump.enc -out oxeio.dump -pass env:BACKUP_PASSPHRASE
 * pg_restore -d oxeio --clean --if-exists oxeio.dump
 * ```
 */
@Injectable()
export class BackupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupService.name);
  private readonly lock = new RunLock();

  private readonly passphrase: string;
  private readonly dir: string;
  private readonly copyTo: string | null;
  private readonly keepDays: number;
  private readonly pgDumpBin: string;
  private readonly dockerContainer: string | null;
  private readonly dockerBin: string;
  private readonly dockerDbHost: string;
  private readonly databaseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly state: BackupStateStore,
    // BACKUP_MODE, which the owner can also change on the Backup tab
    private readonly settings: AppSettingsService,
  ) {
    this.passphrase = (config.get<string>('BACKUP_PASSPHRASE') ?? '').trim();
    /**
     * **`?.trim() ||`, not `??`: this one-character difference is why the backup
     * never ran.**
     *
     * `.env.example` has the line `BACKUP_DIR=` (empty), so `config.get()`
     * returns an **empty string**, not `undefined`. `??` only catches
     * `null`/`undefined`; an empty string passes through. The default was never
     * used, and `resolve('')` ended up in the **process cwd**, i.e. `/app`,
     * where there is no write permission.
     *
     * The failure was still **loud** (`EACCES`), which was luck: if that folder
     * had been writable the dump would have silently landed inside the container
     * and been wiped on every deploy, with nobody noticing.
     *
     * Every neighbouring option (`BACKUP_COPY_TO`, `BACKUP_PG_DUMP`,
     * `BACKUP_DOCKER_*`) uses `?.trim() ||`; **this was the only `??`**. Two
     * rules in one file is exactly how these bugs are born.
     */
    this.dir = resolve(
      config.get<string>('BACKUP_DIR')?.trim() ||
        // The doc's layout (07 § 6.2): `D:\oXeio\backups\` beside `D:\oXeio\storage\`
        join(storageRoot(config), '..', 'backups'),
    );
    this.copyTo = config.get<string>('BACKUP_COPY_TO')?.trim() || null;

    const keep = Number(config.get<string>('BACKUP_KEEP_DAYS'));
    this.keepDays = Number.isFinite(keep) && keep > 0 ? keep : BACKUP_KEEP_DAYS;

    this.pgDumpBin = config.get<string>('BACKUP_PG_DUMP')?.trim() || 'pg_dump';
    this.dockerContainer =
      config.get<string>('BACKUP_DOCKER_CONTAINER')?.trim() || null;
    this.dockerBin = config.get<string>('BACKUP_DOCKER_BIN')?.trim() || 'docker';
    this.dockerDbHost =
      config.get<string>('BACKUP_DOCKER_DB_HOST')?.trim() || 'localhost';
    this.databaseUrl = config.get<string>('DATABASE_URL') ?? '';
  }

  /**
   * The setup warnings, said once at boot. Not from the constructor: the
   * backup mode may come from the settings table, which can only be read
   * once the app is up — and with BACKUP_MODE=external neither warning is
   * true, the database is backed up elsewhere.
   */
  async onApplicationBootstrap(): Promise<void> {
    const { errors, warnings } = await this.bootWarnings();
    for (const line of errors) this.logger.error(line);
    for (const line of warnings) this.logger.warn(line);
  }

  async bootWarnings(): Promise<{ errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (await this.isExternal()) return { errors, warnings };

    if (!this.passphrase) {
      // The "shouting" starts here: once at boot, then G04 daily.
      errors.push(
        'No BACKUP_PASSPHRASE — the nightly backup will not run. ' +
          'Leaving backup off is safer than dropping the salary and screenshot ' +
          'database on disk without encryption, but you need to know about it (G39).',
      );
    }
    if (!this.copyTo) {
      warnings.push(
        'No BACKUP_COPY_TO — backups will only live on the server\'s own disk (K03 off). ' +
          'If that disk dies, the backups go with it.',
      );
    }
    return { errors, warnings };
  }

  get configured(): boolean {
    return this.passphrase.length > 0;
  }

  /**
   * BACKUP_MODE — saved on the Backup tab, or the environment variable.
   * `external`: the database is backed up by another tool and this server
   * does nothing about it (backup-mode.ts).
   */
  async mode(): Promise<BackupMode> {
    return (await this.settings.backupMode()).mode;
  }

  async isExternal(): Promise<boolean> {
    return (await this.mode()) === 'external';
  }

  /** Whether K03 is on; `null` means no external copy is configured at all */
  get copyTarget(): string | null {
    return this.copyTo;
  }

  /** For the health page. Careful: the passphrase never comes out. */
  get backupDir(): string {
    return this.dir;
  }

  /**
   * One round of backup. Careful: it never throws; a failure is a **value**.
   * Both the scheduler and the manual run go through here.
   */
  async runOnce(now = new Date()): Promise<BackupResult> {
    // a manual "run now" too — the owner said backups happen elsewhere
    if (await this.isExternal()) return emptyResult('external');

    const result = await this.lock.run(() => this.execute(now));

    if (result === null) {
      this.logger.warn('Previous backup still running — skipping this tick');
      return emptyResult('already_running');
    }
    return result;
  }

  private async execute(now: Date): Promise<BackupResult> {
    const startedAt = Date.now();

    if (!this.passphrase) {
      await this.state.markObserved();
      this.logger.error('No BACKUP_PASSPHRASE — backup was not run');
      return emptyResult('not_configured');
    }

    const conn = this.connection();
    if (!conn) {
      const error = 'Could not read DATABASE_URL — backup cannot run';
      this.logger.error(error);
      await this.state.record({ at: now, ok: false, error });
      return { ...emptyResult(null), error, durationMs: Date.now() - startedAt };
    }

    const fileName = backupFileName(now);
    const finalPath = join(this.dir, fileName);
    const partPath = finalPath + BACKUP_PART_EXT;

    let sizeBytes: number | null = null;
    let error: string | null = null;

    try {
      await mkdir(this.dir, { recursive: true });
      const digest = await this.dumpEncrypted(conn, partPath);

      const info = await stat(partPath);
      sizeBytes = info.size;

      // A zero or absurdly small file is a failure. pg_dump can exit with code 0
      // and still write nothing (e.g. empty schema or a closed pipe), and then a
      // "backup" would sit on disk that is actually nothing.
      if (sizeBytes < 512) {
        throw new Error(`The dump is suspiciously small (${sizeBytes} bytes)`);
      }

      await writeFile(partPath + SHA_EXT, `${digest}  ${fileName}\n`, 'utf8');
      // This rename is the only moment "the backup is done" is declared. Before
      // it the file is named `.part`, so neither rotation nor the copy recognises
      // it as a backup: an incomplete dump is never counted as a backup, which
      // is the most important guarantee here.
      await rename(partPath + SHA_EXT, finalPath + SHA_EXT);
      await rename(partPath, finalPath);

      this.logger.log(
        `Backup done: ${fileName} (${sizeBytes} bytes, ${Math.round((Date.now() - startedAt) / 1000)}s)`,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`Backup failed: ${error}`);
      // An incomplete file must not be left behind: someone could later take it
      // for a backup. Being `.part`, rotation would not recognise it and it would stay forever.
      await quietUnlink(partPath, partPath + SHA_EXT);
    }

    const copy = error
      ? { configured: this.copyTo !== null, ok: false, error: null, target: this.copyTo }
      : await this.copyOut(fileName);

    const rotated = await this.rotate(now);

    await this.state.record({
      at: now,
      ok: error === null,
      error,
      fileName: error === null ? fileName : null,
      sizeBytes,
      copy: copy.configured && error === null ? { ok: copy.ok, error: copy.error } : null,
    });

    await this.writeRestoreNote();

    return {
      ok: error === null,
      skipped: null,
      fileName: error === null ? fileName : null,
      sizeBytes,
      durationMs: Date.now() - startedAt,
      error,
      copy,
      rotated,
    };
  }

  // ── pg_dump → AES → file ───────────────────────────────────────────────────

  /**
   * All of it streams: the dump never touches disk as plaintext.
   *
   * **The easiest mistake in this function is not checking the exit code.** If
   * pg_dump dies midway its stdout closes, and `pipeline()` takes that as
   * "stream finished" and returns **successfully**. A perfectly normal-looking
   * file would be created, the `.sha256` would match, the copy would happen, and
   * that it is half a dump would be learned on restore day. So the exit code is
   * checked separately **after** the stream ends.
   */
  private async dumpEncrypted(
    conn: PgConnection,
    partPath: string,
  ): Promise<string> {
    const { command, args, env } = this.dumpCommand(conn);

    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      // A hung dump dies by itself; otherwise it would hold the RunLock and
      // block the next day's backup too.
      timeout: BACKUP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
    });

    const exited = new Promise<number>((res, rej) => {
      child.once('error', rej);
      child.once('close', (code) => res(code ?? -1));
    });
    // A handler up front: if pipeline throws first, this promise would become an
    // unhandled rejection and bring the whole process down.
    void exited.catch(() => undefined);

    const stdout = child.stdout;
    if (!stdout) throw new Error('Could not get stdout from pg_dump');

    const salt = randomBytes(8);
    const keyIv = pbkdf2Sync(this.passphrase, salt, PBKDF2_ITERATIONS, 48, 'sha256');
    const cipher = createCipheriv(
      'aes-256-cbc',
      keyIv.subarray(0, 32),
      keyIv.subarray(32, 48),
    );

    const hash = createHash('sha256');
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    const out = createWriteStream(partPath);
    // The `openssl enc` header: ASCII "Salted__" + 8 bytes of salt
    const header = Buffer.concat([Buffer.from('Salted__', 'ascii'), salt]);
    hash.update(header);
    out.write(header);

    try {
      await pipeline(stdout, cipher, tap, out);
    } catch (err) {
      child.kill();
      throw new Error(
        `Could not write the dump: ${err instanceof Error ? err.message : 'unknown error'}` +
          (stderr ? ` · pg_dump: ${firstLine(stderr)}` : ''),
      );
    }

    let code: number;
    try {
      code = await exited;
    } catch (err) {
      throw new Error(this.spawnHint(command, err));
    }

    if (code !== 0) {
      throw new Error(
        `pg_dump exited with code ${code}${stderr ? ` — ${firstLine(stderr)}` : ''}`,
      );
    }

    return hash.digest('hex');
  }

  /**
   * Where pg_dump is. When Postgres runs in Docker, `pg_dump` is **not on the
   * host at all**, so the one inside the container is run via `docker exec`.
   * Both paths are configurable, because the code cannot know which is true.
   */
  private dumpCommand(conn: PgConnection): {
    command: string;
    args: string[];
    env: Record<string, string>;
  } {
    // `--format=custom` (compressed): compression must happen **before**
    // encryption, because encrypted bytes no longer compress. Plain SQL would
    // make the file several times bigger, and the copy to the external drive
    // that much slower.
    //
    // `host` is a separate parameter because, from inside Docker, the DB is
    // always the container's own localhost; the outside hostname (compose's
    // `postgres`) may mean nothing there.
    const dumpArgs = (host: string): string[] => [
      '-h', host,
      '-p', conn.port,
      '-U', conn.user,
      '-d', conn.database,
      '--format=custom',
      '--no-owner',
      '--no-privileges',
    ];

    if (this.dockerContainer) {
      return {
        command: this.dockerBin,
        args: [
          'exec',
          /**
           * `-e PGPASSWORD`: **only the name, not the value.** `docker exec`
           * picks the rest up from its own process env and passes it into the
           * container (that is what `env` below sets), just like `docker run`.
           *
           * Writing `PGPASSWORD=<value>` would put the database password in the
           * `docker` process's argv, and **any** user running `ps aux` on the
           * host could read it, at 02:30, every day. argv is readable by
           * everyone, env is not; the difference is not cosmetic. (The risk is
           * not imaginary: members of the docker group or monitoring agents list
           * processes.)
           */
          '-e',
          'PGPASSWORD',
          this.dockerContainer,
          'pg_dump',
          ...dumpArgs(this.dockerDbHost),
        ],
        env: { PGPASSWORD: conn.password },
      };
    }

    return {
      command: this.pgDumpBin,
      args: dumpArgs(conn.host),
      // PGPASSWORD in the env, not on the command line, so `ps` cannot show the password
      env: { PGPASSWORD: conn.password },
    };
  }

  /** The default ENOENT message ("spawn pg_dump ENOENT") explains nothing */
  private spawnHint(command: string, err: unknown): string {
    const message = err instanceof Error ? err.message : 'unknown error';
    if (!message.includes('ENOENT')) return message;

    return this.dockerContainer
      ? `Could not run \`${command}\` (${message}) — is BACKUP_DOCKER_BIN correct? ` +
          `Container name: ${this.dockerContainer}`
      : `\`${command}\` was not found on PATH (${message}) — ` +
          'install the PostgreSQL client tools and give the full path in BACKUP_PG_DUMP, ' +
          'or set BACKUP_DOCKER_CONTAINER if Postgres runs in Docker.';
  }

  private connection(): PgConnection | null {
    return parsePgUrl(this.databaseUrl);
  }

  // ── K03 · external drive ───────────────────────────────────────────────────

  /**
   * After the copy, **the hash is checked again**.
   *
   * A half-written file on a USB drive, a full drive or a pulled cable can all
   * make `copyFile()` look successful or leave an almost-successful file.
   * Without verifying, the belief "there is an offsite copy" would be false, and
   * the falsehood would be found on restore day. The read is slow, but this is
   * a 3 AM job, and this check is the copy's only value.
   */
  private async copyOut(fileName: string): Promise<BackupCopyResult> {
    if (!this.copyTo) {
      return { configured: false, ok: false, error: null, target: null };
    }

    const target = resolve(this.copyTo);
    const source = join(this.dir, fileName);

    try {
      // A drive that is **absent** and a drive that is **empty** are different
      // things. Forcing it with `mkdir` can make Windows sometimes create the
      // path even when the drive is not attached (on the system disk!), and
      // then "copied" would show, while the copy sat on that same disk, so no
      // protection at all.
      const dirInfo = await stat(target).catch(() => null);
      if (!dirInfo?.isDirectory()) {
        throw new Error(
          `${target} was not found — is the external drive attached?`,
        );
      }

      await copyFile(source, join(target, fileName));
      await copyFile(source + SHA_EXT, join(target, fileName + SHA_EXT));

      const expected = await readDigest(source + SHA_EXT);
      const actual = await sha256File(join(target, fileName));
      if (expected !== actual) {
        throw new Error('sha256 of the copied file does not match — the copy is corrupt');
      }

      this.logger.log(`Backup copied: ${join(target, fileName)}`);
      return { configured: true, ok: true, error: null, target };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`Backup copy failed (${target}): ${error}`);
      return { configured: true, ok: false, error, target };
    }
  }

  // ── rotation ───────────────────────────────────────────────────────────────

  /** Both folders, otherwise the external drive would silently fill up */
  private async rotate(now: Date): Promise<number> {
    const dirs = [this.dir, ...(this.copyTo ? [resolve(this.copyTo)] : [])];
    let removed = 0;

    for (const dir of dirs) {
      try {
        removed += await this.rotateOne(dir, now);
      } catch (err) {
        // Failing to rotate does not fail the backup: the backup has already happened
        this.logger.warn(
          `Could not rotate ${dir}: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    }
    return removed;
  }

  private async rotateOne(dir: string, now: Date): Promise<number> {
    const names = await readdir(dir);

    const parts: { name: string; mtime: Date }[] = [];
    for (const name of names) {
      if (!isPartFile(name)) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      if (info) parts.push({ name, mtime: info.mtime });
    }

    const doomed = [
      ...backupsToDelete(names, now, this.keepDays),
      ...stalePartFiles(parts, now),
    ];

    for (const name of doomed) {
      // Last guard: check once more that the name really fits our pattern. This
      // loop is the only place where the code **deletes** files on its own.
      if (!isBackupFile(name) && !isPartFile(name)) continue;
      await quietUnlink(join(dir, name), join(dir, name + SHA_EXT));
    }

    // Sidecars whose backup no longer exists. Checked after the loop above so that
    // the sidecars of the files just deleted (if they survived) are caught too.
    const orphans = orphanSidecars(await readdir(dir));
    for (const name of orphans) await quietUnlink(join(dir, name));

    if (doomed.length > 0) {
      this.logger.log(`${dir}: removed ${doomed.length} old backups`);
    }
    return doomed.length;
  }

  /**
   * The restore instructions are kept **right beside** the backups.
   *
   * On the day of a disaster what remains is an external drive: no server, no
   * repo, no documentation. If that drive holds only a pile of `.enc` files and
   * nobody knows how to open them, then encryption did not save the backup, it
   * killed it.
   */
  private async writeRestoreNote(): Promise<void> {
    const note = [
      'oXeio — restoring a backup',
      '='.repeat(48),
      '',
      'These files are encrypted with AES-256-CBC, in the `openssl enc` format.',
      "Passphrase = BACKUP_PASSPHRASE from the server's .env (deliberately not written here).",
      '',
      '1. Verify the hash (is the file intact?):',
      '   sha256sum -c oxeio-YYYY-MM-DD-HHMM.dump.enc.sha256',
      '',
      '2. Decrypt:',
      '   export BACKUP_PASSPHRASE=...',
      `   openssl enc -d -aes-256-cbc -pbkdf2 -iter ${PBKDF2_ITERATIONS} -md sha256 \\`,
      '     -in oxeio-YYYY-MM-DD-HHMM.dump.enc -out oxeio.dump \\',
      '     -pass env:BACKUP_PASSPHRASE',
      '',
      '3. Restore (pg_dump --format=custom, so use pg_restore):',
      '   pg_restore -h localhost -U oxeio -d oxeio --clean --if-exists oxeio.dump',
      '',
      'The screenshot files are not in this dump — they live in the storage/ folder',
      'and are copied separately (07 § 6.4, the 3 AM robocopy).',
      '',
    ].join('\n');

    for (const dir of [this.dir, ...(this.copyTo ? [resolve(this.copyTo)] : [])]) {
      try {
        await writeFile(join(dir, 'README-restore.txt'), note, 'utf8');
      } catch {
        // Failing to write the instructions does not fail the backup
      }
    }
  }
}

function emptyResult(skipped: BackupResult['skipped']): BackupResult {
  return {
    ok: false,
    skipped,
    fileName: null,
    sizeBytes: null,
    durationMs: 0,
    error: null,
    copy: { configured: false, ok: false, error: null, target: null },
    rotated: 0,
  };
}

async function quietUnlink(...paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await unlink(path);
    } catch {
      // It was not there, or it is locked; nothing to do either way
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** The first word of the sidecar is the hex digest (`sha256sum` format) */
async function readDigest(shaPath: string): Promise<string> {
  const text = await readFile(shaPath, 'utf8');
  return text.trim().split(/\s+/)[0] ?? '';
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
}

// kept importable from here (tests, older imports)
export { parseBackupMode, type BackupMode } from './backup-mode';
