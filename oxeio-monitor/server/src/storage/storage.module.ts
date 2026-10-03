import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { storageRoot } from '../common/storage.config';
import { LocalScreenshotStorage } from './local.storage';
import { S3ScreenshotStorage } from './s3.storage';
import {
  SCREENSHOT_STORAGE,
  type ScreenshotStorage,
} from './screenshot-storage';
import { storageSettings } from './storage.config';

/**
 * One screenshot store for the whole app — ingest, gallery, retention and
 * health all get the same instance (`@Inject(SCREENSHOT_STORAGE)`).
 */
@Global()
@Module({
  providers: [
    {
      provide: SCREENSHOT_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ScreenshotStorage => {
        const settings = storageSettings((name) => config.get<string>(name));
        return settings.driver === 's3'
          ? new S3ScreenshotStorage(settings.s3)
          : new LocalScreenshotStorage(storageRoot(config));
      },
    },
  ],
  exports: [SCREENSHOT_STORAGE],
})
export class StorageModule {}
