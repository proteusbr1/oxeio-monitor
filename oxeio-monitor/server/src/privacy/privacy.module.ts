import { Global, Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';

/** Global, like FeaturesModule: the screenshot routes and the nightly job read it */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [PrivacyController],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
