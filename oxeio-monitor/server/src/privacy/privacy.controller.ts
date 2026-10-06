import { Body, Controller, Get, Ip, Patch } from '@nestjs/common';
import { UserRole, type Prisma } from '@prisma/client';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { RequiresFeature } from '../features/requires-feature';
import { PrismaService } from '../prisma/prisma.service';
import {
  PRIVACY_SETTING_KEY,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  type PrivacySettings,
} from './privacy.rules';
import { PrivacyService } from './privacy.service';

class SavePrivacyDto {
  @IsOptional() @IsBoolean()
  staffSeeOwnScreenshots?: boolean;

  @IsOptional() @IsInt() @Min(RETENTION_MIN_DAYS) @Max(RETENTION_MAX_DAYS)
  screenshotRetentionDays?: number;
}

interface PrivacyView {
  settings: PrivacySettings;
  /** staff and researcher logins — who "see their own screenshots" affects */
  staffLogins: number;
}

/** Settings → Privacy: the choices inside the Screenshots module. Owner only. */
@Roles(UserRole.owner)
@RequiresFeature('screenshots')
@Controller('settings/privacy')
export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async read(): Promise<PrivacyView> {
    const staffLogins = await this.prisma.user.count({
      where: { isActive: true, role: { in: ['employee', 'researcher'] } },
    });
    return { settings: await this.privacy.get(), staffLogins };
  }

  @Patch()
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SavePrivacyDto,
    @Ip() ip: string,
  ): Promise<PrivacyView> {
    const before = await this.privacy.get();
    const after: PrivacySettings = {
      staffSeeOwnScreenshots: dto.staffSeeOwnScreenshots ?? before.staffSeeOwnScreenshots,
      screenshotRetentionDays: dto.screenshotRetentionDays ?? before.screenshotRetentionDays,
    };

    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(after) as (keyof PrivacySettings)[]) {
      if (after[key] !== before[key]) changed[key] = { from: before[key], to: after[key] };
    }
    if (Object.keys(changed).length > 0) {
      await this.privacy.save(after, actor.userId);
      await this.audit.record({
        userId: actor.userId,
        action: 'change_setting',
        targetType: 'setting',
        targetId: PRIVACY_SETTING_KEY,
        ipAddress: ip,
        meta: { op: 'privacy', ...changed } as Prisma.InputJsonObject,
      });
    }
    return this.read();
  }
}
