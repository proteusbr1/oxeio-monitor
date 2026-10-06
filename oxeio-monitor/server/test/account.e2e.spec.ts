import { UserRole } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mergePreferences, preferencesOf } from '../src/auth/preferences';
import {
  createHarness,
  hashPassword,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  realNow,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * The Account page: each person's own profile, look, activity and devices.
 * There is no id in any `/account` route — every test acts on the session.
 */
let h: Harness;

const STAFF_EMAIL = 'staff@test.local';
const STAFF_PASSWORD = 'staff-password-123';

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  const policy = await h.prisma.workPolicy.findFirstOrThrow();
  const employee = await h.prisma.employee.create({
    data: { empCode: 'OX-001', fullName: 'Ana Souza', designation: 'Designer', policyId: policy.id },
  });
  await h.prisma.user.create({
    data: {
      email: STAFF_EMAIL,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      fullName: 'Ana Souza',
      role: UserRole.employee,
      employeeId: employee.id,
      mustChangePw: false,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('preferencesOf / mergePreferences', () => {
  it('keeps only known keys and values', () => {
    expect(preferencesOf({ theme: 'dark', nope: 1 })).toEqual({ theme: 'dark' });
    expect(preferencesOf({ theme: 'purple' })).toEqual({});
    expect(preferencesOf(null)).toEqual({});
    expect(preferencesOf([1])).toEqual({});
  });

  it('null clears a choice, undefined leaves it', () => {
    expect(mergePreferences({ theme: 'dark' }, { theme: null })).toEqual({});
    expect(mergePreferences({ theme: 'dark' }, {})).toEqual({ theme: 'dark' });
    expect(mergePreferences({}, { theme: 'light' })).toEqual({ theme: 'light' });
  });
});

describe('GET/PATCH /account', () => {
  it('the owner sees and renames their own account', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const before = await s.http.get('/api/v1/account').expect(200);
    expect(before.body).toMatchObject({ email: OWNER_EMAIL, role: 'owner', nameFromStaffRecord: false, staff: null });

    const res = await s.http
      .patch('/api/v1/account')
      .set('X-CSRF-Token', s.csrf)
      .send({ fullName: '  Maria Lima ' })
      .expect(200);
    expect(res.body.fullName).toBe('Maria Lima');

    const me = await s.http.get('/api/v1/auth/me').expect(200);
    expect(me.body.fullName).toBe('Maria Lima');
  });

  it('staff take their name from the staff record and cannot rename themselves', async () => {
    const s = await loginReady(h, STAFF_EMAIL, STAFF_PASSWORD);
    const view = await s.http.get('/api/v1/account').expect(200);
    expect(view.body).toMatchObject({ nameFromStaffRecord: true, staff: { empCode: 'OX-001', designation: 'Designer' } });

    await s.http
      .patch('/api/v1/account')
      .set('X-CSRF-Token', s.csrf)
      .send({ fullName: 'Someone Else' })
      .expect(400);
  });

  it('the theme is saved on the account and comes back on /auth/me', async () => {
    const s = await loginReady(h, STAFF_EMAIL, STAFF_PASSWORD);
    await s.http.patch('/api/v1/account').set('X-CSRF-Token', s.csrf).send({ theme: 'light' }).expect(200);
    expect((await s.http.get('/api/v1/auth/me').expect(200)).body.preferences).toEqual({ theme: 'light' });

    await s.http.patch('/api/v1/account').set('X-CSRF-Token', s.csrf).send({ theme: null }).expect(200);
    expect((await s.http.get('/api/v1/auth/me').expect(200)).body.preferences).toEqual({});

    await s.http.patch('/api/v1/account').set('X-CSRF-Token', s.csrf).send({ theme: 'purple' }).expect(400);
  });
});

describe('GET /account/activity', () => {
  it('shows own sign-ins and failed attempts, not other people\'s', async () => {
    // a wrong password for staff, then a good sign-in; the owner signs in too
    await h.http().post('/api/v1/auth/login').send({ email: STAFF_EMAIL, password: 'wrong-password-1' }).expect(401);
    const s = await loginReady(h, STAFF_EMAIL, STAFF_PASSWORD);
    await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

    const res = await s.http.get('/api/v1/account/activity').expect(200);
    const actions = res.body.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['login', 'login_failed']);
  });

  it('includes the owner resetting this person\'s password', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const staff = await h.prisma.user.findUniqueOrThrow({ where: { email: STAFF_EMAIL } });
    const reset = await owner.http
      .post(`/api/v1/users/${staff.id}/reset-password`)
      .set('X-CSRF-Token', owner.csrf)
      .send({});
    expect(reset.status).toBeLessThan(300);

    const s = await loginReady(h, STAFF_EMAIL, reset.body.tempPassword as string);
    const res = await s.http.get('/api/v1/account/activity').expect(200);
    const rows = res.body.map((e: { action: string; byOther: boolean }) => [e.action, e.byOther]);
    expect(rows).toContainEqual(['login', false]);
    expect(rows.at(-1)).toEqual(['reset_password', true]);
  });
});

describe('POST /account/sign-out-others', () => {
  it('ends the other device at its next refresh; this one stays', async () => {
    const start = realNow().getTime();
    vi.useFakeTimers({ toFake: ['Date'], now: start });

    const laptop = await loginReady(h, STAFF_EMAIL, STAFF_PASSWORD);
    const phone = await loginReady(h, STAFF_EMAIL, STAFF_PASSWORD);

    // six minutes on: both tokens are past the refresh age
    vi.setSystemTime(start + 6 * 60_000);
    await phone.http.post('/api/v1/account/sign-out-others').set('X-CSRF-Token', phone.csrf).expect(204);

    await phone.http.get('/api/v1/account').expect(200);
    await laptop.http.get('/api/v1/account').expect(401);

    const events = await h.prisma.auditLog.findMany({ where: { action: 'sign_out_other_sessions' } });
    expect(events).toHaveLength(1);
  });

  it('a new password also ends the other sessions', async () => {
    const start = realNow().getTime();
    vi.useFakeTimers({ toFake: ['Date'], now: start });

    const laptop = await loginReady(h, STAFF_EMAIL, STAFF_PASSWORD);
    const phone = await loginReady(h, STAFF_EMAIL, STAFF_PASSWORD);

    vi.setSystemTime(start + 6 * 60_000);
    await phone.http
      .post('/api/v1/auth/change-password')
      .set('X-CSRF-Token', phone.csrf)
      .send({ currentPassword: STAFF_PASSWORD, newPassword: 'a-brand-new-password' })
      .expect(204);

    await phone.http.get('/api/v1/auth/me').expect(200);
    await laptop.http.get('/api/v1/auth/me').expect(401);
  });
});
