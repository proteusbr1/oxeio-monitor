import { verify } from '@node-rs/argon2';
import { UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { listOwners, recoverOwner } from '../src/auth/owner-recovery';
import {
  createHarness,
  hashPassword,
  login,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * Owner lockout.
 *
 * Careful: this system has no "forgot password" email link (deliberate: it is
 * an in-office server). So if the only owner loses the password or the 2FA
 * phone, there used to be no way into the whole system: hours kept piling up
 * with nobody able to see them, and payroll could not be produced.
 *
 * The most important test is the last one: after a reset, can you really log
 * in with the new password? Storing a hash is not the same as being able to
 * log in.
 */
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

describe('owner recovery', () => {
  it('works without an email when there is only one owner', async () => {
    const result = await recoverOwner(h.prisma);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.kind).toBe('reset');
    expect(result.email).toBe(OWNER_EMAIL);
    expect(result.password.length).toBeGreaterThanOrEqual(20);

    const user = await h.prisma.user.findUniqueOrThrow({
      where: { email: OWNER_EMAIL },
    });
    // The password was visible on screen, so it must be changed at first login
    expect(user.mustChangePw).toBe(true);
    expect(await verify(user.passwordHash, result.password)).toBe(true);
  });

  /**
   * The second half of the lockout. Losing the phone is no less common than
   * forgetting the password; resetting only the password would leave the owner
   * stuck again at the next login step.
   */
  it('also removes 2FA if set, and says it did', async () => {
    await h.prisma.user.update({
      where: { email: OWNER_EMAIL },
      data: { totpSecret: 'v1:whatever-envelope' },
    });

    const result = await recoverOwner(h.prisma);

    expect(result.ok && result.clearedTwoFactor).toBe(true);

    const user = await h.prisma.user.findUniqueOrThrow({
      where: { email: OWNER_EMAIL },
    });
    expect(user.totpSecret).toBeNull();
  });

  /** An inactive owner would stay locked out even with the password fixed. */
  it('reactivates a deactivated owner', async () => {
    await h.prisma.user.update({
      where: { email: OWNER_EMAIL },
      data: { isActive: false },
    });

    await recoverOwner(h.prisma);

    const user = await h.prisma.user.findUniqueOrThrow({
      where: { email: OWNER_EMAIL },
    });
    expect(user.isActive).toBe(true);
  });

  /**
   * "Just take the first one" would change the password of the wrong account:
   * the person who was logging in fine would be locked out, and the real
   * problem would remain.
   */
  it('does not pick by itself when there are several owners', async () => {
    await h.prisma.user.create({
      data: {
        email: 'second-owner@test.local',
        passwordHash: await hashPassword('whatever-123456'),
        fullName: 'Second Owner',
        role: UserRole.owner,
      },
    });

    const blind = await recoverOwner(h.prisma);
    expect(blind.ok).toBe(false);
    if (!blind.ok) expect(blind.reason).toBe('ambiguous');

    // If an email is given, exactly that one
    const picked = await recoverOwner(h.prisma, {
      email: 'second-owner@test.local',
    });
    expect(picked.ok && picked.email).toBe('second-owner@test.local');

    // The real owner's password is untouched; otherwise rescuing one person
    // would lock out another
    const untouched = await h.prisma.user.findUniqueOrThrow({
      where: { email: OWNER_EMAIL },
    });
    expect(await verify(untouched.passwordHash, OWNER_PASSWORD)).toBe(true);
  });

  it('changes nothing when given a wrong email', async () => {
    const result = await recoverOwner(h.prisma, { email: 'nobody@test.local' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-found');

    const user = await h.prisma.user.findUniqueOrThrow({
      where: { email: OWNER_EMAIL },
    });
    expect(await verify(user.passwordHash, OWNER_PASSWORD)).toBe(true);
  });

  /** After restoring a database, or if someone deleted the only account by mistake. */
  it('creates a new one when there is no owner at all', async () => {
    await h.prisma.auditLog.deleteMany({});
    await h.prisma.user.deleteMany({ where: { role: UserRole.owner } });

    const blind = await recoverOwner(h.prisma);
    expect(blind.ok).toBe(false);
    if (!blind.ok) expect(blind.reason).toBe('no-owner-no-email');

    const made = await recoverOwner(h.prisma, {
      email: 'fresh@test.local',
      fullName: 'Fresh Start',
    });

    expect(made.ok && made.kind).toBe('created');
    expect(await listOwners(h.prisma)).toHaveLength(1);
  });

  /**
   * Changing an owner's password must leave a trace. Precisely because it did
   * not happen via the web, the record matters more: `meta.via = 'cli'` tells
   * an investigation that someone was in the server shell.
   */
  it('leaves a trace in the audit log', async () => {
    await h.prisma.auditLog.deleteMany({});

    await recoverOwner(h.prisma);

    const [row] = await h.prisma.auditLog.findMany({
      where: { action: 'reset_password' },
    });

    expect(row).toBeDefined();
    expect(row.targetType).toBe('user');
    expect((row.meta as { via: string }).via).toBe('cli');
  });

  /**
   * The real question: storing a hash is not the same as being able to log in.
   * If the argon2 parameters differ, or a login condition on
   * `isActive`/`mustChangePw` exists, the owner would stay locked out even
   * with all the tests above passing.
   */
  it('really logs in with the new password', async () => {
    const result = await recoverOwner(h.prisma);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // `login()` itself expects 200, so it throws right here on failure
    const session = await login(h, OWNER_EMAIL, result.password);

    const me = await session.http.get('/api/v1/auth/me').expect(200);
    expect(me.body.mustChangePassword).toBe(true);
  });
});
