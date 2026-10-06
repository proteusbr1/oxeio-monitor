import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { toDataURL } from 'qrcode';

import { AuditService, type AuditAction } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import {
  buildOtpauthUri,
  decodeEnvelope,
  encodeEnvelope,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  verifyTotpCode,
  type TotpEnvelope,
} from './totp';

/**
 * **Filtered from `AuditAction`, not a separate list.** The names used to be
 * written separately in `two-factor.audit.ts` and forced in with a cast,
 * because the union was another agent's file at the time. Now the names are
 * in the real union, so there is no cast either: a typo is caught **at
 * compile time**, and an unknown action is not silently written to `audit_log`.
 */
type TwoFactorAuditAction = Extract<AuditAction, `2fa_${string}`>;

export interface TwoFactorStatus {
  enabled: boolean;
  /** Set up but not yet proven with a code */
  pendingSetup: boolean;
  recoveryCodesLeft: number;
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
  /** `data:image/png;base64,...`: no external URL, because of CSP */
  qrDataUrl: string;
}

/**
 * I06: the I/O part of optional TOTP 2FA. All the pure calculation is in
 * `totp.ts`; here is only DB reads/writes, QR drawing and audit.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  private async loadEnvelope(userId: number): Promise<TotpEnvelope | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true },
    });
    if (!user) throw new UnauthorizedException('Account not found');
    return decodeEnvelope(user.totpSecret);
  }

  private saveEnvelope(userId: number, env: TotpEnvelope | null): Promise<unknown> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: env === null ? null : encodeEnvelope(env) },
    });
  }

  private log(
    userId: number,
    action: TwoFactorAuditAction,
    ip: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      userId,
      action,
      ipAddress: ip,
      meta: meta as Prisma.InputJsonValue | undefined,
    });
  }

  async status(userId: number): Promise<TwoFactorStatus> {
    const env = await this.loadEnvelope(userId);
    return {
      enabled: env?.enabled === true,
      pendingSetup: env !== null && !env.enabled,
      recoveryCodesLeft: env?.recoveryHashes.length ?? 0,
    };
  }

  /**
   * Step 1: generates a secret and returns the QR.
   *
   * Careful: 2FA is **not turned on** here (`enabled: false`). If it were,
   * a user who forgot to scan the QR, or scanned it in the wrong app, would
   * be locked out of their own account for good, and for the owner that
   * would mean losing the whole system.
   */
  async setup(userId: number, ip: string): Promise<TwoFactorSetup> {
    const existing = await this.loadEnvelope(userId);
    if (existing?.enabled) {
      // Careful: replacing the secret while 2FA is on would suddenly stop the
      // old phone's codes working, though the user may not have scanned the new one.
      throw new BadRequestException(
        '2FA is already enabled. Turn it off first to set it up again.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new UnauthorizedException('Account not found');

    const secret = generateSecret();
    const otpauthUri = buildOtpauthUri(secret, user.email);

    await this.saveEnvelope(userId, {
      v: 1,
      secret,
      enabled: false,
      recoveryHashes: [],
      lastCounter: 0,
    });

    await this.log(userId, '2fa_setup', ip);

    return {
      secret,
      otpauthUri,
      qrDataUrl: await toDataURL(otpauthUri, { margin: 1, width: 240 }),
    };
  }

  /**
   * Step 2: it is turned on only after proving with a code, and recovery codes come then.
   *
   * Recovery codes are generated **here**, not in setup, so codes do not
   * float around needlessly when a setup is left incomplete. They are returned only once.
   */
  async enable(
    userId: number,
    code: string,
    ip: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const env = await this.loadEnvelope(userId);
    if (env === null) {
      throw new BadRequestException('Run setup first');
    }
    if (env.enabled) {
      throw new BadRequestException('2FA is already enabled');
    }

    const verdict = verifyTotpCode(env, code);
    if (!verdict.ok) {
      await this.log(userId, '2fa_enable_failed', ip, { reason: verdict.reason });
      throw new BadRequestException(
        "Code didn't match — check that your app's clock is correct",
      );
    }

    const recoveryCodes = generateRecoveryCodes();

    await this.saveEnvelope(userId, {
      ...env,
      enabled: true,
      recoveryHashes: recoveryCodes.map(hashRecoveryCode),
      lastCounter: verdict.counter,
    });

    await this.log(userId, '2fa_enable', ip, {
      recoveryCodes: recoveryCodes.length,
    });

    return { recoveryCodes };
  }

  /**
   * Careful: the password is required. If the session cookie alone were
   *    enough, anyone could turn 2FA off from a laptop left open, yet the
   *    whole purpose of 2FA is "protection even if a cookie is stolen".
   */
  async disable(userId: number, password: string, ip: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Account not found');

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      await this.log(userId, '2fa_disable_failed', ip);
      throw new UnauthorizedException('Password is incorrect');
    }

    await this.saveEnvelope(userId, null);
    await this.log(userId, '2fa_disable', ip);
  }

  /**
   * A new set when recovery codes are running out or the paper is lost.
   * Careful: all the old ones stop working **immediately**; otherwise the
   *    lost paper would still work, and there would be no point in making a new set.
   */
  async regenerateRecoveryCodes(
    userId: number,
    password: string,
    ip: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Account not found');

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Password is incorrect');
    }

    const env = decodeEnvelope(user.totpSecret);
    if (env === null || !env.enabled) {
      throw new BadRequestException('2FA is not enabled');
    }

    const recoveryCodes = generateRecoveryCodes();
    await this.saveEnvelope(userId, {
      ...env,
      recoveryHashes: recoveryCodes.map(hashRecoveryCode),
    });

    await this.log(userId, '2fa_recovery_regenerate', ip, {
      recoveryCodes: recoveryCodes.length,
    });

    return { recoveryCodes };
  }
}
