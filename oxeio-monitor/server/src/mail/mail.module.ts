import { Global, Module } from '@nestjs/common';

import { Mailer } from './mailer';
import { MailRecipientsController } from './recipients.controller';
import { MailRecipients } from './recipients.service';
import { SmtpSettingsController } from './smtp.controller';

/**
 * Email for every module. Global, like settings and features, so alerts,
 * digests and reports share one transport instead of each providing its own.
 */
@Global()
@Module({
  controllers: [SmtpSettingsController, MailRecipientsController],
  providers: [Mailer, MailRecipients],
  exports: [Mailer, MailRecipients],
})
export class MailModule {}
