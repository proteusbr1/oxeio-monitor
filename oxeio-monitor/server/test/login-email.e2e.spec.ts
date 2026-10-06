import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
 * **PATCH /users/:id/email** — changing a staff member's login email ("username").
 *
 * Why this was needed: when a portal account is opened the email is typed
 * by hand. If it was wrong, that account stayed stuck on the wrong address
 * forever — there was no way to change it. Typed once each for 15 people,
 * at least one typo is only natural.
 *
 * Another thing was caught alongside: `resetUserPassword()` was written in
 * the web API but nobody called it — because the response did not even
 * carry a `userId` to call it with. So if staff forgot their password the
 * owner could do nothing.
 */
let h: Harness;
let owner: Session;
let userId: number;

const START = 'staff-login@test.local';

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);

  const { employeeId } = await createEmployeeWithCode(h.prisma, 'LG-001');
  const user = await h.prisma.user.create({
    data: {
      email: START,
      passwordHash: await hashPassword('whatever-123'),
      fullName: 'Alex Silva',
      role: 'employee',
      employeeId,
    },
  });
  userId = user.id;
});

const patch = (id: number, email: string) =>
  owner.http
    .patch(`/api/v1/users/${id}/email`)
    .set('X-CSRF-Token', owner.csrf)
    .send({ email });

describe('PATCH /users/:id/email', () => {
  it('changes the email', async () => {
    const res = await patch(userId, 'alex@oxeio.local').expect(200);

    expect(res.body.email).toBe('alex@oxeio.local');
    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.email).toBe('alex@oxeio.local');
  });

  /**
   * Login should be case-insensitive, so storage is lowercase too. Otherwise
   * an account opened with `Alex@…` could not log in by typing `alex@…`,
   * and the reason would not be written anywhere on screen.
   */
  it('stores it lowercase', async () => {
    const res = await patch(userId, 'Alex@OXeio.Local').expect(200);
    expect(res.body.email).toBe('alex@oxeio.local');
  });

  /**
   * With leading/trailing spaces `@IsEmail()` gives 400 — the same as every
   * other DTO in the repo (nowhere is there a `@Transform` trim). Making an
   * exception on this one route would make someone later assume trimming
   * happens everywhere. The screen has no problem — it sends `email.trim()`.
   */
  it('sending with spaces gives 400 — like the repo\'s other routes', async () => {
    await patch(userId, '  alex@oxeio.local  ').expect(400);
  });

  /**
   * The password is not touched — the most important condition. If fixing an
   * email's spelling changed someone's password, they could not log in the
   * next day and nobody would know why. So reset is a separate route, a
   * separate button.
   */
  it('the password stays unchanged', async () => {
    const before = await h.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    await patch(userId, 'alex@oxeio.local').expect(200);

    const after = await h.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.mustChangePw).toBe(before.mustChangePw);
  });

  /** Someone else's email gives 409 — otherwise Prisma's P2002 would reach the screen */
  it('another account\'s email gives 409', async () => {
    await patch(userId, OWNER_EMAIL).expect(409);

    const row = await h.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.email).toBe(START);
  });

  it('the same email breaks nothing', async () => {
    await patch(userId, START).expect(200);
  });

  it('400 when it is not an email', async () => {
    await patch(userId, 'not-an-email').expect(400);
  });

  it('404 for an unknown user', async () => {
    await patch(999_999, 'x@test.local').expect(404);
  });

  /** Changing a login is the owner's job — not the manager's */
  it('a manager cannot', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);

    await manager.http
      .patch(`/api/v1/users/${userId}/email`)
      .set('X-CSRF-Token', manager.csrf)
      .send({ email: 'x@test.local' })
      .expect(403);
  });

  /** Who changed whose login — the only way to reconcile later */
  it('both the old and the new value appear in audit_log', async () => {
    await h.prisma.auditLog.deleteMany({});

    await patch(userId, 'alex@oxeio.local').expect(200);

    const [row] = await h.prisma.auditLog.findMany({
      where: { action: 'change_login_email' },
    });
    const meta = row.meta as { from: string; to: string };

    expect(meta.from).toBe(START);
    expect(meta.to).toBe('alex@oxeio.local');
  });

  /** After the change, logging in with the new email works — this is the real claim */
  it('logging in with the new email really works', async () => {
    await patch(userId, 'alex@oxeio.local').expect(200);

    await h
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'alex@oxeio.local', password: 'whatever-123' })
      .expect(200);
  });
});

describe('GET /employees — portal account id and email', () => {
  /**
   * Without these two fields, reset or email change could not be done from
   * the screen at all (both `/users/:id/...` need the id). That is exactly
   * why `resetUserPassword()` was never called despite being written.
   */
  it('portalUserId and portalEmail come back', async () => {
    const res = await owner.http.get('/api/v1/employees?status=all').expect(200);
    const row = (res.body.rows as Record<string, unknown>[]).find(
      (r) => r.empCode === 'LG-001',
    ) as { portalUserId: number; portalEmail: string };

    expect(row.portalUserId).toBe(userId);
    expect(row.portalEmail).toBe(START);
  });

  it('both are null when there is no account', async () => {
    await createEmployeeWithCode(h.prisma, 'LG-NONE');

    const res = await owner.http.get('/api/v1/employees?status=all').expect(200);
    const row = (res.body.rows as Record<string, unknown>[]).find(
      (r) => r.empCode === 'LG-NONE',
    ) as { portalUserId: number | null; portalEmail: string | null };

    expect(row.portalUserId).toBeNull();
    expect(row.portalEmail).toBeNull();
  });

  /** A password hash or TOTP secret is never in a response */
  it('nothing secret goes into the response', async () => {
    const res = await owner.http.get('/api/v1/employees?status=all').expect(200);
    const raw = JSON.stringify(res.body);

    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('totpSecret');
  });
});
