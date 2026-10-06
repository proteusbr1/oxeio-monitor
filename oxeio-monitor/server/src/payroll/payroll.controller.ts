import { Controller, Get, Ip, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { RequiresFeature } from '../features/requires-feature';
import { PayrollService, type PayrollSheet } from './payroll.service';

/**
 * The whole controller is **owner-only**, at class level, not method level.
 * Any endpoint added later is owner-only automatically. Put on a method, a new
 * endpoint would silently end up within a manager's reach.
 */
@Roles(UserRole.owner)
@RequiresFeature('payroll')
@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  /** F03 — `GET /api/v1/payroll?month=2026-08` */
  @Get()
  sheet(
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
    @Query('month') month: string,
  ): Promise<PayrollSheet> {
    return this.payroll.sheet(month, actor.userId, ip);
  }
}
