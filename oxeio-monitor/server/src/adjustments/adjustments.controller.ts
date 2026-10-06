import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import {
  CreateAdjustmentDto,
  RevokeAdjustmentDto,
} from './adjustments.dto';
import { AdjustmentsService, type AdjustmentView } from './adjustments.service';

/**
 * **B14 · ADR-011e** - hours adjustments.
 *
 * Careful: the path is `employees/:id/...`, and `/employees` is already claimed
 * by three controllers (`employees`, `employees-read`, `employee-activity`).
 * When Express sees the same path twice it calls **the first one** and the
 * second stays silently dead forever
 * ([09 § 3a.12](../../../docs/09-Build-Log.md)). So the sub-path
 * (`time-adjustments`) exists nowhere else; `endpoints.e2e` guards it.
 */
@Controller('employees')
export class EmployeeAdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  /**
   * **owner-only**. `@Roles` is on the method, not the class, because the `GET`
   * below is also open to staff for their own data (J08). Careful: on the
   * class, staff could not see their own adjustments, breaking the transparency
   * requirement of ADR-011e.
   */
  @Roles(UserRole.owner)
  @Post(':id/time-adjustments')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateAdjustmentDto,
    @Ip() ip: string,
  ): Promise<AdjustmentView> {
    return this.adjustments.create(actor, id, dto, ip);
  }

  /**
   * J08 - owner and manager see everyone's; staff see **only their own**.
   *
   * Careful: there is deliberately **no** `@Roles` here. All three roles may
   * enter, and the limit is enforced in the service (`assertCanSee`). Blocking
   * by role would also block staff from their own data.
   */
  @Get(':id/time-adjustments')
  list(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<AdjustmentView[]> {
    return this.adjustments.list(actor, id);
  }
}

/**
 * Careful: a separate controller, because the revoke path has no employee id.
 * The adjustment's own id is enough, and the server looks up which employee it
 * belongs to.
 */
@Roles(UserRole.owner)
@Controller('time-adjustments')
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  /** Careful: not `DELETE`. The schema has no delete, only revoke; the record stays. */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @CurrentUser() actor: SessionUser,
    @Param('id') id: string,
    @Body() dto: RevokeAdjustmentDto,
    @Ip() ip: string,
  ): Promise<AdjustmentView> {
    /**
     * Careful: not `ParseIntPipe`. `time_adjustments.id` is a `BigInt`, and
     * `parseInt` silently returns a wrong number past 2^53. It would take about
     * ten years to get there, but the bug would then surface at the worst time.
     */
    let parsed: bigint;
    try {
      parsed = BigInt(id);
    } catch {
      throw new BadRequestException('id must be a whole number');
    }

    return this.adjustments.revoke(actor, parsed, dto, ip);
  }
}
