import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { Roles } from '../auth/decorators';
import { DashboardDayService } from './dashboard.day.service';
import { DashboardLiveService } from './dashboard.live.service';
import { DashboardTrendService } from './dashboard.trend.service';
import type { LiveBoard, TeamPulse, TeamTrend } from './dashboard.types';

/**
 * `GET /api/v1/live`
 *
 * Careful: the roles sit at **class level** (§ 4.3 — the live view is for
 * owner and manager). Put on a method, any endpoint added later would
 * silently be open to everyone, including `role = employee`, and staff would
 * see their colleagues' cards.
 */
@Roles(UserRole.owner, UserRole.manager)
@Controller('live')
export class LiveController {
  constructor(
    private readonly liveBoard: DashboardLiveService,
    private readonly day: DashboardDayService,
    private readonly trends: DashboardTrendService,
  ) {}

  @Get()
  live(): Promise<LiveBoard> {
    return this.liveBoard.live();
  }

  /**
   * `GET /api/v1/live/pulse` — the team's daily rhythm, 24 hours.
   *
   * The class-level `@Roles` applies here too (see the note above), so staff
   * cannot see their colleagues' rhythm on this path either.
   *
   * Careful: `date` is optional and validated in `resolveWorkDate` (bad
   * format gives 400). The board does not send it — it always wants today —
   * but the field is kept because "how did yesterday go" is the same chart's
   * job, and no new endpoint would be needed.
   */
  @Get('pulse')
  pulse(@Query('date') date?: string): Promise<TeamPulse> {
    return this.day.teamPulse(date);
  }

  /**
   * `GET /api/v1/live/trend` — the last seven days and the current month.
   *
   * Careful: there is deliberately no `date` field: this is always the last
   * seven days **up to today**. Past weeks belong on the reports page, not
   * the live board.
   */
  @Get('trend')
  trend(): Promise<TeamTrend> {
    return this.trends.teamTrend();
  }
}
