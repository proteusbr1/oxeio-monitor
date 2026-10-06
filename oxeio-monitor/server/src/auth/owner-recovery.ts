import { randomBytes } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { UserRole, type PrismaClient } from '@prisma/client';

import { ARGON2_OPTIONS } from './password.service';

/**
 * **Owner lockout: the decisions on the way back in.**
 *
 * The CLI (`src/scripts/recover-owner.ts`) only reads argv and writes to the
 * screen; **what happens** is all here. The reason for splitting is simple: if
 * this code is wrong, either nobody can get in or the wrong person does, and
 * tangled up with `process.argv` it could not have a single test.
 */

export interface OwnerRow {
  id: number;
  email: string;
  fullName: string;
  isActive: boolean;
  hasTwoFactor: boolean;
  lastLoginAt: Date | null;
}

export type RecoverResult =
  | { ok: true; kind: 'reset' | 'created'; email: string; password: string; clearedTwoFactor: boolean }
  /** Why it could not be done: the CLI prints this, and the exit code comes from here too */
  | { ok: false; reason: 'no-owner-no-email' | 'not-found' | 'ambiguous'; detail: string };

/**
 * Careful: 20 characters, deliberately longer than the 14 of
 * `PasswordService.generateTempPassword()`. That one is a temporary password
 * handed to the owner, while this is the **last resort**; it may stay on the
 * terminal screen for a while after it is created.
 */
export function newRecoveryPassword(): string {
  return randomBytes(18).toString('base64url').slice(0, 20);
}

export async function listOwners(prisma: PrismaClient): Promise<OwnerRow[]> {
  const rows = await prisma.user.findMany({
    where: { role: UserRole.owner },
    select: {
      id: true,
      email: true,
      fullName: true,
      isActive: true,
      totpSecret: true,
      lastLoginAt: true,
    },
    orderBy: { id: 'asc' },
  });

  // Careful: `totpSecret` does not leave this function, only "has one or not";
  // the secret has no reason to appear in any list or log.
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.fullName,
    isActive: r.isActive,
    hasTwoFactor: r.totpSecret !== null,
    lastLoginAt: r.lastLoginAt,
  }));
}

export async function recoverOwner(
  prisma: PrismaClient,
  options: { email?: string; fullName?: string } = {},
): Promise<RecoverResult> {
  const owners = await listOwners(prisma);
  const email = options.email?.trim();

  /**
   * There being **no** owner is also a real state: someone deactivated (or
   * deleted) the only account by mistake, or after a database restore. Then
   * creating a new one is the only way.
   */
  if (owners.length === 0) {
    if (!email) {
      return {
        ok: false,
        reason: 'no-owner-no-email',
        detail: 'কোনো owner অ্যাকাউন্ট নেই — নতুন একটা বানাতে ইমেইল দিতে হবে।',
      };
    }

    const password = newRecoveryPassword();
    const created = await prisma.user.create({
      data: {
        email,
        passwordHash: await hash(password, ARGON2_OPTIONS),
        fullName: options.fullName ?? 'oXeio Owner',
        role: UserRole.owner,
        mustChangePw: true,
      },
      select: { id: true, email: true },
    });

    await audit(prisma, created.id, 'created', { email: created.email });

    return {
      ok: true,
      kind: 'created',
      email: created.email,
      password,
      clearedTwoFactor: false,
    };
  }

  /**
   * Careful: with more than one owner, one is **not** picked automatically.
   * "Just take the first" would change the wrong account's password, so
   * someone who was signing in fine would be locked out too, and the real
   * problem would remain.
   */
  const target = email
    ? owners.find((o) => o.email.toLowerCase() === email.toLowerCase())
    : owners.length === 1
      ? owners[0]
      : undefined;

  if (!target) {
    return email
      ? {
          ok: false,
          reason: 'not-found',
          detail: `\`${email}\` নামে কোনো owner নেই।`,
        }
      : {
          ok: false,
          reason: 'ambiguous',
          detail: `${owners.length}টি owner আছে — কোনটা, সেটা ইমেইল দিয়ে বলতে হবে।`,
        };
  }

  const password = newRecoveryPassword();

  await prisma.user.update({
    where: { id: target.id },
    data: {
      passwordHash: await hash(password, ARGON2_OPTIONS),
      // Must be changed on first login: this password has been seen on screen
      mustChangePw: true,
      pwChangedAt: new Date(),
      // Careful: if inactive it is reactivated; otherwise login would stay
      // blocked even with the password fixed, and the reason would be unclear.
      isActive: true,
      /**
       * 2FA is removed too, and this is the **second half** of the lockout fix.
       * A lost phone or a deleted authenticator app is no less common than a
       * forgotten password; resetting only the password would change nothing
       * in that case, and the user would be stuck again at the next login step.
       */
      totpSecret: null,
    },
  });

  await audit(prisma, target.id, 'reset', {
    email: target.email,
    clearedTwoFactor: target.hasTwoFactor,
  });

  return {
    ok: true,
    kind: 'reset',
    email: target.email,
    password,
    clearedTwoFactor: target.hasTwoFactor,
  };
}

/**
 * Careful: `userId` = **the person who was** reset, because there is no way
 * to know **who** ran it (a shell has no session and no IP).
 * `meta.via = 'cli'` shows it did not come from the web, and in an
 * investigation that is the key fact.
 *
 * Careful: the audit write is **not wrapped in try/catch** here, unlike
 * `AuditService.record()`. Swallowing is fine there (keeping the page
 * working matters more than losing a screenshot-view log), but here it is the
 * opposite: it is better for the action to fail than to change the owner's
 * password without leaving a trace.
 */
async function audit(
  prisma: PrismaClient,
  userId: number,
  kind: 'reset' | 'created',
  meta: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId,
      action: 'reset_password',
      targetType: 'user',
      targetId: String(userId),
      meta: { ...meta, via: 'cli', kind },
    },
  });
}
