import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CalendarModule } from '../calendar/calendar.module';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

/** First-run setup wizard (an install without an owner) */
@Module({
  imports: [AuthModule, CalendarModule],
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
