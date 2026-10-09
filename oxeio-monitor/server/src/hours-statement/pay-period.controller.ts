import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Ip,
  Put,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { HoursStatementService } from './hours-statement.service';
import {
  PAY_PERIOD_SETTING_KEY,
  payPeriodProblem,
  type PayPeriodConfig,
} from './pay-period.rules';

/** Cutoff day and send time — owner only */
@Roles(UserRole.owner)
@Controller('settings/pay-period')
export class PayPeriodController {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly statements: HoursStatementService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async read() {
    const config = await this.settings.payPeriod();
    const open = await this.prisma.payPeriod.findFirst({
      where: { snapshotAt: null },
      orderBy: { startDate: 'desc' },
    });
    return {
      ...config,
      open: open
        ? {
            start: open.startDate.toISOString().slice(0, 10),
            end: open.endDate.toISOString().slice(0, 10),
          }
        : null,
    };
  }

  /** The body is checked by `payPeriodProblem` (cutoffDay is a number or 'end') */
  @Put()
  async save(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ) {
    const problem = payPeriodProblem({
      cutoffDay: body.cutoffDay,
      sendTime: body.sendTime,
    });
    if (problem) throw new BadRequestException(problem);
    const next: PayPeriodConfig = {
      cutoffDay: body.cutoffDay as PayPeriodConfig['cutoffDay'],
      sendTime: body.sendTime as string,
    };
    await this.settings.replace(
      PAY_PERIOD_SETTING_KEY,
      { ...next },
      actor.userId,
    );
    await this.statements.reanchorOpen(next.cutoffDay);
    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'setting',
      targetId: PAY_PERIOD_SETTING_KEY,
      ipAddress: ip,
      meta: { ...next },
    });
    return this.read();
  }
}
