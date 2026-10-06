import {
  Body,
  Controller,
  Get,
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
import { RequiresFeature } from '../features/requires-feature';
import {
  DepositsService,
  type DepositBalance,
  type DepositPolicyView,
  type DepositSettlementView,
} from './deposits.service';
import {
  CorrectInstalmentDto,
  SetDepositStartDto,
  SettleDepositDto,
  UpdateDepositPolicyDto,
} from './dto';

/**
 * The owner's side of security deposits (`/api/v1/deposits`).
 *
 * Careful: the whole class is **owner-only**, not even managers — the deposit
 * is part of salary directly, and no salary figure is within a manager's reach
 * ([ADR-023](../../../docs/05-Options-Decisions.md) · ADR-027).
 *
 * Staff see their own deposit at `GET /api/v1/me/deposit` — only **their own**
 * numbers there, nobody else's.
 */
@Roles(UserRole.owner)
@RequiresFeature('deposits')
@Controller('deposits')
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  /** The rule and everyone's deposits — in one call, because the screen shows both together */
  @Get()
  balances(): Promise<{ rows: DepositBalance[]; policy: DepositPolicyView }> {
    return this.deposits.balances();
  }

  @Patch('policy')
  updatePolicy(
    @CurrentUser() actor: SessionUser,
    @Body() dto: UpdateDepositPolicyDto,
    @Ip() ip: string,
  ): Promise<DepositPolicyView> {
    return this.deposits.updatePolicy(actor, dto, ip);
  }

  /**
   * `PATCH /api/v1/deposits/:employeeId/start` — the month this employee's
   * deposit deductions start.
   *
   * Careful: sending `yearMonth: null` goes back to the policy's general start month.
   *
   * Careful: moving the month **forward** removes the earlier instalments from
   * the ledger — that is the real job of this route (correcting a mistake). How
   * many were removed comes back in the response, so the screen can show the
   * owner the truth.
   */
  @Patch(':employeeId/start')
  setStart(
    @CurrentUser() actor: SessionUser,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: SetDepositStartDto,
    @Ip() ip: string,
  ): Promise<{ removed: number; added: number }> {
    return this.deposits.setStartMonth(actor, employeeId, dto.yearMonth, ip);
  }

  /**
   * `POST /api/v1/deposits/:employeeId/settle` — refund or forfeit.
   *
   * Careful: the decision is the owner's; the system only counts the notice
   * days and records them on the row. Careful: a second call gives 409 —
   * otherwise nowhere would record that the money was refunded twice.
   */
  /**
   * `GET /api/v1/deposits/:employeeId/months` — one person's month-by-month ledger.
   *
   * Careful: **without this the owner could not see the ledger itself.** The
   * page had only the total (*"2 months held · ৳500"*), and read together those
   * two numbers can be meaningless — which is what happened in the field (one
   * month was ৳0). Until now the months were visible only on **the employee's
   * own** page (`/me/deposit`).
   */
  @Get(':employeeId/months')
  months(
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ): Promise<unknown> {
    return this.deposits.forEmployee(employeeId);
  }

  /**
   * `PATCH /api/v1/deposits/:employeeId/instalment` — correct a wrong amount.
   *
   * Careful: until now there was **no way to do this** — `ensureLedger()` never
   * updates an existing row (deliberately), so a wrong amount stayed forever.
   * The reason (`reason`) is mandatory, and it is not allowed in a closed
   * month or after settlement.
   */
  @Patch(':employeeId/instalment')
  correct(
    @CurrentUser() actor: SessionUser,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CorrectInstalmentDto,
    @Ip() ip: string,
  ): Promise<{ from: number; to: number }> {
    return this.deposits.correctInstalment(
      actor,
      employeeId,
      dto.yearMonth,
      dto.amountPaisa,
      dto.reason,
      ip,
    );
  }

  @Post(':employeeId/settle')
  @HttpCode(HttpStatus.CREATED)
  settle(
    @CurrentUser() actor: SessionUser,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: SettleDepositDto,
    @Ip() ip: string,
  ): Promise<DepositSettlementView> {
    return this.deposits.settle(actor, employeeId, dto, ip);
  }
}
