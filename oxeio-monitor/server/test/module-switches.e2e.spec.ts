import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FEATURES_SETTING_KEY } from '../src/features/features.rules';
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
 * Module switches: payroll, security deposits and design targets can be
 * hidden by the owner. Off = the endpoints answer 404; nothing is deleted,
 * and an install that never touches the switches behaves as before.
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
      amountPaisa: 50_000,
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
      designTargets: true,
    });
  });

  it('the endpoints answer as they always did', async () => {
    await owner.http.get('/api/v1/payroll?month=2026-08').expect(200);
    await owner.http.get('/api/v1/deposits').expect(200);
    await owner.http.get('/api/v1/design-targets').expect(200);
  });

  it('the settings view says what each module holds', async () => {
    const res = await owner.http.get('/api/v1/settings/features').expect(200);

    expect(res.body.features.payroll).toBe(true);
    expect(res.body.usage).toEqual({
      salariedStaff: expect.any(Number),
      depositMonths: 0,
      designTargets: 0,
      designers: expect.any(Number),
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
    expect(res.body.features).toEqual({
      payroll: false,
      deposits: true,
      designTargets: true,
    });

    const blocked = await owner.http
      .get('/api/v1/payroll?month=2026-08')
      .expect(404);
    expect(blocked.body.message).toMatch(/Settings → Modules/);

    await owner.http.get('/api/v1/deposits').expect(200);
    await owner.http.get('/api/v1/design-targets').expect(200);
  });

  it('deposits off → the owner screen and the employee card are both 404', async () => {
    await save({ deposits: false }).expect(200);

    await owner.http.get('/api/v1/deposits').expect(404);
    await owner.http.get('/api/v1/me/deposit').expect(404);
  });

  it('design targets off → the pool and the designer list are both 404', async () => {
    await save({ designTargets: false }).expect(200);

    await owner.http.get('/api/v1/design-targets').expect(404);
    await owner.http.get('/api/v1/me/targets').expect(404);
  });

  it('turning it back on brings the module back', async () => {
    await save({ payroll: false }).expect(200);
    await owner.http.get('/api/v1/payroll?month=2026-08').expect(404);

    await save({ payroll: true }).expect(200);
    await owner.http.get('/api/v1/payroll?month=2026-08').expect(200);
  });

  it('a partial save leaves the other switches as they were', async () => {
    await save({ deposits: false }).expect(200);
    const res = await save({ designTargets: false }).expect(200);

    expect(res.body.features).toEqual({
      payroll: true,
      deposits: false,
      designTargets: false,
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
