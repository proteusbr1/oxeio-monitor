import { Body, Controller, Get, Ip, Patch } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsBoolean, IsOptional } from 'class-validator';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, EveryRole, Roles } from '../auth/decorators';
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
  screenshots?: boolean;

  @IsOptional() @IsBoolean()
  appTracking?: boolean;

  @IsOptional() @IsBoolean()
  tasks?: boolean;

  @IsOptional() @IsBoolean()
  hoursStatement?: boolean;
}

/** What a module already holds — so the owner sees what a switch hides */
interface FeatureUsage {
  /** active people with pay terms set (a salary or an hourly rate) */
  paidStaff: number;
  /** monthly deposit rows ever held, settled or not */
  depositMonths: number;
  /** whether any screenshot is stored (a count would scan a large table) */
  hasScreenshots: boolean;
  /** whether any app or website usage is stored */
  hasAppUsage: boolean;
  /** tasks ever added */
  tasks: number;
  /** active people who receive tasks */
  taskReceivers: number;
}

interface FeaturesSettingsView {
  /** the owner's switches, as saved */
  features: Features;
  /** what is actually on — a child module is off while its parent is */
  effective: Features;
  usage: FeatureUsage;
}

/**
 * Which modules this install shows. Every signed-in user reads it — the
 * sidebar is built from it — but only the owner changes it.
 */
@EveryRole()
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
    const [paidStaff, depositMonths, shot, usage, tasks, taskReceivers] =
      await Promise.all([
        this.prisma.employee.count({
          where: {
            status: 'active',
            OR: [{ monthlySalary: { not: null } }, { hourlyRate: { not: null } }],
          },
        }),
        this.prisma.securityDeposit.count(),
        this.prisma.screenshot.findFirst({ select: { id: true } }),
        this.prisma.appUsage.findFirst({ select: { id: true } }),
        this.prisma.task.count(),
        this.prisma.employee.count({
          where: { status: 'active', receivesTasks: true },
        }),
      ]);

    return {
      features: await this.features.switches(),
      effective: await this.features.all(),
      usage: {
        paidStaff,
        depositMonths,
        hasScreenshots: shot !== null,
        hasAppUsage: usage !== null,
        tasks,
        taskReceivers,
      },
    };
  }

  @Roles(UserRole.owner)
  @Patch('settings/features')
  async save(
    @CurrentUser() actor: SessionUser,
    @Body() dto: SaveFeaturesDto,
    @Ip() ip: string,
  ): Promise<FeaturesSettingsView> {
    const before = await this.features.switches();
    const after: Features = {
      payroll: dto.payroll ?? before.payroll,
      deposits: dto.deposits ?? before.deposits,
      screenshots: dto.screenshots ?? before.screenshots,
      appTracking: dto.appTracking ?? before.appTracking,
      tasks: dto.tasks ?? before.tasks,
      hoursStatement: dto.hoursStatement ?? before.hoursStatement,
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
