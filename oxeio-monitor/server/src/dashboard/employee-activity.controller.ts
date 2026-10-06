import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { Roles } from '../auth/decorators';
import {
  DashboardService,
  type HourlyChart,
  type Timeline,
} from './dashboard.service';
import { WorkDateQueryDto } from './dto';

/**
 * One employee's details for one day.
 *
 * Careful: the path is `employees` — `src/users/employee-portal.controller.ts`
 * uses the same prefix, but only for `POST :id/portal-account`. Method+path
 * differ, so there is no clash; check that file too before adding a new route.
 *
 * Careful: owner + manager only (§ 4.3). `role = employee` must not get in —
 * staff's own view is a separate path, otherwise a staff member could change
 * `:id` and see a colleague's whole day.
 */
@Roles(UserRole.owner, UserRole.manager)
@Controller('employees')
export class EmployeeActivityController {
  constructor(private readonly dashboard: DashboardService) {}

  /** `GET /api/v1/employees/3/timeline?date=2026-08-10` */
  @Get(':id/timeline')
  timeline(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: WorkDateQueryDto,
  ): Promise<Timeline> {
    return this.dashboard.timeline(id, query.date);
  }

  /** `GET /api/v1/employees/3/hourly?date=2026-08-10` */
  @Get(':id/hourly')
  hourly(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: WorkDateQueryDto,
  ): Promise<HourlyChart> {
    return this.dashboard.hourly(id, query.date);
  }
}
