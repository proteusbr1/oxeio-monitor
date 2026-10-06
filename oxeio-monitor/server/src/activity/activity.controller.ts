import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { Roles } from '../auth/decorators';
import {
  ActivityService,
  type ProductivityReport,
  type TeamReport,
  type TopReport,
} from './activity.service';
import { EmployeeRangeQueryDto, TeamQueryDto, TopQueryDto } from './dto';
import { RequiresFeature } from '../features/requires-feature';

/**
 * Activity reports (`/api/v1/activity/…`).
 *
 * Important: **owner + manager only, at class level** (spec section 4.3: both
 * roles get "reports and exports"). Without `@Roles` the global guard only
 * checks that the caller is logged in, so a `role = employee` portal account
 * could change `?employeeId=` and see a **colleague's full app list**. It sits
 * on the class so that any endpoint added later is locked down automatically.
 *
 * Important: there is **no** path here for staff to view their own data. That
 * would need an "is it their own?" check, and forgetting that check would leak
 * the whole team's data. A self-service view belongs in a separate controller.
 */
@Roles(UserRole.owner, UserRole.manager)
@RequiresFeature('appTracking')
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  /**
   * `GET /api/v1/activity/productivity?employeeId=&from=&to=`
   *
   * Each day's score comes with the **percentage of time that is unclassified**.
   */
  @Get('productivity')
  productivity(
    @Query() query: EmployeeRangeQueryDto,
  ): Promise<ProductivityReport> {
    return this.activity.productivity(query);
  }

  /** `GET /api/v1/activity/top?employeeId=&from=&to=&limit=` */
  @Get('top')
  top(@Query() query: TopQueryDto): Promise<TopReport> {
    return this.activity.top(query);
  }

  /** `GET /api/v1/activity/team?from=&to=&limit=` */
  @Get('team')
  team(@Query() query: TeamQueryDto): Promise<TeamReport> {
    return this.activity.team(query);
  }
}
