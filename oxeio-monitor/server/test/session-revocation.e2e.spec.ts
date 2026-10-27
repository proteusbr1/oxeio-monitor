import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SessionsService } from '../src/auth/sessions.service';
import {
  createEmployeeWithCode,
  createHarness,
  hashPassword,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  readCookie,
  realNow,
  resetDatabase,
  type Harness,
  type Session,
  uniqueSuffix,
} from './setup/harness';

/**
 * **M3 — the gaps in ending a session.**
 *
 *  (a) An owner resetting someone's password left that person's sessions
 *      running; so did a role change and a dismissal, until the next refresh.
 *  (b) `is_active`, the role and `sessions_revoked_at` were read only at the
 *      5-minute sliding refresh, so every cut took up to five minutes.
 *  (c) Logout only cleared the cookie: a copied token stayed valid, and the
 *      sliding refresh kept it alive indefinitely.
 *
 * Careful: the tokens here are signed by hand with an `iat` one minute back,
 * **inside** the 5-minute refresh window, so the guard does not re-issue them.
 * That is the window the old code never looked at. (A token issued in the
 * very second of a cut is not older than the cut, by design: see
 * `SessionsService.revokeAll`.)
 */
let h: Harness;
let owner: Session;

const PASSWORD = 'revocation-password-123';
/** `@EveryRole()`: any signed-in account gets a 200 */
const ANY_ROLE = '/api/v1/auth/me';

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

async function cookieFor(
  user: { id: number; email: string; role: string; employeeId: number | null },
  sessionId: string = randomUUID(),
): Promise<string> {
  const key = new TextEncoder().encode(process.env.JWT_SECRET ?? '');
  const minuteAgo = Math.floor(realNow().getTime() / 1000) - 60;

  const token = await new SignJWT({
    email: user.email,
    role: user.role,
    employeeId: user.employeeId,
    mustChangePw: false,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setJti(sessionId)
    .setIssuedAt(minuteAgo)
    .setExpirationTime(minuteAgo + 30 * 60)
    .sign(key);

  return `oxeio_session=${token}`;
}

async function staff(role: 'employee' | 'manager' = 'employee') {
  const code = `RV-${uniqueSuffix()}`.slice(0, 12);
  const { employeeId } = await createEmployeeWithCode(h.prisma, code);
  const user = await h.prisma.user.create({
    data: {
      email: `${code.toLowerCase()}@test.local`,
      passwordHash: await hashPassword(PASSWORD),
      fullName: 'Revocation Person',
      role,
      employeeId,
      mustChangePw: false,
    },
  });
  return { employeeId, user };
}

describe('(a) owner actions end the other person\'s sessions at once', () => {
  it('reset password', async () => {
    const { user } = await staff();
    const cookie = await cookieFor(user);
    await h.http().get(ANY_ROLE).set('Cookie', cookie).expect(200);

    await owner.http
      .post(`/api/v1/users/${user.id}/reset-password`)
      .set('X-CSRF-Token', owner.csrf)
      .send({})
      .expect(200);

    await h.http().get(ANY_ROLE).set('Cookie', cookie).expect(401);
  });

  it('change role', async () => {
    const { user } = await staff('manager');
    const cookie = await cookieFor(user);
    await h.http().get(ANY_ROLE).set('Cookie', cookie).expect(200);

    await owner.http
      .patch(`/api/v1/users/${user.id}/role`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ role: 'employee' })
      .expect(200);

    await h.http().get(ANY_ROLE).set('Cookie', cookie).expect(401);
  });

  it('deactivate, and a reactivation does not revive the old token', async () => {
    const { employeeId, user } = await staff();
    const cookie = await cookieFor(user);
    await h.http().get(ANY_ROLE).set('Cookie', cookie).expect(200);

    await owner.http
      .post(`/api/v1/employees/${employeeId}/deactivate`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ reason: 'revocation test' })
      .expect(200);
    await h.http().get(ANY_ROLE).set('Cookie', cookie).expect(401);

    await owner.http
      .post(`/api/v1/employees/${employeeId}/reactivate`)
      .set('X-CSRF-Token', owner.csrf)
      .expect(200);
    await h.http().get(ANY_ROLE).set('Cookie', cookie).expect(401);
  });
});

describe('(b) the account is checked on every request', () => {
  /**
   * "Sign out other devices" used to reach the other tab only at its next
   * refresh, up to five minutes later.
   */
  it('sign out other devices reaches a fresh token immediately', async () => {
    const { user } = await staff();
    const other = await cookieFor(user);
    await h.http().get(ANY_ROLE).set('Cookie', other).expect(200);

    const me = await loginReady(h, user.email, PASSWORD);
    await me.http
      .post('/api/v1/account/sign-out-others')
      .set('X-CSRF-Token', me.csrf)
      .expect(204);

    await h.http().get(ANY_ROLE).set('Cookie', other).expect(401);
    // the device that asked stays signed in
    await me.http.get(ANY_ROLE).expect(200);
  });

  /**
   * An edit from outside the server (a script, hand-run SQL) has no one to
   * clear the cache; it shows once the few-second cache entry is dropped.
   */
  it('an outside edit applies once the cached entry is gone', async () => {
    const { user } = await staff();
    const cookie = await cookieFor(user);
    await h.http().get(ANY_ROLE).set('Cookie', cookie).expect(200);

    await h.prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    h.app.get(SessionsService).invalidate(user.id); // stands in for the 5 s expiry

    await h.http().get(ANY_ROLE).set('Cookie', cookie).expect(401);
  });
});

describe('(c) logout ends that session, and only that one', () => {
  it('a copied token stops working after logout; another device stays signed in', async () => {
    const { user } = await staff();

    const first = await h
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);
    const setCookies = first.headers['set-cookie'] as unknown as string[];
    const copied = `oxeio_session=${readCookie(setCookies, 'oxeio_session')}`;
    const csrf = readCookie(setCookies, 'oxeio_csrf')!;

    const laptop = await loginReady(h, user.email, PASSWORD);

    await h
      .http()
      .post('/api/v1/auth/logout')
      .set('Cookie', `${copied}; oxeio_csrf=${csrf}`)
      .set('X-CSRF-Token', csrf)
      .expect(204);

    await h.http().get(ANY_ROLE).set('Cookie', copied).expect(401);
    await laptop.http.get(ANY_ROLE).expect(200);
  });

  it('the sliding refresh keeps the session id, so logout still ends a refreshed token', async () => {
    const { user } = await staff();
    const sessionId = randomUUID();
    const cookie = await cookieFor(user, sessionId);

    await h.app.get(SessionsService).end(sessionId);

    await h.http().get(ANY_ROLE).set('Cookie', cookie).expect(401);
    // written through, so a restart does not bring it back
    expect(await h.prisma.revokedSession.count({ where: { sessionId } })).toBe(1);
  });

  it('a token from before session ids existed still works (it simply expires)', async () => {
    const { user } = await staff();
    const key = new TextEncoder().encode(process.env.JWT_SECRET ?? '');
    const now = Math.floor(realNow().getTime() / 1000);
    const legacy = await new SignJWT({
      email: user.email,
      role: user.role,
      employeeId: user.employeeId,
      mustChangePw: false,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(user.id))
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 29 * 60)
      .sign(key);

    await h.http().get(ANY_ROLE).set('Cookie', `oxeio_session=${legacy}`).expect(200);
  });
});
