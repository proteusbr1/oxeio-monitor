import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import { FEATURES_SETTING_KEY } from '../src/features/features.rules';
import { FeaturesService } from '../src/features/features.service';
import { PrivacyService } from '../src/privacy/privacy.service';
import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  realNow,
  todayWindow,
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
 * Module switches: payroll, security deposits, screenshots, apps & websites
 * and tasks can be switched off by the owner. Off = the endpoints
 * answer 404 (and the capture modules stop the agents); nothing is deleted,
 * and an install that never touches the switches behaves as before.
 *
 * A setting inside a module (who sees screenshots, how long they are kept)
 * is not a switch: it lives on Settings → Privacy, tested at the end.
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
  // the migration seeds this row; the truncate in resetDatabase takes it away
  await h.prisma.depositPolicy.create({
    data: {
      id: 1,
      amountMinor: 50_000,
      startYearMonth: '2026-01',
      noticeDays: 30,
      active: false,
      updatedBy: 'test',
    },
  });
});

const save = (body: Record<string, unknown>) =>
  owner.http
    .patch('/api/v1/settings/features')
    .set('X-CSRF-Token', owner.csrf)
    .send(body);

describe('defaults', () => {
  it('every module is on until the owner says otherwise', async () => {
    const res = await owner.http.get('/api/v1/features').expect(200);

    expect(res.body).toEqual({
      payroll: true,
      deposits: true,
      screenshots: true,
      appTracking: true,
      tasks: true,
      hoursStatement: true,
    });
  });

  it('the endpoints answer as they always did', async () => {
    await owner.http.get('/api/v1/payroll?month=2026-08').expect(200);
    await owner.http.get('/api/v1/deposits').expect(200);
    await owner.http.get('/api/v1/tasks').expect(200);
  });

  it('the settings view says what each module holds', async () => {
    const res = await owner.http.get('/api/v1/settings/features').expect(200);

    expect(res.body.features.payroll).toBe(true);
    expect(res.body.usage).toEqual({
      paidStaff: expect.any(Number),
      depositMonths: 0,
      hasScreenshots: false,
      hasAppUsage: false,
      tasks: 0,
      taskReceivers: expect.any(Number),
    });
  });
});

describe('who can do what', () => {
  it('a manager reads the switches (the sidebar needs them) but cannot change them', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await manager.http.get('/api/v1/features').expect(200);
    await manager.http.get('/api/v1/settings/features').expect(403);
    await manager.http
      .patch('/api/v1/settings/features')
      .set('X-CSRF-Token', manager.csrf)
      .send({ payroll: false })
      .expect(403);
  });

  it('signed out gets 401, not a hint about which modules exist', async () => {
    await save({ payroll: false }).expect(200);

    await request(h.app.getHttpServer()).get('/api/v1/payroll').expect(401);
    await request(h.app.getHttpServer()).get('/api/v1/features').expect(401);
  });

  it('only booleans are accepted', async () => {
    await save({ payroll: 'no' }).expect(400);
  });
});

describe('switching off', () => {
  it('payroll off → /payroll is 404, the other modules carry on', async () => {
    const res = await save({ payroll: false }).expect(200);
    expect(res.body.features).toMatchObject({ payroll: false, deposits: true });
    // deposits live inside payroll: the switch is kept, but it is off for now
    expect(res.body.effective).toMatchObject({ payroll: false, deposits: false });

    const blocked = await owner.http
      .get('/api/v1/payroll?month=2026-08')
      .expect(404);
    expect(blocked.body.message).toMatch(/Settings → Modules/);

    await owner.http.get('/api/v1/deposits').expect(404);
    await owner.http.get('/api/v1/tasks').expect(200);
  });

  it('deposits off → the owner screen and the employee card are both 404', async () => {
    await save({ deposits: false }).expect(200);

    await owner.http.get('/api/v1/deposits').expect(404);
    await owner.http.get('/api/v1/me/deposit').expect(404);
  });

  it('tasks off → the pool, the own list and Settings → Tasks are all 404', async () => {
    await save({ tasks: false }).expect(200);

    await owner.http.get('/api/v1/tasks').expect(404);
    await owner.http.get('/api/v1/me/tasks').expect(404);
    await owner.http.get('/api/v1/settings/tasks').expect(404);
  });

  /** A row saved before the rename only knows the old key */
  it('a saved row with only the old `designTargets` key still switches tasks off', async () => {
    await h.prisma.setting.create({
      data: { key: FEATURES_SETTING_KEY, value: { designTargets: false } },
    });
    h.app.get(FeaturesService).forget();

    const res = await owner.http.get('/api/v1/features').expect(200);
    expect(res.body.tasks).toBe(false);
    await owner.http.get('/api/v1/tasks').expect(404);

    // saving writes the new key; the old one is kept but no longer decides
    await save({ tasks: true }).expect(200);
    await owner.http.get('/api/v1/tasks').expect(200);
  });

  it('turning it back on brings the module back', async () => {
    await save({ payroll: false }).expect(200);
    await owner.http.get('/api/v1/payroll?month=2026-08').expect(404);

    await save({ payroll: true }).expect(200);
    await owner.http.get('/api/v1/payroll?month=2026-08').expect(200);
  });

  it('a partial save leaves the other switches as they were', async () => {
    await save({ deposits: false }).expect(200);
    const res = await save({ tasks: false }).expect(200);

    expect(res.body.features).toEqual({
      payroll: true,
      deposits: false,
      screenshots: true,
      appTracking: true,
      tasks: false,
      hoursStatement: true,
    });
  });
});

describe('audit', () => {
  it('records what moved, and a save that changes nothing records nothing', async () => {
    await save({ payroll: false, deposits: true }).expect(200);
    await save({ payroll: false }).expect(200);

    const rows = await h.prisma.auditLog.findMany({
      where: { targetId: FEATURES_SETTING_KEY },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('change_setting');
    expect(rows[0].meta).toEqual({ op: 'features', payroll: false });
  });
});

describe('capture modules — the agents stop collecting', () => {
  const agentConfig = async (token: string) =>
    (
      await h
        .http()
        .get('/api/v1/agent/config')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Client-Time', realNow().toISOString())
        .expect(200)
    ).body.config;

  it('screenshots off → no pictures in the agent config, the gallery is 404, /auth/me hides it', async () => {
    const { code } = await createEmployeeWithCode(h.prisma);
    const device = await enrollDevice(h, code);
    expect((await agentConfig(device.token)).screenshot.enabled).toBe(true);
    expect((await owner.http.get('/api/v1/auth/me').expect(200)).body.canSeeScreenshots).toBe(true);

    await save({ screenshots: false }).expect(200);

    expect((await agentConfig(device.token)).screenshot.enabled).toBe(false);
    await owner.http.get('/api/v1/screenshots').expect(404);
    await owner.http.get('/api/v1/screenshots/latest').expect(404);
    expect((await owner.http.get('/api/v1/auth/me').expect(200)).body.canSeeScreenshots).toBe(false);
  });

  it('apps & websites off → no app tracking, usage sent anyway is dropped, tasks carry on', async () => {
    const { code } = await createEmployeeWithCode(h.prisma);
    const device = await enrollDevice(h, code);

    const res = await save({ appTracking: false }).expect(200);
    // tasks have no parent: only their start detection goes inactive
    expect(res.body.features.tasks).toBe(true);
    expect(res.body.effective.tasks).toBe(true);

    expect((await agentConfig(device.token)).appTracking.enabled).toBe(false);
    await owner.http.get('/api/v1/categories').expect(404);
    await owner.http.get('/api/v1/activity/top').expect(404);
    await owner.http.get('/api/v1/tasks').expect(200);

    const used = todayWindow(600);
    const sent = await h
      .http()
      .post('/api/v1/agent/app-usage')
      .set('Authorization', `Bearer ${device.token}`)
      .set('X-Client-Time', realNow().toISOString())
      .send({
        items: [
          {
            clientUuid: randomUUID(),
            startedAt: used.startedAt.toISOString(),
            endedAt: used.endedAt.toISOString(),
            durationSec: used.durationSec,
            processName: 'chrome.exe',
            appName: 'Google Chrome',
            windowTitle: 'GitHub',
            domain: 'github.com',
            isBrowser: true,
          },
        ],
      })
      .expect(200);
    expect(sent.body.accepted).toBe(0);
    expect(await h.prisma.appUsage.count()).toBe(0);
  });
});

describe('Settings → Privacy (a setting inside Screenshots, not a module)', () => {
  const savePrivacy = (body: Record<string, unknown>) =>
    owner.http.patch('/api/v1/settings/privacy').set('X-CSRF-Token', owner.csrf).send(body);

  it('defaults, and the old "screenshots for staff" switch carries over', async () => {
    let res = await owner.http.get('/api/v1/settings/privacy').expect(200);
    expect(res.body.settings).toEqual({ staffSeeOwnScreenshots: true, screenshotRetentionDays: 90 });

    await h.prisma.setting.create({ data: { key: FEATURES_SETTING_KEY, value: { staffScreenshots: false } } });
    h.app.get(PrivacyService).forget();
    res = await owner.http.get('/api/v1/settings/privacy').expect(200);
    expect(res.body.settings.staffSeeOwnScreenshots).toBe(false);
  });

  it('saves, audits and validates', async () => {
    const res = await savePrivacy({ staffSeeOwnScreenshots: false, screenshotRetentionDays: 30 }).expect(200);
    expect(res.body.settings).toEqual({ staffSeeOwnScreenshots: false, screenshotRetentionDays: 30 });
    await savePrivacy({ screenshotRetentionDays: 3 }).expect(400);

    const rows = await h.prisma.auditLog.findMany({ where: { targetId: 'privacy' } });
    expect(rows).toHaveLength(1);
  });

  it('is 404 while the Screenshots module is off, and owner-only', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/settings/privacy').expect(403);
    await save({ screenshots: false }).expect(200);
    await owner.http.get('/api/v1/settings/privacy').expect(404);
  });
});
