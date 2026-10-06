import { Body, Controller, Get, Ip, Patch, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsString, MaxLength } from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { B2_AUTH_TIMEOUT_MS } from './ops.constants';
import {
  b2Verdict,
  offsiteView,
  resolveOffsite,
  OFFSITE_SETTING_KEY,
  type B2Verdict,
  type OffsiteSettingsView,
} from './offsite.settings';

class SaveOffsiteDto {
  /**
   * An empty string is **valid**: it means "delete it and go back to the server's
   * file". Hence no `@IsNotEmpty()`, otherwise there would be no way to remove a
   * wrongly entered key.
   */
  @IsString() @MaxLength(120)
  keyId!: string;

  @IsString() @MaxLength(120)
  appKey!: string;

  @IsString() @MaxLength(120)
  bucket!: string;
}

/**
 * **Offsite backup config from the screen** (R5 · G39).
 *
 * Why this was needed (a field incident): setting the B2 key meant SSH into the
 * VPS, `rclone config`, and editing `/etc/oxeio-offsite.env`. The owner tried,
 * and a partially pasted key gave `401 bad_auth_token`; finding the cause meant
 * poking around in a terminal. Setting it from the screen skips that whole
 * path, and a mistake is caught **immediately**.
 *
 * Owner-only. This is an infrastructure credential, and the backup holds the
 * whole organisation's hours, salaries and screenshots; who may touch it is
 * not the manager's decision.
 */
@Roles(UserRole.owner)
@Controller('settings/offsite')
export class OffsiteSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async read(): Promise<OffsiteSettingsView> {
    return offsiteView(await this.resolve());
  }

  @Patch()
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveOffsiteDto,
    @Ip() ip: string,
  ): Promise<OffsiteSettingsView> {
    const bucket = dto.bucket.trim();
    let keyId = dto.keyId.trim();
    let appKey = dto.appKey.trim();

    /**
     * **An empty appKey means "keep the previous one"**. The rule differs from
     * Telegram's on purpose.
     *
     * The B2 applicationKey is **shown only once**. If pressing Save while fixing
     * the bucket name wiped the key, the owner would have to **create a new key**
     * as the price of fixing a typo. A Telegram token can be fetched again from
     * BotFather at any time; this one cannot.
     *
     * To clear it fully, save with all three fields empty; the condition below
     * therefore also checks whether `keyId` and `bucket` are empty.
     */
    if ((appKey.length === 0 || keyId.length === 0) && bucket.length > 0) {
      const current = await this.stored();
      if (appKey.length === 0) appKey = current?.appKey?.trim() ?? '';
      if (keyId.length === 0) keyId = current?.keyId?.trim() ?? '';
    }

    await this.prisma.setting.upsert({
      where: { key: OFFSITE_SETTING_KEY },
      update: { value: { keyId, appKey, bucket }, updatedById: actor.userId },
      create: {
        key: OFFSITE_SETTING_KEY,
        value: { keyId, appKey, bucket },
        updatedById: actor.userId,
      },
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'setting',
      targetId: OFFSITE_SETTING_KEY,
      ipAddress: ip,
      /**
       * **The key does not go into the audit log either**, only whether it is
       * set. The owner and managers both see the audit log, and a secret that
       * lands there can never be erased.
       */
      meta: { op: 'offsite', keySet: appKey.length > 0, keyId, bucket },
    });

    return this.read();
  }

  /**
   * **Does the key pair really work? Right now.**
   *
   * Without this the owner would save and wait **until Saturday**, and if
   * nothing went out they would know something was wrong, but not what. That is
   * exactly the darkness in which time was lost in the August incident.
   *
   * `b2_authorize_account` is chosen on purpose: **it works even with a
   * restricted key** (no bucket-listing permission needed), and the response
   * also says which bucket the key is bound to.
   */
  @Post('test')
  async test(): Promise<B2Verdict> {
    const { settings } = await this.resolve();
    if (settings === null) {
      return {
        ok: false,
        message: 'Nothing to test yet — fill in the key and bucket first.',
        boundTo: null,
      };
    }

    try {
      const auth = Buffer.from(
        `${settings.keyId}:${settings.appKey}`,
      ).toString('base64');

      const res = await fetch(
        'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
        {
          headers: { Authorization: `Basic ${auth}` },
          signal: AbortSignal.timeout(B2_AUTH_TIMEOUT_MS),
        },
      );

      // B2's error replies are JSON too, but if the network breaks it may be
      // HTML; so on a parse failure we quietly use an empty object.
      const body = (await res.json().catch(() => ({}))) as {
        allowed?: { bucketName?: string | null };
        message?: string;
      };

      return b2Verdict(
        { status: res.status, allowed: body.allowed, message: body.message },
        settings.bucket,
      );
    } catch (err) {
      /**
       * Never throws: this is a **test**, and a failed test is not a 500. A 500
       * would show nothing but "something went wrong" on screen, while the
       * real cause is what the owner needs.
       */
      return {
        ok: false,
        message: `Could not reach Backblaze — ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
        boundTo: null,
      };
    }
  }

  private async stored(): Promise<Record<string, string> | null> {
    const row = await this.prisma.setting.findUnique({
      where: { key: OFFSITE_SETTING_KEY },
    });
    return (row?.value as Record<string, string> | undefined) ?? null;
  }

  /**
   * The `.env` names are kept in line with `deploy/offsite-b2.sh`; with
   * different names in two places, finding out "why isn't it working" would
   * take a long time.
   */
  private async resolve() {
    return resolveOffsite(await this.stored(), {
      keyId: process.env.B2_KEY_ID,
      appKey: process.env.B2_APP_KEY,
      bucket: process.env.B2_BUCKET,
    });
  }
}
