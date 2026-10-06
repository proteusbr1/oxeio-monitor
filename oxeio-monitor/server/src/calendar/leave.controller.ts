import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { CreateLeaveDto } from './calendar.dto';
import { LeaveService, type LeaveView } from './leave.service';

/**
 * R2: `/api/v1/leaves`.
 *
 * Careful: **owner-only, deliberately matching the screen**: the leave
 * register is in Settings, and the whole Settings page is the owner's. If
 * manager were allowed here, the API would claim an access that has no way
 * of being reached: a false door.
 *
 * To give it to managers, both must change together (this decorator and the
 * `SettingsPage` guard), otherwise another permission with no screen is born.
 *
 * Careful: never staff: writing your own leave means lowering your own target.
 */
@Roles(UserRole.owner)
@Controller('leaves')
export class LeaveController {
  constructor(private readonly leaves: LeaveService) {}

  /** Careful: `?month=YYYY-MM` is mandatory; see the note on `LeaveService.list()` for why */
  @Get()
  list(@Query('month') month: string): Promise<{ rows: LeaveView[] }> {
    return this.leaves.list(month);
  }

  @Post()
  create(
    @CurrentUser() actor: SessionUser,
    @Body() dto: CreateLeaveDto,
    @Ip() ip: string,
  ): Promise<{ created: number; skipped: string[] }> {
    return this.leaves.create(actor, dto, ip);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ): Promise<void> {
    return this.leaves.remove(actor, id, ip);
  }
}
