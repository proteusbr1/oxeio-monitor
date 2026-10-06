import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { CloseMonthDto } from './calendar.dto';
import {
  MonthCloseService,
  type MonthClosureView,
} from './month-close.service';

/**
 * R1: `/api/v1/months`, **owner-only**.
 *
 * Careful: not managers, deliberately: closing a month fixes the basis of
 * pay, and managers do not see payroll numbers at all (§ 4.3). Someone who
 * does not see the result cannot freeze the result either.
 */
@Roles(UserRole.owner)
@Controller('months')
export class MonthCloseController {
  constructor(private readonly months: MonthCloseService) {}

  @Get()
  list(): Promise<{ rows: MonthClosureView[] }> {
    return this.months.list();
  }

  @Post(':yearMonth/close')
  close(
    @CurrentUser() actor: SessionUser,
    @Param('yearMonth') yearMonth: string,
    @Body() dto: CloseMonthDto,
    @Ip() ip: string,
  ): Promise<MonthClosureView> {
    return this.months.close(actor, yearMonth, dto.note, ip);
  }

  /**
   * Careful: `DELETE`, not `POST .../reopen`: reopening means **taking away**
   * the closing record, not creating anything new. Even so, both rows stay in
   * the audit, so history is not erased.
   */
  @Delete(':yearMonth')
  reopen(
    @CurrentUser() actor: SessionUser,
    @Param('yearMonth') yearMonth: string,
    @Ip() ip: string,
  ): Promise<{ yearMonth: string; reopened: true }> {
    return this.months.reopen(actor, yearMonth, ip);
  }
}
