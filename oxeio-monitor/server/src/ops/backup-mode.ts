export type BackupMode = 'internal' | 'external';

/**
 * `BACKUP_MODE` — `internal` (default: oXeio's own nightly, encrypted
 * pg_dump) or `external` (the database is backed up by something else).
 *
 * ⚠️ `external` is a statement, not an absence. Without a passphrase the
 *    internal backup does not run and that is reported loudly on purpose
 *    (G39: a missing backup nobody hears about is worse than a noisy
 *    alert). `external` is how an owner who backs up elsewhere says so —
 *    and only then does the alarm go quiet.
 * ⚠️ Anything else stops the server: a typo must not switch the alarm off.
 */
export function parseBackupMode(raw: string | undefined): BackupMode {
  const mode = (raw ?? '').trim().toLowerCase();
  if (mode === '' || mode === 'internal') return 'internal';
  if (mode === 'external') return 'external';
  throw new Error(`BACKUP_MODE="${raw}" — use "internal" (default) or "external"`);
}
