import { SignJWT } from 'jose';
// vitest's `expect` is not needed here: every check in this file uses
// supertest's chained `.expect(200)`, which is a different thing. Importing
// it left lint red (`no-unused-vars`), and CI too.
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

import {
  createEmployeeWithCode,
  createHarness,
  hashPassword,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
  uniqueSuffix,
  realNow,
} from './setup/harness';

/**
 * Does a running session honour changes in the database?
 *
 * This file comes from a real gap. `JwtAuthGuard` has a sliding window: every
 * 5 minutes the token is reissued, so someone who keeps working is not
 * suddenly logged out. But the new token was built by copying the old token's
 * claims:
 *
 * ```ts
 * await this.tokens.issue(res, user);   // <- `user` from the old token
 * ```
 *
 * So for someone who kept a tab open and kept working, their role was never
 * updated:
 *
 *   - a manager demoted to staff stayed a manager forever
 *   - an employee deactivated would never have their session die
 *
 * There is no need to advance time in the test: signing a token with an old
 * `iat` ourselves is enough to run the sliding-window branch.
 */
let h: Harness;
let owner: Session;

const PASSWORD = 'freshness-password-123';

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

/**
 * An `iat` 10 minutes old: past `SESSION_REFRESH_AFTER_MIN` (5), so the guard
 * will reissue the token, but the 30-minute expiry still has time left. The
 * bug lived in exactly this window.
 */
async function staleCookie(user: {
  id: number;
  email: string;
  role: string;
  employeeId: number | null;
}): Promise<string> {
  const key = new TextEncoder().encode(process.env.JWT_SECRET ?? '');
  const tenMinutesAgo = Math.floor(realNow().getTime() / 1000) - 10 * 60;

  const token = await new SignJWT({
    email: user.email,
    role: user.role,
    employeeId: user.employeeId,
    mustChangePw: false,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt(tenMinutesAgo)
    .setExpirationTime(tenMinutesAgo + 30 * 60)
    .sign(key);

  return `oxeio_session=${token}`;
}

async function staffWithLogin(code: string, role: 'employee' | 'manager') {
  const { employeeId } = await createEmployeeWithCode(h.prisma, code);
  const email = `${code.toLowerCase()}-${uniqueSuffix()}@test.local`;

  const user = await h.prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      fullName: 'Session Person',
      role,
      employeeId,
      mustChangePw: false,
    },
  });

  return { employeeId, user };
}

/** `@Roles(owner, manager)`: staff cannot get in here */
const MANAGER_ONLY = '/api/v1/employees';

describe('role changes in a running session', () => {
  it('a manager\'s old token works as long as they are a manager', async () => {
    const { user } = await staffWithLogin('SF-OK', 'manager');
    const cookie = await staleCookie(user);

    await h.http().get(MANAGER_ONLY).set('Cookie', cookie).expect(200);
  });

  /**
   * The core test of this file. Before the fix this got 200: a demoted
   * manager who kept a tab open and kept working would hold on to the power,
   * and nobody would notice.
   */
  it('after being made staff, even the old token has no power', async () => {
    const { user } = await staffWithLogin('SF-DOWN', 'manager');
    const cookie = await staleCookie(user);

    await h.http().get(MANAGER_ONLY).set('Cookie', cookie).expect(200);

    await owner.http
      .patch(`/api/v1/users/${user.id}/role`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ role: 'employee' })
      .expect(200);

    await h.http().get(MANAGER_ONLY).set('Cookie', cookie).expect(403);
  });

  /** The reverse too: making someone a manager does not require a fresh login */
  it('after being made a manager, the power arrives in the running session', async () => {
    const { user } = await staffWithLogin('SF-UP', 'employee');
    const cookie = await staleCookie(user);

    await h.http().get(MANAGER_ONLY).set('Cookie', cookie).expect(403);

    await owner.http
      .patch(`/api/v1/users/${user.id}/role`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ role: 'manager' })
      .expect(200);

    await h.http().get(MANAGER_ONLY).set('Cookie', cookie).expect(200);
  });
});

describe('account closed during a running session', () => {
  /**
   * Someone dismissed who keeps a tab open would find the dashboard still
   * open: the sliding window extended the session every 5 minutes, and nobody
   * looked at `is_active`.
   */
  it('deactivating kills the running session', async () => {
    const { employeeId, user } = await staffWithLogin('SF-OFF', 'manager');
    const cookie = await staleCookie(user);

    await h.http().get(MANAGER_ONLY).set('Cookie', cookie).expect(200);

    await owner.http
      .post(`/api/v1/employees/${employeeId}/deactivate`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ leftOn: '2026-08-01', reason: 'session freshness test' })
      .expect(200);

    await h.http().get(MANAGER_ONLY).set('Cookie', cookie).expect(401);
  });

  it('the session dies when the user is deleted too', async () => {
    const { user } = await staffWithLogin('SF-GONE', 'manager');
    const cookie = await staleCookie(user);

    await h.prisma.user.delete({ where: { id: user.id } });

    await h.http().get(MANAGER_ONLY).set('Cookie', cookie).expect(401);
  });
});
