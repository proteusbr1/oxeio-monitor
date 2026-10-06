import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BackupCheck } from '../src/alerts/backup.check';
import { BackupService } from '../src/ops/backup.service';
import {
  createHarness,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/**
 * Settings → Region, Storage & backup, Agent updates, and the holiday import
 * — what used to need the server's .env, now on screen.
 */
let h: Harness;
let owner: Session;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

const patch = (s: Session, path: string, body: object) =>
  s.http.patch(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);
const post = (s: Session, path: string, body: object) =>
  s.http.post(`/api/v1${path}`).set('X-CSRF-Token', s.csrf).send(body);

describe('Settings → Region', () => {
  it('defaults are what the server always had', async () => {
    const res = await owner.http.get('/api/v1/settings/region').expect(200);
    expect(res.body.currency).toMatchObject({ code: 'BDT', source: 'default' });
    expect(res.body.restartNeeded).toBe(false);
  });

  it('currency and format saved on screen reach the dashboard at once', async () => {
    await patch(owner, '/settings/region', {
      currency: 'BRL',
      displayLocale: 'pt-BR',
    }).expect(200);

    const currency = await h.http().get('/api/v1/auth/currency').expect(200);
    expect(currency.body).toEqual({ code: 'BRL', symbol: 'R$' });
    const locale = await h
      .http()
      .get('/api/v1/auth/display-locale')
      .expect(200);
    expect(locale.body).toEqual({ locale: 'pt-BR' });
  });

  it('a new time zone waits for a restart, and says so', async () => {
    const res = await patch(owner, '/settings/region', {
      timeZone: 'America/Sao_Paulo',
    }).expect(200);
    expect(res.body.timeZone).toEqual({
      value: 'America/Sao_Paulo',
      source: 'dashboard',
    });
    expect(res.body.runningTimeZone).toBe('Asia/Dhaka');
    expect(res.body.restartNeeded).toBe(true);
    // still the running zone until then
    const tz = await h.http().get('/api/v1/auth/time-zone').expect(200);
    expect(tz.body.timeZone).toBe('Asia/Dhaka');
  });

  it('takes a zone with daylight saving time, and refuses an unknown one', async () => {
    await patch(owner, '/settings/region', { timeZone: 'Europe/London' }).expect(200);
    const res = await patch(owner, '/settings/region', {
      timeZone: 'Mars/Base',
    }).expect(400);
    expect(String(res.body.message)).toMatch(/IANA/);
  });

  it("is the owner's alone", async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/settings/region').expect(403);
  });
});

describe('Settings → Storage & backup', () => {
  it('database backup by another tool, chosen on screen', async () => {
    await patch(owner, '/settings/backup', { mode: 'external' }).expect(200);
    const health = await owner.http.get('/api/v1/ops/health').expect(200);
    expect(health.body.backup.mode).toBe('external');
  });

  /**
   * The open "BACKUP_PASSPHRASE is not set" alert closes the moment the
   * mode is saved — not at the hourly check, which every restart pushes back.
   */
  it('switching to external closes the old backup alert at once', async () => {
    const stale = () =>
      h.prisma.alert.create({
        data: {
          type: 'backup_failed',
          severity: 'critical',
          title: 'Backup is not running — BACKUP_PASSPHRASE is not set',
          detail: 'No passphrase',
          channelsSent: [],
        },
      });

    // still internal: no passphrase in tests, so the boot log says so
    const boot = h.app.get(BackupService);
    expect((await boot.bootWarnings()).errors.join(' ')).toMatch(
      /BACKUP_PASSPHRASE/,
    );

    // and the method the server runs at boot leaves the alert alone
    const first = await stale();
    expect(await h.app.get(BackupCheck).closeIfExternal()).toBe(false);
    expect(
      (await h.prisma.alert.findUniqueOrThrow({ where: { id: first.id } }))
        .resolvedAt,
    ).toBeNull();

    await patch(owner, '/settings/backup', { mode: 'external' }).expect(200);
    const closed = await h.prisma.alert.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(closed.resolvedAt).not.toBeNull();
    expect(closed.resolvedReason).toMatch(/external/);

    // from then on the boot log is quiet about backups
    expect(await boot.bootWarnings()).toEqual({ errors: [], warnings: [] });

    // and a leftover alert is closed at boot too
    const second = await stale();
    expect(await h.app.get(BackupCheck).closeIfExternal()).toBe(true);
    expect(
      (await h.prisma.alert.findUniqueOrThrow({ where: { id: second.id } }))
        .resolvedAt,
    ).not.toBeNull();
  });

  it('screenshots on this disk by default; a bucket without a key is refused', async () => {
    const res = await owner.http.get('/api/v1/settings/storage').expect(200);
    expect(res.body).toMatchObject({ driver: 'local', restartNeeded: false });

    const bad = await patch(owner, '/settings/storage', {
      driver: 's3',
      provider: 's3',
      bucket: 'x',
    }).expect(400);
    expect(String(bad.body.message)).toMatch(/key/i);
  });
});

describe('Settings → Agent updates › signing key', () => {
  it('refuses something that is not a public key', async () => {
    await patch(owner, '/settings/update-key', {
      publicKey: 'not a key',
    }).expect(400);
  });
});

describe('Holiday import from a file', () => {
  const csv = (rows: string[]) => ['date,name,type', ...rows].join('\n');

  it('preview first, then import — past months left out, existing ones untouched', async () => {
    await h.prisma.holiday.create({
      data: { holidayDate: new Date('2099-01-01T00:00:00Z'), name: 'Kept' },
    });
    const content = csv([
      '2099-01-01,New Year,public',
      '2099-04-21,Tiradentes,public',
      '2000-05-01,Labour day,public',
      'oops',
    ]);

    const preview = await post(owner, '/holidays/import', {
      fileName: 'br.csv',
      content,
    }).expect(200);
    expect(preview.body.add.map((h: { date: string }) => h.date)).toEqual([
      '2099-04-21',
    ]);
    expect(preview.body.existing[0]).toMatchObject({
      date: '2099-01-01',
      nameInDb: 'Kept',
    });
    expect(
      preview.body.pastMonths.map((h: { date: string }) => h.date),
    ).toEqual(['2000-05-01']);
    expect(preview.body.problems).toHaveLength(1);
    expect(preview.body.created).toBe(0);
    expect(await h.prisma.holiday.count()).toBe(1);

    const done = await post(owner, '/holidays/import', {
      fileName: 'br.csv',
      content,
      dryRun: false,
    }).expect(200);
    expect(done.body.created).toBe(1);
    const names = (
      await h.prisma.holiday.findMany({ orderBy: { holidayDate: 'asc' } })
    ).map((r) => r.name);
    expect(names).toEqual(['Kept', 'Tiradentes']);
  });

  it('past months only when ticked', async () => {
    const content = csv(['2000-05-01,Labour day,public']);
    const res = await post(owner, '/holidays/import', {
      fileName: 'x.csv',
      content,
      dryRun: false,
      allowPast: true,
    }).expect(200);
    expect(res.body.created).toBe(1);
  });
});
