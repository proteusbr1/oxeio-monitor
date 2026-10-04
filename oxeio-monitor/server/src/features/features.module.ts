import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuditModule } from '../audit/audit.module';
import { FeatureGuard } from './feature.guard';
import { FeaturesController } from './features.controller';
import { FeaturesService } from './features.service';

/**
 * Global, so any module can ask `FeaturesService` whether it is switched on
 * (scheduled jobs, the digest) without importing this one.
 *
 * ⚠️ Import it after `AuthModule`: global guards run in registration order,
 *    and a signed-out request should get 401, not learn which modules exist.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [FeaturesController],
  providers: [FeaturesService, { provide: APP_GUARD, useClass: FeatureGuard }],
  exports: [FeaturesService],
})
export class FeaturesModule {}
