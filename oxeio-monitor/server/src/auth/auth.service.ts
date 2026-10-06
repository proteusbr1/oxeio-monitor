import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoginThrottleService } from './login-throttle.service';
import { PasswordService } from './password.service';
import {
  decodeEnvelope,
  encodeEnvelope,
  verifySecondFactor,
  type TotpEnvelope,
} from './totp';
import type { SessionUser } from './types';
/**
 * Careful: the guard formula is **borrowed from the rules file**, not written
 * again here, so the server's guard and the session's flag are tied to the same line.
 */
import { canUseTargets } from '../targets/targets.rules';

/**
 * A login can end three ways, hence a discriminated union. Expressing it with
 * an optional field would make an impossible state such as "needsTotp true
 * and a user too" type-valid at the call site.
 */
export type LoginOutcome =
  | { status: 'needs_totp' }
  | {
      status: 'ok';
      user: Omit<SessionUser, 'issuedAt'>;
      mustChangePassword: boolean;
      /** Signed in with a recovery code; the user needs to be told */
      usedRecoveryCode: boolean;
      /** How many recovery codes remain if 2FA is on; otherwise null */
      recoveryCodesLeft: number | null;
    };

export interface MeResult {
  userId: number;
  email: string;
  fullName: string;
  role: UserRole;
  employeeId: number | null;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  /** I06: the Security screen uses this to show the state */
  twoFactorEnabled: boolean;
  /**
   * **Whether this user may submit design targets.** (22 August)
   *
   * Careful: **why a ready-made answer and not the raw `staffType`.** The rule
   * is "owner, manager, **or** staffType = researcher"; sending the raw value
   * would force the web to **rewrite** that condition, and one day the server
   * and the screen would disagree (someone would see the menu but get a 403,
   * or the reverse). The server decides, the web only obeys. The condition is
   * the exact twin of `TargetsService.assertCanSubmit()`.
   */
  canAddTargets: boolean;
  /**
   * **Whether this user can proofread spelling** (ADR-038).
   *
   * Careful: **separate** from `canAddTargets`. Every researcher can submit
   * targets, but only those the owner has ticked do spell checking.
   */
  canProofread: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
  ) {}

  /**
   * In the second step of 2FA the email + password must be sent **again**;
   * there is no "half-logged-in" token in between. Such a token would be one
   * more thing that can be stolen, can expire, or can by mistake carry the
   * power of a full session. The browser keeps the password in the form, so
   * the user sees no difference.
   */
  async login(
    email: string,
    password: string,
    ip: string,
    totp?: string,
    recoveryCode?: string,
  ): Promise<LoginOutcome> {
    this.throttle.assertNotLocked(email, ip);

    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    // A missing user and a wrong password get the same message, otherwise
    // outsiders could tell which emails are real (user enumeration)
    const ok =
      user !== null &&
      user.isActive &&
      (await this.passwords.verify(user.passwordHash, password));

    if (!ok) {
      this.throttle.recordFailure(email, ip);
      await this.audit.record({
        userId: user?.id ?? null,
        action: 'login_failed',
        ipAddress: ip,
        meta: { email },
      });
      throw new UnauthorizedException('Email or password is incorrect');
    }

    // I06: 2FA. A broken envelope makes `decodeEnvelope` throw, i.e. fail-closed.
    const env = decodeEnvelope(user.totpSecret);
    let usedRecoveryCode = false;
    let nextEnv: TotpEnvelope | null = null;

    if (env?.enabled) {
      const result = verifySecondFactor(env, { totp, recoveryCode });

      if (!result.ok && result.reason === 'missing') {
        // Careful: **not** `recordSuccess` here. Even with the right password
        // the login is not complete yet, so the failure counter must not be cleared.
        // Not a failure either: not sending a code is not an attack, it is the normal first step.
        return { status: 'needs_totp' };
      }

      if (!result.ok) {
        // Careful: the throttle applies in the 2FA step too, otherwise an
        // attacker who knows the password could try all 1 million 6-digit codes undisturbed.
        this.throttle.recordFailure(email, ip);
        await this.audit.record({
          userId: user.id,
          action: '2fa_failed',
          ipAddress: ip,
          meta: { reason: result.reason },
        });
        throw new UnauthorizedException(
          result.reason === 'replayed'
            ? 'This code has already been used — wait for the next code in your app'
            : 'Verification code is invalid',
        );
      }

      usedRecoveryCode = result.usedRecoveryCode;
      nextEnv = result.env;
    }

    this.throttle.recordSuccess(email, ip);

    // Careful: the consumed code/counter and `lastLoginAt` go in the same
    // `UPDATE`. Split apart, one failing would create "logged in but the code
    // was not consumed", which breaks replay protection.
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        ...(nextEnv === null ? {} : { totpSecret: encodeEnvelope(nextEnv) }),
      },
    });

    await this.audit.record({
      userId: user.id,
      action: 'login',
      ipAddress: ip,
      meta: { twoFactor: env?.enabled === true, recovery: usedRecoveryCode },
    });

    if (usedRecoveryCode) {
      await this.audit.record({
        userId: user.id,
        action: '2fa_recovery_used',
        ipAddress: ip,
        meta: { left: nextEnv?.recoveryHashes.length ?? 0 },
      });
    }

    return {
      status: 'ok',
      user: {
        userId: user.id,
        email: user.email,
        role: user.role,
        employeeId: user.employeeId,
        mustChangePw: user.mustChangePw,
      },
      mustChangePassword: user.mustChangePw,
      usedRecoveryCode,
      recoveryCodesLeft: nextEnv?.recoveryHashes.length ?? null,
    };
  }

  async me(userId: number): Promise<MeResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      // Careful: the work type is needed for `canAddTargets`: researchers sign
      // in with the `employee` role, so the role alone cannot tell
      /**
       * Careful: `include: { employee: ... }` used to be here, because
       * `canAddTargets` and `canProofread` had to be read from **another
       * table**. Since the `researcher` role arrived on 25 August, both come
       * straight from the role, so the join is **gone from every `/auth/me` call**.
       */
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('This account is no longer active');
    }

    return {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      employeeId: user.employeeId,
      mustChangePassword: user.mustChangePw,
      lastLoginAt: user.lastLoginAt,
      twoFactorEnabled: decodeEnvelope(user.totpSecret)?.enabled === true,
      /**
       * Careful: the formula for both is **the same today**, yet there are two
       * names, deliberately. On screen they cover two different things (a menu
       * item versus a row button), and keeping separate condition names means
       * changing one later does not require hunting for the other. The formula
       * is written **in one place** in `canUseTargets`, so even with separate
       * names the two can never silently diverge.
       */
      canAddTargets: canUseTargets(user.role),
      canProofread: canUseTargets(user.role),
    };
  }

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    ip: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    const ok = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    if (await this.passwords.verify(user.passwordHash, newPassword)) {
      throw new BadRequestException(
        'New password must be different from the current one',
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await this.passwords.hash(newPassword),
        mustChangePw: false,
        pwChangedAt: new Date(),
      },
    });

    await this.audit.record({
      userId,
      action: 'change_password',
      ipAddress: ip,
    });
  }

  /**
   * G33: the owner resets someone's password.
   * The new password is returned **only once**; it is never stored in plaintext anywhere.
   * No SMTP is needed, so it works in Phase 1.
   */
  async resetPassword(
    actorId: number,
    targetUserId: number,
    ip: string,
    /** If the owner sets it themselves there is no forced change (23 August) */
    chosen?: string,
  ): Promise<{ email: string; tempPassword: string }> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) throw new NotFoundException('User not found');

    /**
     * **Reset is blocked on an inactive account, and the reason is stated.**
     *
     * It used to succeed silently: the new password appeared on screen, but
     * `login()` checks `isActive` along with the password, so that password
     * **never worked**. And the login message is deliberately always the same
     * ("Email or password is incorrect", to prevent user enumeration), so for
     * the owner it came down to: the reset works, the login does not, and no
     * way to learn why.
     *
     * There is nothing to hide in this message: reaching this route requires
     * being owner, who can see every account anyway.
     *
     * Careful: it is **not** activated automatically. Resetting a password
     * must not accidentally reopen a departed employee's account; activating
     * is a separate, conscious act (Staff -> Reactivate).
     */
    if (!target.isActive) {
      throw new ConflictException(
        'This login is disabled because the staff member is inactive. '
          + 'Reactivate them on the Staff screen first — then reset the password.',
      );
    }

    // Careful: same rule on reset: no forced change if the owner sets it
    const tempPassword = chosen ?? this.passwords.generateTempPassword();

    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        passwordHash: await this.passwords.hash(tempPassword),
        // Careful: the same on reset, never forced (see the note above)
        mustChangePw: false,
        pwChangedAt: new Date(),
      },
    });

    await this.audit.record({
      userId: actorId,
      action: 'reset_password',
      targetType: 'user',
      targetId: targetUserId,
      ipAddress: ip,
      meta: { email: target.email },
    });

    return { email: target.email, tempPassword };
  }

  /**
   * Staff <-> manager: changing a portal account's role.
   *
   * Careful: why it was needed: the role was set only when the account was
   * **opened**, with no way to change it. To make someone a manager their
   * account had to be deleted and reopened, meaning a new password, and all
   * their `user_id`-linked history (audit log) would be severed.
   *
   * Careful: `owner` can **neither be granted nor taken away** here:
   *
   *   - Cannot be granted: owner means the keys to payroll, the audit log and
   *     settings. That must not change hands with one click on a dropdown
   *     (ADR-011d, and the web's `PORTAL_ROLES` has no owner either).
   *   - Cannot be taken away: reaching this route requires being owner, so
   *     demoting yourself or the last owner would leave **nobody able to get
   *     in**, and the way back would be the `recover-owner` script on the server.
   *
   * A role change also applies to a running session: when `JwtAuthGuard`
   * re-issues the token it reads the role from the database (within 5 minutes).
   */
  async changeRole(
    actorId: number,
    targetUserId: number,
    /**
     * Careful: `owner` is outside the list; see the note above. The rest are
     * written by hand, not borrowed from `UserRole`: if something new is added
     * to the enum tomorrow it **should not slip in here by itself** (the
     * controller's `@IsIn` has the same list).
     */
    role: 'employee' | 'researcher' | 'manager',
    ip: string,
  ): Promise<{ id: number; email: string; role: UserRole }> {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found');

    if (target.role === UserRole.owner) {
      throw new ConflictException(
        'Owner accounts cannot be changed here. Owners are managed on the server.',
      );
    }

    // Careful: with the same role, return quietly. No "change" is written to
    // the audit log, otherwise history would collect events where nothing changed.
    if (target.role === role) {
      return { id: target.id, email: target.email, role: target.role };
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { role },
      select: { id: true, email: true, role: true },
    });

    await this.audit.record({
      userId: actorId,
      action: 'change_setting',
      targetType: 'user',
      targetId: targetUserId,
      ipAddress: ip,
      // Careful: the previous value is recorded too; to answer "who became a
      // manager and when", the new value alone is not enough
      meta: { op: 'change_role', from: target.role, to: role },
    });

    return updated;
  }

  /**
   * Changing the login email, i.e. the staff member's "username".
   *
   * Careful: why it was needed: the email has to be typed by hand when a
   * portal account is created, and if it was wrong the account stayed stuck
   * on the wrong address forever, with no way to change it. Typing it once
   * for each of 15 people, at least one typo is normal.
   *
   * Careful: the password is **not** touched here; that is `resetPassword()`.
   * Keeping the two separate is deliberate: fixing an email's spelling should
   * not needlessly change anyone's password.
   */
  async changeLoginEmail(
    actorId: number,
    targetUserId: number,
    email: string,
    ip: string,
  ): Promise<{ id: number; email: string }> {
    const next = email.trim().toLowerCase();
    if (!next.includes('@')) {
      throw new BadRequestException('That does not look like an email address');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) throw new NotFoundException('User not found');

    if (target.email === next) return { id: target.id, email: target.email };

    // Careful: checked up front, not relying only on the unique constraint;
    // otherwise Prisma's P2002 would reach the screen and nobody would understand what went wrong.
    const taken = await this.prisma.user.findUnique({ where: { email: next } });
    if (taken) {
      throw new ConflictException('Another account already uses that email');
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { email: next },
    });

    await this.audit.record({
      userId: actorId,
      action: 'change_login_email',
      targetType: 'user',
      targetId: targetUserId,
      ipAddress: ip,
      // The previous value is recorded too: the only way to reconcile later who changed whose login
      meta: { from: target.email, to: next },
    });

    return { id: updated.id, email: updated.email };
  }

  /** A staff self-view account (J04/J05), opened by the owner */
  /**
   * **If `chosen` is given, that is what gets set, and no change screen follows.**
   * (23 August, the owner's decision)
   *
   * Careful: if it is not given, **the earlier behavior stays intact**: a
   * random password plus a forced change on first login. The real purpose of
   * that step was "the owner not knowing the password forever"; when the owner
   * sets it themselves they give that up **knowingly**, but the default
   * should still stay safe.
   */
  async createPortalAccount(
    actorId: number,
    employeeId: number,
    email: string,
    role: UserRole,
    ip: string,
    chosen?: string,
  ): Promise<{ userId: number; email: string; tempPassword: string }> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) throw new NotFoundException('Staff member not found');

    const normalized = email.toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (existing) {
      throw new BadRequestException('An account with this email already exists');
    }

    // Careful: the owner's own value if given; otherwise random as before
    const tempPassword = chosen ?? this.passwords.generateTempPassword();

    const created = await this.prisma.user.create({
      data: {
        email: normalized,
        passwordHash: await this.passwords.hash(tempPassword),
        fullName: employee.fullName,
        role,
        employeeId,
        /**
         * Careful: **never forced.** (The owner's decision, made for the second time.)
         *
         * At first, leaving the field empty kept the old behavior (forced
         * change), on the argument "don't tear the safety net". But the next
         * day the owner hit the same wall again, pressing Reset with the field
         * empty. **What they asked for had not been done**, and a half-adopted
         * decision means the old behavior returns half the time.
         *
         * If no password is given a random one is generated (shown to the
         * owner once), but a change is **not demanded**. If the staff member
         * wants, they will change it themselves on the Security page.
         */
        mustChangePw: false,
        pwChangedAt: new Date(),
      },
    });

    await this.audit.record({
      userId: actorId,
      action: 'create_portal_account',
      targetType: 'employee',
      targetId: employeeId,
      ipAddress: ip,
      meta: { email: normalized, role },
    });

    return { userId: created.id, email: normalized, tempPassword };
  }
}
