import { Module } from '@nestjs/common';

import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { AppCategoryService } from './app-category.service';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';

/**
 * App/site categories and reports (D05-D09).
 *
 * Careful: this is a separate module rather than part of `AgentModule`,
 * because the dashboard reports (D07 score, D08 top 10, D09 team) use the same
 * rules and have nothing to do with the agent.
 *
 * `PrismaModule` and `AuditModule` are both `@Global`, so they need no explicit
 * `imports`.
 *
 * Careful: `AppCategoryService` lives **here** and is exported from here.
 * `AgentModule` imports this module, so ingest and D06 share one instance.
 * Otherwise `invalidate()` would clear its own copy's cache while ingest's copy
 * kept using five-minute-old rules ([09 § 3a.11](../../../../docs/09-Build-Log.md)).
 */
@Module({
  controllers: [CategoryController, ActivityController],
  providers: [AppCategoryService, CategoryService, ActivityService],
  exports: [AppCategoryService],
})
export class ActivityModule {}
