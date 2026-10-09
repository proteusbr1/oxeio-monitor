import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { Roles } from '../auth/decorators';
import { ScheduleService } from './schedule.service';

/** The largest id the employees table can hold (int4) — anything above is no one */
const MAX_EMPLOYEE_ID = 2_147_483_647;

/** Who kept the schedule — owner and manager, like the rest of the team screens */
@Roles(UserRole.owner, UserRole.manager)
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get('people')
  people() {
    return this.schedule.people();
  }

  @Get()
  async month(
    @Query('employeeId', ParseIntPipe) employeeId: number,
    @Query('month') month: string,
  ) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) {
      throw new BadRequestException("month must be in 'YYYY-MM' format");
    }
    if (employeeId > MAX_EMPLOYEE_ID) {
      throw new NotFoundException('Employee not found');
    }
    const view = await this.schedule.month(employeeId, month);
    if (!view) throw new NotFoundException('Employee not found');
    return view;
  }
}
