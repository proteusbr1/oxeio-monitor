import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { storageRoot } from '../common/storage.config';
import { AppSettingsService } from '../settings/app-settings.service';
import { LocalScreenshotStorage } from './local.storage';
import { S3ScreenshotStorage } from './s3.storage';
import {
  SCREENSHOT_STORAGE,
  type ScreenshotStorage,
} from './screenshot-storage';

/**
 * One screenshot store for the whole app — ingest, gallery, retention and
 * health all get the same instance (`@Inject(SCREENSHOT_STORAGE)`).
 */
@Global()
@Module({
  providers: [
    {
      provide: SCREENSHOT_STORAGE,
      inject: [ConfigService, AppSettingsService],
      // ⚠️ Read once, at start: saved on Settings → Storage & backup, or
      //    STORAGE_DRIVER / S3_* from the environment. A change on screen
      //    takes effect at the next restart — swapping stores under a
      //    running server would split one day's screenshots across two.
      useFactory: async (
        config: ConfigService,
        settings: AppSettingsService,
      ): Promise<ScreenshotStorage> => {
        const { settings: chosen } = await settings.storage();
        return chosen.driver === 's3'
          ? new S3ScreenshotStorage(chosen.s3)
          : new LocalScreenshotStorage(storageRoot(config));
      },
    },
  ],
  exports: [SCREENSHOT_STORAGE],
})
export class StorageModule {}
