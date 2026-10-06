import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Prisma, UserRole } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateAccountDto } from './account.dto';
import { mergePreferences, preferencesOf, type UserPreferences } from './preferences';
import { decodeEnvelope } from './totp';

/**
 * The signed-in person's own account (web: Account page). Everything here
 * acts on the session's user only — there is no id in any route.
 */

export interface AccountView {
  email: string;
  fullName: string;
  role: UserRole;
  /**
   * Staff accounts take their name from the staff record (Staff →
   * Directory), so the owner's lists and payroll keep one spelling. Only an
   * account with no staff record edits its own name.
   */
  nameFromStaffRecord: boolean;
  staff: { empCode: string; designation: string | null } | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  pwChangedAt: Date | null;
  twoFactorEnabled: boolean;
  preferences: UserPreferences;
}

export interface AccountEvent {
  at: Date;
  action: string;
  ip: string | null;
  /** someone else did it to this account (the owner reset the password) */
  byOther: boolean;
}

/** What a person sees in "Recent activity": their sign-ins and security changes */
const OWN_ACTIONS = [
  'login',
  'login_failed',
  'change_password',
  '2fa_enable',
  '2fa_disable',
  '2fa_recovery_regenerate',
  '2fa_recovery_used',
  '2fa_failed',
  'sign_out_other_sessions',
];
/** …and what the owner did to it */
const DONE_TO_ME = ['reset_password', 'change_login_email'];

const ACTIVITY_LIMIT = 15;

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async view(userId: number): Promise<AccountView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
        lastLoginAt: true,
        pwChangedAt: true,
        totpSecret: true,
        preferences: true,
        employee: { select: { empCode: true, designation: true } },
      },
    });
    if (!user) throw new UnauthorizedException();
    return {
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      nameFromStaffRecord: user.employee !== null,
      staff: user.employee,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      pwChangedAt: user.pwChangedAt,
      twoFactorEnabled: decodeEnvelope(user.totpSecret)?.enabled === true,
      preferences: preferencesOf(user.preferences),
    };
  }

  async update(userId: number, dto: UpdateAccountDto, ip: string): Promise<AccountView> {
    const before = await this.view(userId);
    const data: Prisma.UserUpdateInput = {};
    const changed: Record<string, unknown> = {};

    if (dto.fullName !== undefined) {
      const name = dto.fullName.trim();
      if (before.nameFromStaffRecord) {
        throw new BadRequestException(
          'Your name comes from your staff record — ask the owner or a manager to change it',
        );
      }
      if (name.length < 2) throw new BadRequestException('The name is too short');
      if (name !== before.fullName) {
        data.fullName = name;
        changed.fullName = { from: before.fullName, to: name };
      }
    }

    if (dto.theme !== undefined) {
      const preferences = mergePreferences(before.preferences, { theme: dto.theme });
      if (preferences.theme !== before.preferences.theme) {
        data.preferences = preferences as Prisma.InputJsonObject;
        changed.theme = dto.theme;
      }
    }

    if (dto.language !== undefined) {
      const preferences = mergePreferences(data.preferences ? (data.preferences as UserPreferences) : before.preferences, { language: dto.language });
      if (preferences.language !== before.preferences.language) {
        data.preferences = preferences as Prisma.InputJsonObject;
        changed.language = dto.language;
      }
    }

    if (Object.keys(changed).length === 0) return before;

    await this.prisma.user.update({ where: { id: userId }, data });
    await this.audit.record({ userId, action: 'update_profile', ipAddress: ip, meta: changed as Prisma.InputJsonObject });
    return this.view(userId);
  }

  async activity(userId: number): Promise<AccountEvent[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { userId, action: { in: OWN_ACTIONS } },
          { targetType: 'user', targetId: String(userId), action: { in: DONE_TO_ME } },
        ],
      },
      orderBy: { occurredAt: 'desc' },
      take: ACTIVITY_LIMIT,
      select: { occurredAt: true, action: true, ipAddress: true, userId: true },
    });
    return rows.map((r) => ({
      at: r.occurredAt,
      action: r.action,
      ip: r.ipAddress,
      byOther: r.userId !== userId,
    }));
  }

  /**
   * Every session issued before this second ends at its next refresh (at
   * most `SESSION_REFRESH_AFTER_MIN` later — see JwtAuthGuard). The caller
   * re-issues its own token right after, so this device stays signed in.
   *
   * Careful: whole seconds. A token's `iat` is in seconds; storing the
   * milliseconds would make the token re-issued in this same second look
   * older than the cut and sign this device out too.
   */
  async revokeSessions(userId: number, ip: string | null, action: 'sign_out_other_sessions' | null): Promise<void> {
    const cut = new Date(Math.floor(Date.now() / 1000) * 1000);
    await this.prisma.user.update({ where: { id: userId }, data: { sessionsRevokedAt: cut } });
    if (action) await this.audit.record({ userId, action, ipAddress: ip });
  }
}
