import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { ListAlertsDto } from './alerts.dto';
import { AlertsService, type AlertPage, type AlertRow } from './alerts.service';

/**
 * Careful: the whole controller is **owner-only**, set at class level rather
 * than per method. Any endpoint added later is owner-only automatically.
 *
 * Alerts carry hostnames, staff names and device state together. Per spec
 * § 4.3, device/audit-style data is out of the manager's reach.
 */
@Roles(UserRole.owner)
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  /** `GET /api/v1/alerts?status=open&type=agent_down&page=1&limit=50` */
  @Get()
  list(@Query() query: ListAlertsDto): Promise<AlertPage> {
    return this.alerts.list(query);
  }

  /**
   * `POST /api/v1/alerts/acknowledge-all` — mark every open alert as seen at once.
   *
   * Careful: declared **before** `:id/acknowledge`, otherwise `acknowledge-all`
   * could be matched as an `:id` (route matching order).
   */
  @Post('acknowledge-all')
  @HttpCode(HttpStatus.OK)
  acknowledgeAll(@CurrentUser() actor: SessionUser): Promise<{ count: number }> {
    return this.alerts.acknowledgeAll(actor.userId);
  }

  /**
   * `POST /api/v1/alerts/:id/acknowledge` — mark an alert as seen.
   *
   * Careful: alerts are never deleted, only acknowledged. The history of what
   * went wrong is the most useful thing later, especially as evidence for hour
   * adjustments (`time_adjustments.evidence_alert_id`).
   */
  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  acknowledge(
    @CurrentUser() actor: SessionUser,
    @Param('id') id: string,
  ): Promise<AlertRow> {
    return this.alerts.acknowledge(id, actor.userId);
  }
}
