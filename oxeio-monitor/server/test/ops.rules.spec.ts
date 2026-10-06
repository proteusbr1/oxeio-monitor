import { describe, expect, it } from 'vitest';

import {
  BACKUP_CRITICAL_DAYS,
  BACKUP_KEEP_MIN,
  BACKUP_STALE_HOURS,
} from '../src/ops/ops.constants';
import {
  backupAlertText,
  backupFileName,
  backupVerdict,
  backupsToDelete,
  healthVerdict,
  isBackupFile,
  isPartFile,
  listBackups,
  orphanSidecars,
  parseBackupName,
  parsePgUrl,
  safeHostname,
  stalePartFiles,
  telegramLine,
  telegramMessage,
  type BackupState,
  type HealthFacts,
} from '../src/ops/ops.rules';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A fixed moment in the test work zone: UTC+6, no DST */
function work(iso: string): Date {
  return new Date(`${iso}+06:00`);
}

/** Name of the 02:30 nightly backup from n days before `now` */
function nightlyName(now: Date, daysAgo: number): string {
  return backupFileName(new Date(now.getTime() - daysAgo * DAY));
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Names: the rotation rule stands on these
// ════════════════════════════════════════════════════════════════════════════

describe('backup names', () => {
  it('the date is in work-zone time, not UTC', () => {
    // 20:30 on the 10th in UTC = 02:30 on the 11th in the work zone (UTC+6)
    expect(backupFileName(new Date('2026-08-10T20:30:00Z'))).toBe(
      'oxeio-2026-08-11-0230.dump.enc',
    );
  });

  it('two runs on the same day get different names (hour and minute included)', () => {
    const a = backupFileName(work('2026-08-11T02:30:00'));
    const b = backupFileName(work('2026-08-11T14:05:00'));
    expect(a).not.toBe(b);
  });

  it('name -> time -> name round-trips to the same value', () => {
    const at = work('2026-08-11T02:30:00');
    const name = backupFileName(at);
    expect(parseBackupName(name)?.getTime()).toBe(at.getTime());
  });

  it('no other file is ever counted as a backup', () => {
    for (const name of [
      'README-restore.txt',
      'oxeio-2026-08-11-0230.dump.enc.sha256',
      'before-migration.dump',
      'oxeio-2026-08-11.dump.enc',
      'oxeio-2026-08-11-0230.dump',
      'notes.txt',
      '',
    ]) {
      expect(isBackupFile(name), name).toBe(false);
    }
  });

  it('an impossible date (month 13) is rejected even if it passes the regex', () => {
    expect(parseBackupName('oxeio-2026-13-45-0230.dump.enc')).toBeNull();
  });

  it('.part files are recognised and are not backups', () => {
    const part = 'oxeio-2026-08-11-0230.dump.enc.part';
    expect(isPartFile(part)).toBe(true);
    expect(isBackupFile(part)).toBe(false);
  });

  it('the list is ordered newest to oldest', () => {
    const now = work('2026-08-11T02:30:00');
    const names = [nightlyName(now, 5), nightlyName(now, 0), nightlyName(now, 2)];
    expect(listBackups(names).map((f) => f.name)).toEqual([
      nightlyName(now, 0),
      nightlyName(now, 2),
      nightlyName(now, 5),
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Rotation: if this is wrong, the last good copy could be deleted
// ════════════════════════════════════════════════════════════════════════════

describe('rotating old backups', () => {
  const now = work('2026-08-11T03:00:00');

  it('those older than 30 days go, newer ones stay', () => {
    const names = [0, 5, 29, 31, 60].map((d) => nightlyName(now, d));
    expect(backupsToDelete(names, now, 30)).toEqual([
      nightlyName(now, 31),
      nightlyName(now, 60),
    ]);
  });

  it('even if all are old, the two newest are never deleted', () => {
    // backups have failed for 40 days; a plain age rule would empty the disk here
    const names = [40, 50, 60, 70].map((d) => nightlyName(now, d));
    const doomed = backupsToDelete(names, now, 30);

    expect(doomed).toEqual([nightlyName(now, 60), nightlyName(now, 70)]);
    expect(doomed).toHaveLength(names.length - BACKUP_KEEP_MIN);
  });

  it('files that are not recognised are never touched', () => {
    const names = [
      'README-restore.txt',
      'before-migration.dump',
      nightlyName(now, 90),
      nightlyName(now, 91),
      nightlyName(now, 92),
    ];
    expect(backupsToDelete(names, now, 30)).toEqual([nightlyName(now, 92)]);
  });

  it('future dates (if the clock went backwards) are protected', () => {
    const names = [
      backupFileName(new Date(now.getTime() + 2 * DAY)),
      nightlyName(now, 40),
      nightlyName(now, 41),
    ];
    // the future one + the 40-day one = the two keepMin, the other one goes
    expect(backupsToDelete(names, now, 30)).toEqual([nightlyName(now, 41)]);
  });

  it('deletes nothing when there is nothing', () => {
    expect(backupsToDelete([], now, 30)).toEqual([]);
  });

  it('an orphan .sha256 goes, but not one somebody kept on purpose', () => {
    const live = nightlyName(now, 1);
    const gone = nightlyName(now, 40);
    const half = nightlyName(now, 0);

    expect(
      orphanSidecars([
        live,
        live + '.sha256', // the backup exists: stays
        gone + '.sha256', // no backup: orphan
        half + '.sha256', // the backup is still being written (.part): stays
        half + '.part',
        'notes.sha256', // not ours: left alone
      ]),
    ).toEqual([gone + '.sha256']);
  });

  it('a running .part file is not deleted, only abandoned ones', () => {
    const running = {
      name: 'oxeio-2026-08-11-0230.dump.enc.part',
      mtime: new Date(now.getTime() - 60_000),
    };
    const abandoned = {
      name: 'oxeio-2026-08-01-0230.dump.enc.part',
      mtime: new Date(now.getTime() - 20 * HOUR),
    };
    const notOurs = {
      name: 'something.part',
      mtime: new Date(now.getTime() - 20 * HOUR),
    };

    expect(stalePartFiles([running, abandoned, notOurs], now)).toEqual([
      abandoned.name,
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. When to speak up and when to stay quiet
// ════════════════════════════════════════════════════════════════════════════

const okState = (now: Date): BackupState => ({
  configured: true,
  lastAttemptAt: new Date(now.getTime() - HOUR),
  lastOutcome: 'ok',
  lastSuccessAt: new Date(now.getTime() - HOUR),
  consecutiveFailures: 0,
  lastCopyOutcome: 'ok',
  observedSince: new Date(now.getTime() - 30 * DAY),
});

describe('backup alerts', () => {
  const now = work('2026-08-11T09:00:00');

  it('says nothing on success', () => {
    expect(backupVerdict(okState(now), now)).toBeNull();
  });

  it('BACKUP_PASSPHRASE missing is the state that deserves the loudest alert', () => {
    const verdict = backupVerdict({ ...okState(now), configured: false }, now);
    expect(verdict?.problem).toBe('not_configured');
    expect(backupAlertText(verdict!).title).toContain('BACKUP_PASSPHRASE');
  });

  it('one night of failure = warning', () => {
    const verdict = backupVerdict(
      {
        ...okState(now),
        lastOutcome: 'failed',
        consecutiveFailures: 1,
        lastSuccessAt: new Date(now.getTime() - 30 * HOUR),
      },
      now,
    );
    expect(verdict?.problem).toBe('failed');
    expect(verdict?.severity).toBe('warning');
  });

  it(`${BACKUP_CRITICAL_DAYS} failed days in a row = critical`, () => {
    const verdict = backupVerdict(
      {
        ...okState(now),
        lastOutcome: 'failed',
        consecutiveFailures: BACKUP_CRITICAL_DAYS,
        lastSuccessAt: new Date(now.getTime() - 2 * DAY - HOUR),
      },
      now,
    );
    expect(verdict?.severity).toBe('critical');
    expect(verdict?.daysSinceSuccess).toBe(2);
  });

  it('last attempt succeeded but long ago: the job is no longer running', () => {
    const verdict = backupVerdict(
      {
        ...okState(now),
        lastAttemptAt: new Date(now.getTime() - 40 * HOUR),
        lastSuccessAt: new Date(now.getTime() - 40 * HOUR),
      },
      now,
    );
    expect(verdict?.problem).toBe('stale');
  });

  it(`a successful backup within ${BACKUP_STALE_HOURS} hours is not stale`, () => {
    const fresh = new Date(now.getTime() - (BACKUP_STALE_HOURS - 1) * HOUR);
    expect(
      backupVerdict({ ...okState(now), lastAttemptAt: fresh, lastSuccessAt: fresh }, now),
    ).toBeNull();
  });

  it('a freshly started server does not shout in its first minute', () => {
    const fresh: BackupState = {
      configured: true,
      lastAttemptAt: null,
      lastOutcome: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      lastCopyOutcome: null,
      observedSince: new Date(now.getTime() - 10 * 60_000),
    };
    expect(backupVerdict(fresh, now)).toBeNull();
  });

  it('but if two days pass with no backup at all, it is critical', () => {
    const never: BackupState = {
      configured: true,
      lastAttemptAt: null,
      lastOutcome: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      lastCopyOutcome: null,
      observedSince: new Date(now.getTime() - 3 * DAY),
    };
    const verdict = backupVerdict(never, now);
    expect(verdict?.problem).toBe('never');
    expect(verdict?.severity).toBe('critical');
  });

  it('the dump is fine but did not reach the external drive: also a failure', () => {
    const verdict = backupVerdict(
      { ...okState(now), lastCopyOutcome: 'failed' },
      now,
    );
    expect(verdict?.problem).toBe('copy_failed');
    expect(verdict?.severity).toBe('warning');
  });

  it('if the copy is not configured at all (null), that is not a failure', () => {
    expect(
      backupVerdict({ ...okState(now), lastCopyOutcome: null }, now),
    ).toBeNull();
  });

  it('every problem has a title', () => {
    const problems = [
      'not_configured',
      'failed',
      'never',
      'stale',
      'copy_failed',
    ] as const;

    for (const problem of problems) {
      const text = backupAlertText({
        problem,
        severity: 'warning',
        hoursSinceSuccess: 30,
        daysSinceSuccess: 1,
      });
      expect(text.title.length, problem).toBeGreaterThan(0);
      expect(text.detail.length, problem).toBeGreaterThan(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Health verdict
// ════════════════════════════════════════════════════════════════════════════

const healthy: HealthFacts = {
  dbUp: true,
  diskUsedPct: 42,
  backup: null,
  activeDevices: 15,
  silentDevices: 0,
  pendingAlerts: 0,
};

describe('health verdict', () => {
  it('everything fine gives ok with no problems', () => {
    expect(healthVerdict(healthy)).toEqual({ status: 'ok', problems: [] });
  });

  it('DB down gives down, and nothing else needs saying', () => {
    const verdict = healthVerdict({ ...healthy, dbUp: false, diskUsedPct: 99 });
    expect(verdict.status).toBe('down');
    expect(verdict.problems).toHaveLength(1);
  });

  it('health stays green even when all PCs are off at night', () => {
    const evening = { ...healthy, silentDevices: 15, activeDevices: 15 };
    expect(healthVerdict(evening).status).toBe('ok');
  });

  it('disk over 80% gives degraded', () => {
    expect(healthVerdict({ ...healthy, diskUsedPct: 83 }).status).toBe('degraded');
  });

  it('being unable to read disk info is also a problem', () => {
    const verdict = healthVerdict({ ...healthy, diskUsedPct: null });
    expect(verdict.status).toBe('degraded');
    expect(verdict.problems[0]).toMatch(/disk/i);
  });

  it('when there is a backup verdict, health shows it too', () => {
    const verdict = healthVerdict({
      ...healthy,
      backup: {
        problem: 'stale',
        severity: 'critical',
        hoursSinceSuccess: 70,
        daysSinceSuccess: 2,
      },
    });
    expect(verdict.status).toBe('degraded');
    expect(verdict.problems.join(' ')).toContain('Backup');
  });

  it('a pile-up of alerts means the dispatcher is stuck', () => {
    expect(healthVerdict({ ...healthy, pendingAlerts: 500 }).status).toBe(
      'degraded',
    );
  });
  it('a screenshot bucket that cannot be reached is a problem', () => {
    const verdict = healthVerdict({
      ...healthy,
      screenshotStore: { location: 's3://shots/', reachable: false },
    });
    expect(verdict.status).toBe('degraded');
    expect(verdict.problems[0]).toMatch(/s3:\/\/shots/);
  });

  it('a reachable bucket changes nothing', () => {
    expect(
      healthVerdict({
        ...healthy,
        screenshotStore: { location: 's3://shots/', reachable: true },
      }),
    ).toEqual({ status: 'ok', problems: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. What goes to Telegram (and what does not)
// ════════════════════════════════════════════════════════════════════════════

describe('Telegram message', () => {
  const now = work('2026-08-11T10:20:00');

  it('type label, hostname and how long ago: nothing more', () => {
    const line = telegramLine(
      {
        type: 'agent_down',
        severity: 'warning',
        hostname: 'PC-07',
        createdAt: new Date(now.getTime() - 20 * 60_000),
      },
      now,
    );
    expect(line).toContain('Agent silent');
    expect(line).toContain('PC-07');
    expect(line).toContain('20 min ago');
  });

  it('there is no way to send an employee name, a domain or a money amount', () => {
    // the input does not even accept title/detail: an allowlist, not a denylist
    const message = telegramMessage(
      [
        {
          type: 'no_activity_today',
          severity: 'warning',
          hostname: null,
          createdAt: now,
        },
      ],
      now,
    );
    expect(message).not.toContain('facebook');
    expect(message).not.toContain('$');
    expect(message).toContain('no work all day');
  });

  it('odd characters in the hostname are filtered out', () => {
    expect(safeHostname('PC-07')).toBe('PC-07');
    expect(safeHostname('<b>山田</b>-PC')).toBe('bb-PC');
    expect(safeHostname('   ')).toBeNull();
    expect(safeHostname(null)).toBeNull();
    expect(safeHostname('x'.repeat(80))).toHaveLength(32);
  });

  it('does not break on an unknown type', () => {
    const line = telegramLine(
      { type: 'something-else', severity: 'info', createdAt: now },
      now,
    );
    expect(line).toContain('Alert');
  });

  it('with several alerts: a count in the header, then one per line', () => {
    const message = telegramMessage(
      [
        { type: 'agent_down', severity: 'warning', hostname: 'PC-01', createdAt: now },
        { type: 'disk_critical', severity: 'critical', createdAt: now },
      ],
      now,
    );
    expect(message).toContain('2 alerts');
    expect(message.split('\n').filter((l) => l.startsWith('🔴') || l.startsWith('🟡'))).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. DATABASE_URL: the pg_dump arguments
// ════════════════════════════════════════════════════════════════════════════

describe('parsing DATABASE_URL', () => {
  it('a plain URL', () => {
    expect(parsePgUrl('postgresql://oxeio:secret@db.local:5433/oxeio?schema=public')).toEqual({
      host: 'db.local',
      port: '5433',
      user: 'oxeio',
      password: 'secret',
      database: 'oxeio',
    });
  });

  it('a percent-encoded password is decoded, otherwise auth would fail every day', () => {
    expect(parsePgUrl('postgres://us%40er:p%40ss%3Aword@localhost/oxeio')).toMatchObject({
      user: 'us@er',
      password: 'p@ss:word',
    });
  });

  it('port 5432 when no port is given', () => {
    expect(parsePgUrl('postgres://u:p@localhost/oxeio')?.port).toBe('5432');
  });

  it('null for junk or a URL with another scheme', () => {
    expect(parsePgUrl('mysql://u:p@localhost/x')).toBeNull();
    expect(parsePgUrl('not-a-URL-at-all')).toBeNull();
    expect(parsePgUrl('postgres://u:p@localhost/')).toBeNull();
    expect(parsePgUrl(undefined)).toBeNull();
  });
});
