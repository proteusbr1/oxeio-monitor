import { Global, Module } from '@nestjs/common';

import { AppSettingsService } from './app-settings.service';
import { SettingsController } from './settings.controller';

/** Dashboard-editable settings — one cached instance for the whole app */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [AppSettingsService],
  exports: [AppSettingsService],
})
export class SettingsModule {}
