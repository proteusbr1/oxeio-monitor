import {
  Controller,
  Get,
  Header,
  Ip,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';

import { CurrentUser, Public } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { GalleryQueryDto, ScreenshotFileQueryDto } from './dto';
import {
  SCREENSHOT_MIME,
  ScreenshotsService,
  type GalleryItem,
  type GalleryPage,
} from './screenshots.service';
import { RequiresFeature } from '../features/requires-feature';

/**
 * `/api/v1/screenshots` (the global prefix is set in app.setup.ts).
 *
 * Careful: there is deliberately no class-level `@Roles(...)`. Owner, manager
 * and staff can all reach this controller (spec section 4.3). What each may
 * see is decided by **scope**, not role (service.resolveEmployeeScope).
 * Writing `@Roles(owner, manager, employee)` here would look like protection
 * while meaning nothing more than "everyone may enter".
 */
@RequiresFeature('screenshots')
@Controller('screenshots')
export class ScreenshotsController {
  constructor(private readonly screenshots: ScreenshotsService) {}

  /** E06 — `GET /api/v1/screenshots?employeeId=&date=&page=` */
  @Get()
  list(
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
    @Query() query: GalleryQueryDto,
  ): Promise<GalleryPage> {
    return this.screenshots.gallery(actor, query, ip);
  }

  /**
   * Latest screenshot of today for each employee:
   * `GET /api/v1/screenshots/latest`.
   *
   * Why a separate route instead of reusing the gallery: the board used to
   * fetch the last one or two gallery pages and pick from them. Anyone whose
   * latest photo fell outside that 60-120 photo window got "No screenshot yet
   * today" on their card even though photos existed (in the field: 114 for
   * OX-05). Guessing from pages was the wrong approach; the question needs
   * its own answer.
   *
   * One audit row, exactly like the gallery call.
   */
  @Get('latest')
  latest(
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ): Promise<{ date: string; items: GalleryItem[] }> {
    return this.screenshots.latestPerEmployee(actor, ip);
  }

  /**
   * I07 — `GET /api/v1/screenshots/:id/file?token=`
   *
   * Careful: `@Public()` means it opens without the session cookie, because a
   * browser cannot send custom headers from `<img src>`. Verification rests
   * entirely on the token, which expires after 5 minutes.
   *
   * Careful: no audit row is written here. It is written when the link is
   * created (in the gallery call). Writing here would count browser cache,
   * prefetch and retries each as "someone viewed", and the only "who" here
   * is the userId inside the token, which was already known at link creation.
   */
  @Public()
  @Get(':id/file')
  // The token lives 5 minutes, so browser caching for that long is harmless;
  // scrolling back in the grid does not re-download each photo. `private`
  // keeps shared proxies from retaining anyone's screenshots.
  @Header('Cache-Control', 'private, max-age=300')
  async file(
    @Param('id') id: string,
    @Query() query: ScreenshotFileQueryDto,
  ): Promise<StreamableFile> {
    const found = await this.screenshots.resolveFile(id, query.token);

    // Careful: stream instead of loading the whole file into memory. With a
    // grid of 60 photos loading at once, readFile would spike the server RAM.
    return new StreamableFile(found.stream, {
      type: SCREENSHOT_MIME,
      disposition: `inline; filename="${found.downloadName}"`,
      length: found.sizeBytes,
    });
  }
}
