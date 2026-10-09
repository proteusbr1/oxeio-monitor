import { Global, Module } from '@nestjs/common';

import { Mailer } from './mailer';

/**
 * Email for every module. Global, like settings and features, so alerts,
 * digests and reports share one transport instead of each providing its own.
 */
@Global()
@Module({
  providers: [Mailer],
  exports: [Mailer],
})
export class MailModule {}
