import { Controller, Get, Ip, Param, ParseIntPipe, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { EmployeeListQueryDto } from './staff.dto';
import { EmployeesService } from './employees.service';
import type { EmployeeView } from './redact';

/**
 * The subtlest part of the staff module: **the employee list is not owner-only**.
 *
 * Spec section 4.3 says managers see the live view, timeline and reports, and
 * none of those make sense without the list of names. So the two read routes
 * are deliberately **outside** the `@Roles(owner)` class, in a separate
 * controller.
 *
 * Careful: why a separate *file* rather than two classes in one file: someone
 * adding a new endpoint later could put it in the wrong class, and it would
 * silently become reachable by managers. The file name (`-read`) is the
 * reminder of the boundary.
 *
 * Careful: salary is not filtered here by role. It is filtered in
 * `redact.ts`, in one place, and that place has tests.
 */
@Roles(UserRole.owner, UserRole.manager)
@Controller('employees')
export class EmployeesReadController {
  constructor(private readonly employees: EmployeesService) {}

  /** `GET /api/v1/employees?status=active|inactive|all&search=` */
  @Get()
  list(
    @CurrentUser() actor: SessionUser,
    @Query() query: EmployeeListQueryDto,
    @Ip() ip: string,
  ): Promise<{ rows: EmployeeView[]; total: number }> {
    return this.employees.list(actor, query, ip);
  }

  /**
   * `GET /api/v1/employees/next-code`: suggestion for the new-employee form.
   *
   * Careful: this route must come **before** `@Get(':id')`. Nest matches
   * routes top to bottom, so placed below, `next-code` would be taken as `:id`
   * and `ParseIntPipe` would return 400 with "Validation failed (numeric
   * string is expected)", which hides the real cause.
   */
  @Get('next-code')
  nextCode(): Promise<{ code: string }> {
    return this.employees.nextCode();
  }

  /** `GET /api/v1/employees/:id` */
  @Get(':id')
  get(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ): Promise<EmployeeView> {
    return this.employees.get(actor, id, ip);
  }
}
