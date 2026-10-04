import { Body, Controller, Get, Ip, Patch } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsBoolean, IsOptional } from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import {
  changedFeatures,
  FEATURES_SETTING_KEY,
  type Features,
} from './features.rules';
import { FeaturesService } from './features.service';

class SaveFeaturesDto {
  @IsOptional() @IsBoolean()
  payroll?: boolean;

  @IsOptional() @IsBoolean()
  deposits?: boolean;

  @IsOptional() @IsBoolean()
  designTargets?: boolean;
}

/** What a module already holds — so the owner sees what a switch hides */
interface FeatureUsage {
  /** active people with a salary set */
  salariedStaff: number;
  /** monthly deposit rows ever held, settled or not */
  depositMonths: number;
  /** design targets ever added */
  designTargets: number;
  /** active people whose work type is designer */
  designers: number;
}

interface FeaturesSettingsView {
  features: Features;
  usage: FeatureUsage;
}

/**
 * Which modules this install shows. Every signed-in user reads it — the
 * sidebar is built from it — but only the owner changes it.
 */
@Controller()
export class FeaturesController {
  constructor(
    private readonly features: FeaturesService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('features')
  read(): Promise<Features> {
    return this.features.all();
  }

  @Roles(UserRole.owner)
  @Get('settings/features')
  async settings(): Promise<FeaturesSettingsView> {
    const [salariedStaff, depositMonths, designTargets, designers] =
      await Promise.all([
        this.prisma.employee.count({
          where: { status: 'active', monthlySalary: { not: null } },
        }),
        this.prisma.securityDeposit.count(),
        this.prisma.designTarget.count(),
        this.prisma.employee.count({
          where: { status: 'active', staffType: 'designer' },
        }),
      ]);

    return {
      features: await this.features.all(),
      usage: { salariedStaff, depositMonths, designTargets, designers },
    };
  }

  @Roles(UserRole.owner)
  @Patch('settings/features')
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveFeaturesDto,
    @Ip() ip: string,
  ): Promise<FeaturesSettingsView> {
    const before = await this.features.all();
    const after: Features = {
      payroll: dto.payroll ?? before.payroll,
      deposits: dto.deposits ?? before.deposits,
      designTargets: dto.designTargets ?? before.designTargets,
    };

    const changed = changedFeatures(before, after);
    if (Object.keys(changed).length > 0) {
      await this.features.save(after, actor.userId);
      await this.audit.record({
        userId: actor.userId,
        action: 'change_setting',
        targetType: 'setting',
        targetId: FEATURES_SETTING_KEY,
        ipAddress: ip,
        meta: { op: 'features', ...changed },
      });
    }

    return this.settings();
  }
}
