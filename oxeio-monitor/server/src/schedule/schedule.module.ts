import { Module } from '@nestjs/common';

import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';

/** Schedule compliance: the day check (written by the roll-up), its screen and the digest block */
@Module({
  controllers: [ScheduleController],
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}
