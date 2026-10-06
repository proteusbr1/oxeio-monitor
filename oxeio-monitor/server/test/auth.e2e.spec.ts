import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  login,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  uniqueSuffix,
} from './setup/harness';
import { resolveThrottle } from '../src/auth/login-throttle.config';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

describe('public routes', () => {
  it('health opens without login', async () => {
    const res = await h.http().get('/api/v1/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('up');
  });
});

describe('protected routes without login', () => {
  it('GET /auth/time-zone is public and gives the running zone', async () => {
    const res = await h.http().get('/api/v1/auth/time-zone').expect(200);
    // the suite runs on Etc/GMT-6 (vitest.config.ts)
    expect(res.body).toEqual({ timeZone: 'Etc/GMT-6', utcOffsetMinutes: 360 });
  });

  it('GET /auth/currency is public and defaults to USD', async () => {
    const res = await h.http().get('/api/v1/auth/currency').expect(200);
    expect(res.body).toEqual({ code: 'USD', symbol: '$' });
  });

  it('GET /auth/display-locale is public and empty by default', async () => {
    const res = await h.http().get('/api/v1/auth/display-locale').expect(200);
    expect(res.body).toEqual({ locale: null });
  });

  it('GET /auth/me → 401', async () => {
    await h.http().get('/api/v1/auth/me').expect(401);
  });

  // The guard order is JWT then CSRF, so this should be 401, not 403
  it('POST reset-password gives 401, not the CSRF 403', async () => {
    await h.http().post('/api/v1/users/1/reset-password').expect(401);
  });
});

describe('login', () => {
  it('wrong password gives 401', async () => {
    await h
      .http()
      .post('/api/v1/auth/login')
      .send({ email: OWNER_EMAIL, password: 'totally-wrong' })
      .expect(401);
  });

  it('an unknown email gets the same message, to prevent user enumeration', async () => {
    const unknown = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'whatever' })
      .expect(401);

    const wrongPw = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ email: OWNER_EMAIL, password: 'totally-wrong' })
      .expect(401);

    expect(unknown.body.message).toBe(wrongPw.body.message);
  });

  it('a correct password sets cookies, and the session cookie is httpOnly', async () => {
    const res = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD })
      .expect(200);

    expect(res.body.mustChangePassword).toBe(true);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('oxeio_session='));
    const csrf = cookies.find((c) => c.startsWith('oxeio_csrf='));

    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Strict/i);
    // The frontend has to read the CSRF token, so this must not be httpOnly
    expect(csrf).toBeDefined();
    expect(csrf).not.toMatch(/HttpOnly/i);
  });
});

describe('while mustChangePw is set', () => {
  it('/auth/me stays open but everything else is 403', async () => {
    const s = await login(h, OWNER_EMAIL, OWNER_PASSWORD);

    const me = await s.http.get('/api/v1/auth/me').expect(200);
    expect(me.body.mustChangePassword).toBe(true);

    const blocked = await s.http
      .post('/api/v1/users/1/reset-password')
      .set('X-CSRF-Token', s.csrf)
      .expect(403);
    expect(blocked.body.mustChangePassword).toBe(true);
  });
});

describe('CSRF', () => {
  it('403 without the header', async () => {
    const s = await login(h, OWNER_EMAIL, OWNER_PASSWORD);
    await s.http
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: OWNER_PASSWORD, newPassword: 'brand-new-pass-1' })
      .expect(403);
  });

  it('403 with a wrong token', async () => {
    const s = await login(h, OWNER_EMAIL, OWNER_PASSWORD);
    await s.http
      .post('/api/v1/auth/change-password')
      .set('X-CSRF-Token', 'bogus')
      .send({ currentPassword: OWNER_PASSWORD, newPassword: 'brand-new-pass-1' })
      .expect(403);
  });
});

describe('password change', () => {
  it('400 if shorter than 10 characters', async () => {
    const s = await login(h, OWNER_EMAIL, OWNER_PASSWORD);
    await s.http
      .post('/api/v1/auth/change-password')
      .set('X-CSRF-Token', s.csrf)
      .send({ currentPassword: OWNER_PASSWORD, newPassword: 'short' })
      .expect(400);
  });

  it('401 if the current password is wrong', async () => {
    const s = await login(h, OWNER_EMAIL, OWNER_PASSWORD);
    await s.http
      .post('/api/v1/auth/change-password')
      .set('X-CSRF-Token', s.csrf)
      .send({ currentPassword: 'nope-nope', newPassword: 'brand-new-pass-1' })
      .expect(401);
  });

  it('400 if the same as the previous one', async () => {
    const s = await login(h, OWNER_EMAIL, OWNER_PASSWORD);
    await s.http
      .post('/api/v1/auth/change-password')
      .set('X-CSRF-Token', s.csrf)
      .send({ currentPassword: OWNER_PASSWORD, newPassword: OWNER_PASSWORD })
      .expect(400);
  });

  it('after a successful change, mustChangePassword becomes false', async () => {
    const s = await login(h, OWNER_EMAIL, OWNER_PASSWORD);
    const res = await s.http
      .post('/api/v1/auth/change-password')
      .set('X-CSRF-Token', s.csrf)
      .send({ currentPassword: OWNER_PASSWORD, newPassword: 'brand-new-pass-1' })
      .expect(204);

    // The cookie is issued anew, otherwise the token would keep the old mustChangePw
    expect(res.headers['set-cookie']).toBeDefined();

    const me = await s.http.get('/api/v1/auth/me').expect(200);
    expect(me.body.mustChangePassword).toBe(false);
  });
});

describe('role guard', () => {
  it('the owner reaches owner-only routes', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    // The staff member does not exist, i.e. we got past the guard to the service
    await s.http
      .post('/api/v1/employees/999/portal-account')
      .set('X-CSRF-Token', s.csrf)
      .send({ email: 'nobody@test.local' })
      .expect(404);
  });

  it('a manager gets 403 on owner-only routes', async () => {
    const s = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await s.http
      .post('/api/v1/users/1/reset-password')
      .set('X-CSRF-Token', s.csrf)
      .expect(403);
  });
});

describe('owner password reset (G33)', () => {
  /**
   * Careful: reset no longer forces a mandatory change (ADR-033). The owner
   * said twice he did not want that wall, and the second time he got stuck
   * on it himself: pressing Reset with the password field empty. A random
   * password is still issued; the person is just not told to change it.
   */
  it('issues a temporary password but does not ask to change it', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const manager = await h.prisma.user.findFirstOrThrow({
      where: { email: MANAGER_EMAIL },
    });

    const res = await s.http
      .post(`/api/v1/users/${manager.id}/reset-password`)
      .set('X-CSRF-Token', s.csrf)
      .expect(200);

    expect(res.body.tempPassword).toBeTruthy();

    const after = await h.prisma.user.findFirstOrThrow({
      where: { id: manager.id },
    });
    expect(after.mustChangePw).toBe(false);

    // The new password really works
    await h
      .http()
      .post('/api/v1/auth/login')
      .send({ email: MANAGER_EMAIL, password: res.body.tempPassword })
      .expect(200);
  });

  it('is recorded in audit_log', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const manager = await h.prisma.user.findFirstOrThrow({
      where: { email: MANAGER_EMAIL },
    });

    await s.http
      .post(`/api/v1/users/${manager.id}/reset-password`)
      .set('X-CSRF-Token', s.csrf)
      .expect(200);

    const entries = await h.prisma.auditLog.findMany({
      where: { action: 'reset_password' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].targetId).toBe(String(manager.id));
  });
});

describe('staff self-view account', () => {
  it('opening an owner account gives role = employee', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    const employee = await h.prisma.employee.create({
      data: { empCode: 'OX-009', fullName: 'Test Staff', policyId: policy.id },
    });

    const res = await s.http
      .post(`/api/v1/employees/${employee.id}/portal-account`)
      .set('X-CSRF-Token', s.csrf)
      .send({ email: 'staff@test.local' })
      .expect(201);

    expect(res.body.tempPassword).toBeTruthy();

    const created = await h.prisma.user.findFirstOrThrow({
      where: { email: 'staff@test.local' },
    });
    expect(created.role).toBe('employee');
    expect(created.employeeId).toBe(employee.id);
    // Not even on a new account: ADR-033
    expect(created.mustChangePw).toBe(false);
  });
});

describe('logout', () => {
  it('the cookie is cleared, and the next request gets 401', async () => {
    const s = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    await s.http
      .post('/api/v1/auth/logout')
      .set('X-CSRF-Token', s.csrf)
      .expect(204);
    await s.http.get('/api/v1/auth/me').expect(401);
  });
});

describe('brute force (I11)', () => {
  /**
   * Careful: the number is no longer hard-coded; it is now a `.env` setting
   * (`LOGIN_MAX_FAILS`). The test used to have "5" in it, so it broke the
   * moment the default was softened, though the behaviour was right. The test
   * should guard the rule, not one particular number.
   */
  const { maxFails, enabled } = resolveThrottle({
    maxFails: process.env.LOGIN_MAX_FAILS,
    lockMinutes: process.env.LOGIN_LOCK_MINUTES,
  });

  it.skipIf(!enabled)('429 once the limit is passed', async () => {
    const email = `attacker-${uniqueSuffix()}@test.local`;
    const codes: number[] = [];

    // Everything up to the limit is 401, the next is 429
    for (let i = 0; i <= maxFails; i++) {
      const res = await h
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: `guess-${i}` });
      codes.push(res.status);
    }

    expect(codes.slice(0, maxFails)).toEqual(Array(maxFails).fill(401));
    expect(codes[maxFails]).toBe(429);
  });

  it('the real account stays open even after an attack', async () => {
    const email = `attacker2-${uniqueSuffix()}@test.local`;
    for (let i = 0; i <= maxFails; i++) {
      await h.http().post('/api/v1/auth/login').send({ email, password: 'x' });
    }

    await h
      .http()
      .post('/api/v1/auth/login')
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD })
      .expect(200);
  });
});
