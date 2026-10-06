import { Controller, Get, Query } from '@nestjs/common';

import { CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { RequiresFeature } from '../features/requires-feature';
import { MyDaysQuery } from './me.dto';
import { MeService, type MyDay, type MySummary } from './me.service';

/**
 * **J04 · J05 · J08** — `GET /api/v1/me/...`, the employee's own data.
 *
 * Important: <b>the class has no `@Roles`, on purpose.</b> All three roles may
 * enter, because the boundary is not the role but the **session**. Which
 * employee's data comes back is decided by `actor.employeeId`, never by a path
 * parameter. Writing `@Roles(employee)` would backfire: an owner or manager who
 * is also an employee (`users.employee_id` set) could not see their own page.
 *
 * Careful: **never** add `:id` to a path. A staff member could change the number
 * and see a colleague's days; this is the only security design of the module.
 */
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  /** Name, today's and this month's hours, signature date, screenshot retention */
  @Get()
  summary(@CurrentUser() actor: SessionUser): Promise<MySummary> {
    return this.me.summary(actor);
  }

  /**
   * `GET /api/v1/me/days?from=2026-08-01&to=2026-08-12`
   *
   * Careful: off days are in the list too (`isOffDay: true`); without them the
   * page could not answer "where is Friday?".
   */
  /**
   * `GET /api/v1/me/deposit` — **R21**, how much of their own deposit has built up.
   *
   * Careful: no `:id` in the path, like everything else; the employee comes from the session.
   */
  @RequiresFeature('deposits')
  @Get('deposit')
  deposit(@CurrentUser() actor: SessionUser) {
    return this.me.myDeposit(actor);
  }

  @Get('days')
  days(
    @CurrentUser() actor: SessionUser,
    @Query() query: MyDaysQuery,
  ): Promise<MyDay[]> {
    return this.me.days(actor, query.from, query.to);
  }
}
