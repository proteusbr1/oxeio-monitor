import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { CreateEmployeeDto, DeactivateEmployeeDto, PolicySignedDto, UpdateEmployeeDto } from './staff.dto';
import { EmployeesService } from './employees.service';
import type { EmployeeView } from './redact';

/**
 * Staff management, the **write** side. The whole class is owner-only, not
 * per method, so any endpoint added later is automatically owner-only too
 * (spec section 4.3).
 *
 * Two exceptions: managers are allowed on `create` and `update`. Careful: the
 * role is relaxed **on those methods**, not on the class, so `deactivate`,
 * `reactivate`, `policy-signed` and `agent/turn-on` stay owner-only as before,
 * and so will any future route.
 *
 * Careful: the read routes (`GET /employees`) are **not** here. They live in
 * `employees-read.controller.ts` because managers need the list too. An
 * `@Get` in this file would stop managers from even seeing staff names.
 *
 * Careful: there is deliberately no `@Delete` for employees; see `deactivate`
 * below. The only `DELETE` route is on `policy-signed`, and it does not remove
 * an employee row, only clears a wrongly entered date.
 */
@Roles(UserRole.owner)
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  /**
   * `POST /api/v1/employees`
   *
   * Managers may do this too (owner's decision): adding a new employee is a
   * daily task, and having to call the owner for it would block everyone on
   * rollout day.
   *
   * Careful: salary is still owner-only. `EmployeesService` blocks it
   * separately ([ADR-023](../../../docs/05-Options-Decisions.md)). If the
   * role were relaxed here without that block, a manager could **write** a
   * field that they cannot even **read**, which is worse than either option.
   */
  @Roles(UserRole.owner, UserRole.manager)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() actor: SessionUser,
    @Body() dto: CreateEmployeeDto,
    @Ip() ip: string,
  ): Promise<EmployeeView> {
    return this.employees.create(actor, dto, ip);
  }

  /**
   * `PATCH /api/v1/employees/:id`: only the fields sent are changed.
   *
   * Managers may do this too, except salary (see the note on `create`).
   */
  @Roles(UserRole.owner, UserRole.manager)
  @Patch(':id')
  update(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeDto,
    @Ip() ip: string,
  ): Promise<EmployeeView> {
    return this.employees.update(actor, id, dto, ip);
  }

  /**
   * `POST /api/v1/employees/:id/deactivate`
   *
   * Careful: this is used instead of delete. There is no DELETE route so the
   * frontend can never get a "remove" button by mistake. Deleting the row
   * would orphan that employee's monthly totals, screenshots and audit trail.
   */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeactivateEmployeeDto,
    @Ip() ip: string,
  ): Promise<EmployeeView> {
    return this.employees.deactivate(actor, id, dto, ip);
  }

  /** `POST /api/v1/employees/:id/reactivate` */
  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ): Promise<EmployeeView> {
    return this.employees.reactivate(actor, id, ip);
  }

  /**
   * `POST /api/v1/employees/:id/agent/turn-on`: bring back an agent that has
   * been switched off.
   *
   * Careful: it works per employee, not per device. The owner thinks of
   * "Belal's PC", not "device #61".
   */
  @Post(':id/agent/turn-on')
  @HttpCode(HttpStatus.OK)
  turnAgentOn(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ): Promise<{ restored: number }> {
    return this.employees.turnAgentOn(actor, id, ip);
  }

  /**
   * `POST /api/v1/employees/:id/policy-signed`: record the signed monitoring
   * policy.
   *
   * The body is optional: `{ "signedOn": "2026-08-03" }`. Without it, today's
   * work-zone date is used.
   *
   * Careful: this is the only place to record the one rollout precondition
   * ([01 § Rollout](../../../docs/01-Planning.md)). The column existed and was
   * read, but there was no way to set it.
   */
  @Post(':id/policy-signed')
  @HttpCode(HttpStatus.OK)
  policySigned(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PolicySignedDto,
    @Ip() ip: string,
  ): Promise<EmployeeView> {
    return this.employees.setPolicySigned(actor, id, dto.signedOn, ip);
  }

  /**
   * `DELETE /api/v1/employees/:id/policy-signed`: undo a wrongly entered
   * signature.
   *
   * Careful: it does not delete the employee row, only clears the date, and
   * the event is recorded in the audit log as its own action.
   */
  @Delete(':id/policy-signed')
  @HttpCode(HttpStatus.OK)
  clearPolicySigned(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ): Promise<EmployeeView> {
    return this.employees.clearPolicySigned(actor, id, ip);
  }
}
