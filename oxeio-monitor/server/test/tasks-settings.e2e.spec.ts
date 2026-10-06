import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FEATURES_SETTING_KEY } from '../src/features/features.rules';
import { FeaturesService } from '../src/features/features.service';
import { TASKS_SETTING_KEY } from '../src/tasks/tasks-settings.rules';
import {
  createEmployeeWithCode,
  createHarness,
  hashPassword,
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
 * Settings → Tasks (`GET/PATCH /api/v1/settings/tasks`): the apps whose
 * window titles are read for a leading task number (start detection).
 *
 * Owner only, and 404 while the Tasks module is off. An empty list — the
 * default — means detection is off. `active` says whether titles are really
 * being read right now: apps listed AND Apps & websites on.
 */
let h: Harness;
let owner: Session;

const URL = '/api/v1/settings/tasks';
const PASSWORD = 'settings-test-password-123';

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

const save = (session: Session, body: Record<string, unknown>) =>
  session.http.patch(URL).set('X-CSRF-Token', session.csrf).send(body);

/** Writes the module switches row directly and drops the cached copy */
async function features(value: Prisma.InputJsonObject): Promise<void> {
  await h.prisma.setting.upsert({
    where: { key: FEATURES_SETTING_KEY },
    update: { value },
    create: { key: FEATURES_SETTING_KEY, value },
  });
  h.app.get(FeaturesService).forget();
}

/** A signed-in portal account with this role */
async function sessionAs(role: 'coordinator' | 'employee', code: string): Promise<Session> {
  const { employeeId } = await createEmployeeWithCode(h.prisma, code);
  const email = `${code.toLowerCase()}@test.local`;
  await h.prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      fullName: `Test ${role}`,
      role,
      employeeId: role === 'employee' ? employeeId : null,
      mustChangePw: false,
    },
  });
  return loginReady(h, email, PASSWORD);
}

const savedRow = async () =>
  (await h.prisma.setting.findUnique({ where: { key: TASKS_SETTING_KEY } }))?.value ?? null;

describe('reading', () => {
  it('a new install: no apps, detection inactive', async () => {
    const res = await owner.http.get(URL).expect(200);

    expect(res.body).toEqual({ startDetection: { apps: [] }, active: false });
  });

  it('a saved list comes back as saved', async () => {
    await h.prisma.setting.create({
      data: { key: TASKS_SETTING_KEY, value: { startDetection: { apps: ['Excel.exe'] } } },
    });

    const res = await owner.http.get(URL).expect(200);

    expect(res.body).toEqual({ startDetection: { apps: ['Excel.exe'] }, active: true });
  });
});

describe('who can do what', () => {
  it('a manager gets 403 on read and on save', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await manager.http.get(URL).expect(403);
    await save(manager, { startDetection: { apps: ['Excel.exe'] } }).expect(403);
  });

  it('a coordinator gets 403 on read and on save', async () => {
    const coordinator = await sessionAs('coordinator', 'OX-CO1');

    await coordinator.http.get(URL).expect(403);
    await save(coordinator, { startDetection: { apps: ['Excel.exe'] } }).expect(403);
  });

  it('an employee gets 403 on read and on save', async () => {
    const employee = await sessionAs('employee', 'OX-EM1');

    await employee.http.get(URL).expect(403);
    await save(employee, { startDetection: { apps: ['Excel.exe'] } }).expect(403);
  });

  it('nothing is saved by a refused request', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await save(manager, { startDetection: { apps: ['Excel.exe'] } }).expect(403);

    expect(await savedRow()).toBeNull();
  });
});

describe('the Tasks module off', () => {
  it('`tasks: false` → 404 on read and on save', async () => {
    await features({ tasks: false });

    await owner.http.get(URL).expect(404);
    await save(owner, { startDetection: { apps: ['Excel.exe'] } }).expect(404);
    expect(await savedRow()).toBeNull();
  });

  /** A row saved before the module was renamed still switches it off */
  it('the legacy key alone (`designTargets: false`) → 404 too', async () => {
    await features({ designTargets: false });

    await owner.http.get(URL).expect(404);
    await save(owner, { startDetection: { apps: ['Excel.exe'] } }).expect(404);
  });

  /** The new key wins over the legacy one when both are present */
  it('`tasks: true` beside a legacy `designTargets: false` → the module is on', async () => {
    await features({ tasks: true, designTargets: false });

    await owner.http.get(URL).expect(200);
  });
});

describe('saving', () => {
  it('apps are trimmed and repeats dropped case-insensitively (the first one typed wins)', async () => {
    const res = await save(owner, {
      startDetection: { apps: ['  Excel.exe ', 'WINWORD.EXE', 'excel.EXE', 'winword.exe'] },
    }).expect(200);

    expect(res.body).toEqual({
      startDetection: { apps: ['Excel.exe', 'WINWORD.EXE'] },
      active: true,
    });
    expect(await savedRow()).toEqual({
      startDetection: { apps: ['Excel.exe', 'WINWORD.EXE'] },
    });

    const read = await owner.http.get(URL).expect(200);
    expect(read.body.startDetection.apps).toEqual(['Excel.exe', 'WINWORD.EXE']);
  });

  it('an empty list switches detection off', async () => {
    await save(owner, { startDetection: { apps: ['Excel.exe'] } }).expect(200);

    const res = await save(owner, { startDetection: { apps: [] } }).expect(200);

    expect(res.body).toEqual({ startDetection: { apps: [] }, active: false });
    expect(await savedRow()).toEqual({ startDetection: { apps: [] } });
  });

  /**
   * Apps & websites is where window titles come from: with it off, the list
   * is kept but nothing is read, and the response says so.
   */
  it('Apps & websites off: the list is saved, but `active` is false', async () => {
    await features({ appTracking: false });

    const res = await save(owner, { startDetection: { apps: ['Excel.exe'] } }).expect(200);

    expect(res.body).toEqual({ startDetection: { apps: ['Excel.exe'] }, active: false });
    expect(await savedRow()).toEqual({ startDetection: { apps: ['Excel.exe'] } });
  });

  it.each([
    ['a Windows path', 'C:\\Program Files\\Office\\EXCEL.EXE'],
    ['a forward slash', 'office/excel.exe'],
    ['a quote', '"Excel.exe"'],
  ])('a name with %s → 400, and nothing is saved', async (_label, app) => {
    await save(owner, { startDetection: { apps: ['WINWORD.EXE', app] } }).expect(400);

    expect(await savedRow()).toBeNull();
  });

  it('a list that is not a list of strings → 400', async () => {
    await save(owner, { startDetection: { apps: 'Excel.exe' } }).expect(400);
    await save(owner, { startDetection: { apps: [42] } }).expect(400);
  });

  /** A body without `startDetection` leaves the saved list alone */
  it('an empty body changes nothing', async () => {
    await save(owner, { startDetection: { apps: ['Excel.exe'] } }).expect(200);

    const res = await save(owner, {}).expect(200);

    expect(res.body.startDetection.apps).toEqual(['Excel.exe']);
  });
});

describe('audit', () => {
  it('a change writes one change_setting row naming the tasks setting', async () => {
    await save(owner, { startDetection: { apps: ['Excel.exe'] } }).expect(200);

    const rows = await h.prisma.auditLog.findMany({ where: { action: 'change_setting' } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetType: 'setting',
      targetId: 'tasks',
      meta: { op: 'tasks', startDetectionApps: { from: [], to: ['Excel.exe'] } },
    });
  });

  /** Saving the same list again is not a change, so history stays clean */
  it('saving the same list again writes nothing', async () => {
    await save(owner, { startDetection: { apps: ['Excel.exe'] } }).expect(200);
    await save(owner, { startDetection: { apps: [' Excel.exe'] } }).expect(200);

    expect(
      await h.prisma.auditLog.count({ where: { action: 'change_setting', targetId: 'tasks' } }),
    ).toBe(1);
  });
});
