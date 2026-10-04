import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { parseBackupMode } from '../src/ops/backup.service';
import type { Harness, Session } from './setup/harness';

/**
 * BACKUP_MODE=external — the database is backed up by another tool
 * (Databasus, a managed Postgres, …), so oXeio's own nightly backup, its
 * alert and its health check step aside.
 *
 * Without it nothing changes: no passphrase still means a loud
 * "backup not configured" (G39) — that path keeps its own tests.
 */
describe('parseBackupMode', () => {
  it('unset or internal → internal, as before', () => {
    expect(parseBackupMode(undefined)).toBe('internal');
    expect(parseBackupMode(' ')).toBe('internal');
    expect(parseBackupMode('Internal')).toBe('internal');
  });

  it('external', () => {
    expect(parseBackupMode('EXTERNAL')).toBe('external');
  });

  it('a typo stops the server — it must never switch the alarm off', () => {
    expect(() => parseBackupMode('externl')).toThrow(/BACKUP_MODE/);
    expect(() => parseBackupMode('off')).toThrow(/BACKUP_MODE/);
  });
});

describe('BACKUP_MODE=external, whole app', () => {
  let h: Harness;
  let harness: typeof import('./setup/harness');
  let owner: Session;

  beforeAll(async () => {
    vi.stubEnv('BACKUP_MODE', 'external');
    vi.stubEnv('BACKUP_PASSPHRASE', '');
    vi.resetModules();
    harness = await import('./setup/harness');
    h = await harness.createHarness();
  });

  afterAll(async () => {
    await h?.close();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  beforeEach(async () => {
    await harness.resetDatabase(h.prisma, h.app);
    owner = await harness.loginReady(
      h,
      harness.OWNER_EMAIL,
      harness.OWNER_PASSWORD,
    );
  });

  it('health reports external, and no backup problem', async () => {
    const res = await owner.http.get('/api/v1/ops/health').expect(200);
    expect(res.body.backup.mode).toBe('external');
    expect(res.body.backup.problem).toBeNull();
    expect(res.body.problems.join(' ')).not.toMatch(/backup/i);
  });

  it('closes a "backup not configured" alert left from before the switch', async () => {
    await h.prisma.alert.create({
      data: {
        type: 'backup_failed',
        severity: 'critical',
        title: 'Backup is not configured',
        detail: 'No BACKUP_PASSPHRASE',
        channelsSent: [],
      },
    });

    const { BackupCheck } = await import('../src/alerts/backup.check');
    expect(await h.app.get(BackupCheck).runOnce()).toBe(0);

    const [alert] = await h.prisma.alert.findMany({
      where: { type: 'backup_failed' },
    });
    expect(alert.resolvedAt).not.toBeNull();
    expect(alert.resolvedReason).toMatch(/BACKUP_MODE=external/);
  });

  /** no passphrase here, yet nothing to warn about: backups happen elsewhere */
  it('the boot log has no backup warnings', async () => {
    const { BackupService } = await import('../src/ops/backup.service');
    expect(await h.app.get(BackupService).bootWarnings()).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('a manual run says external instead of trying', async () => {
    const res = await owner.http
      .post('/api/v1/ops/backup/run')
      .set('X-CSRF-Token', owner.csrf);
    expect(res.body.skipped).toBe('external');
  });
});
