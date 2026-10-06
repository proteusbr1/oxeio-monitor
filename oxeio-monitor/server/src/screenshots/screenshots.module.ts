import { Module } from '@nestjs/common';

import { ScreenshotsController } from './screenshots.controller';
import { ScreenshotsService } from './screenshots.service';
import { SignedUrlService } from './signed-url.service';

/**
 * Screenshot gallery and signed URLs.
 *
 * PrismaModule and AuditModule are both `@Global` and ConfigModule is
 * `isGlobal: true`, so no `imports` are needed here.
 *
 * `SignedUrlService` is exported because the Live Board cards need the same
 * signature to show the latest thumbnail. Nobody should invent their own
 * token format there.
 */
@Module({
  controllers: [ScreenshotsController],
  providers: [ScreenshotsService, SignedUrlService],
  exports: [SignedUrlService],
})
export class ScreenshotsModule {}
