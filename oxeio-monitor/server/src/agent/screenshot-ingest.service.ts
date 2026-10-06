import { join } from 'node:path';

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type Device } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  SCREENSHOT_STORAGE,
  type ScreenshotStorage,
} from '../storage/screenshot-storage';
import {
  checkThumb,
  thumbPathFor,
  type ThumbCandidate,
} from '../screenshots/thumb';
import {
  ALLOWED_SCREENSHOT_MIME,
  MAX_SCREENSHOT_BYTES,
} from './agent.constants';
import { ClockDriftService, type Drift } from './clock-drift.service';
import type { ScreenshotMetaDto } from './dto';
import { workPathParts, workDateOf } from './util/work-time';

export interface ScreenshotResult {
  accepted: number;
  duplicate: boolean;
  path: string;
  /** Whether a thumbnail was stored; null means the gallery falls back to the full image (A06). */
  thumbPath: string | null;
}

@Injectable()
export class ScreenshotIngestService implements OnModuleInit {
  private readonly logger = new Logger(ScreenshotIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockDriftService,
    @Inject(SCREENSHOT_STORAGE) private readonly storage: ScreenshotStorage,
  ) {}

  /**
   * **G81 - check at startup that storage is writable.**
   *
   * On the VPS the gallery once showed *"10 this day"* while all ten were broken
   * icons. The cause: the host's `.data/storage` folder belonged to **root**,
   * while the container runs as `node` (uid 1000). Careful: the Dockerfile's
   * `chown -R node:node` does not help, since a bind mount covers the image's
   * folder **together with its ownership**.
   *
   * Careful: the real offence was the **silence**. Permission denied is a loud
   * error, yet the server came up happily and silently lost every image. If
   * storage cannot be written, the product's **core job does not work**, and
   * staying up is only confusing.
   *
   * So it stops just as `SignedUrlService` does on a weak secret.
   *
   * **The probe writes inside the root, not just `access()`**: `access(W_OK)`
   * looks at the folder's mode bits, but with a read-only mount, a full disk or
   * an SELinux label it can **report success** and writes still fail later. An
   * actual write is the only real proof.
   */
  async onModuleInit(): Promise<void> {
    // the probe itself is the driver's (local folder or S3 bucket); the
    // reasoning above holds for both — fail at startup, not one shot at a time
    await this.storage.probe();
    this.logger.log(`Screenshot storage is writable: ${this.storage.location}`);
  }

  /**
   * @param thumb Optional 320px thumbnail; the agent sends it in a second
   *   multipart part named `thumb` (A06). If absent (an old agent), nothing breaks.
   *
   *   **Why the agent makes it, not the server**: Node has no way to decode
   *   WebP. `sharp` is not installed and new dependencies are forbidden; `pngjs`
   *   exists, but it understands only PNG, and the agent sends WebP (ADR-007).
   *   The agent already has SkiaSharp and already downsizes to 1920px before
   *   encoding (`WebpEncoder.cs`), so producing 320px from the same surface is
   *   nearly free for it. Bonus: the thumbnail is also made before the network
   *   hop, so the server CPU does not see a wave of resizes from 15 PCs.
   */
  async ingest(
    device: Device,
    drift: Drift,
    meta: ScreenshotMetaDto,
    file: Express.Multer.File,
    thumb?: Express.Multer.File,
  ): Promise<ScreenshotResult> {
    if (!meta.clientUuid) {
      throw new UnprocessableEntityException('client_uuid is missing from meta');
    }
    if (device.employeeId === null) {
      throw new UnprocessableEntityException(
        'This device is not linked to any staff member',
      );
    }
    if (file.mimetype !== ALLOWED_SCREENSHOT_MIME) {
      throw new BadRequestException(
        `Only ${ALLOWED_SCREENSHOT_MIME} is accepted (ADR-007), got ${file.mimetype}`,
      );
    }
    if (file.size > MAX_SCREENSHOT_BYTES) {
      throw new BadRequestException('Image is larger than 5 MB');
    }

    const capturedAt = this.clock.correct(meta.capturedAt, drift);
    const slotStart = this.clock.correct(meta.slotStart, drift);
    const workDate = workDateOf(capturedAt);

    // D:\oXeio\storage\screenshots\YYYY\MM\DD\emp-003\093147_m0.webp
    // Folders by date, so the 90-day retention is just deleting folders (ADR-006).
    const { year, month, day, hhmmss } = workPathParts(capturedAt);
    const emp = `emp-${String(device.employeeId).padStart(3, '0')}`;
    const relPath = join(
      'screenshots',
      year,
      month,
      day,
      emp,
      `${hhmmss}_m${meta.monitorIndex}.webp`,
    ).replace(/\\/g, '/');

    // Careful: `let`, because the id is needed outside the try: the thumbnail
    //    UPDATE needs a `where`. `file_path` is **not** unique (see the schema),
    //    so updating by path would make Prisma throw.
    let screenshotId: bigint;

    try {
      // DB first; if it hits the UNIQUE constraint we do not write a pointless file.
      const created = await this.prisma.screenshot.create({
        select: { id: true },
        data: {
          employeeId: device.employeeId,
          deviceId: device.id,
          clientUuid: meta.clientUuid,
          workDate,
          slotStart,
          capturedAt,
          monitorIndex: meta.monitorIndex,
          filePath: relPath,
          /**
           * **Always null here**, even when there is a thumbnail. The value is
           *    set below, **after** the file has really reached the disk.
           *
           * Careful: if the path were set here and the write then failed,
           *    `thumb_path` would point to a file that does not exist. The
           *    gallery's `thumbPath ?? filePath` fallback would then **never
           *    run** (the value is not null), and the grid would fill with broken
           *    images. So `thumb_path` reflects **the truth on disk**, not
           *    intent.
           */
          thumbPath: null,
          width: meta.width ?? null,
          height: meta.height ?? null,
          sizeBytes: file.size,
          activeApp: meta.activeApp ?? null,
          activeTitle: meta.activeTitle ?? null,
        },
      });
      screenshotId = created.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // A duplicate on client_uuid or on (device, slot, monitor): either one.
        // The agent retried the upload; nothing is wrong.
        return this.resolveDuplicate(
          device,
          meta,
          slotStart,
          relPath,
          file,
          thumb,
        );
      }
      throw err;
    }

    await this.storage.put(relPath, file.buffer, ALLOWED_SCREENSHOT_MIME);

    const thumbPath = await this.storeThumb(
      screenshotId,
      relPath,
      file.size,
      thumb,
    );

    return { accepted: 1, duplicate: false, path: relPath, thumbPath };
  }

  /**
   * A06 - put the thumbnail on disk and update `thumb_path`.
   *
   * Careful: **this function never throws.** The whole body is in one try/catch
   *    and the catch only logs. The reason is the core condition of A06: *the
   *    image is valuable, the thumbnail is only a convenience*. Whatever stops the
   *    thumbnail from being written (a full disk, folder permissions, an antivirus
   *    lock), the full image is already on disk and in the DB by then. Throwing
   *    here would give the agent a 500, it would retry, and the next time hit a
   *    P2002 duplicate; a perfect upload would be reported as failed just
   *    because a small image could not be made.
   *
   * @returns the stored `thumb_path`, or `null` (the gallery falls back to the full image)
   */
  /**
   * **G81 - "the row exists" and "the file exists" are not the same thing.**
   *
   * The row and the file are written in two places, DB first and disk second. If
   * the disk write fails the row stays, and then this is what happened:
   *
   * ```
   * write fails  ->  agent retries  ->  DB says "the row exists" (P2002)
   *              ->  server returns { accepted: 0, duplicate: true }
   *              ->  agent deletes the image from its outbox
   * ```
   *
   * Careful: **the duplicate path assumed success**. That was reasonable, since
   * it was written for "the agent sent the same image twice". The result: the
   * image was lost for good, the agent was content, the server was content, and
   * the owner saw a broken icon with no visible link to the real cause.
   *
   * Now the server **checks** whether the file really exists, and if not
   * **repairs it**. Merely answering "failed" would make the agent keep the
   * image, but it would hit the same wall every time. Turning the retry into a
   * repair is the real fix.
   */
  private async resolveDuplicate(
    device: Device,
    meta: ScreenshotMetaDto,
    slotStart: Date,
    relPath: string,
    file: Express.Multer.File,
    thumb: Express.Multer.File | undefined,
  ): Promise<ScreenshotResult> {
    /**
     * Careful: either of the two UNIQUE constraints can trigger, so both are
     * looked up: `client_uuid`, and `(device, slot, monitor)`.
     */
    const existing = await this.prisma.screenshot.findFirst({
      where: {
        OR: [
          { clientUuid: meta.clientUuid },
          {
            deviceId: device.id,
            slotStart,
            monitorIndex: meta.monitorIndex,
          },
        ],
      },
      select: { id: true, filePath: true, thumbPath: true },
    });

    // Careful: the row has been deleted in the meantime (retention job, or by
    //    hand). Rare, but then there is nothing to repair; fall back to the old behaviour.
    if (!existing) {
      return { accepted: 0, duplicate: true, path: relPath, thumbPath: null };
    }

    /**
     * **`existing.filePath`, not `relPath`**; the two can differ. On a retry
     * where the second of `captured_at` differs, the file name changes too
     * (`hhmmss_m0.webp`). Writing to the new path would leave the row pointing at
     * one file and the bytes in another, recreating exactly the mismatch we are
     * trying to repair.
     */
    if ((await this.storage.size(existing.filePath)) !== null) {
      // The file exists: a true duplicate, the agent can safely delete it.
      return {
        accepted: 0,
        duplicate: true,
        path: existing.filePath,
        thumbPath: existing.thumbPath,
      };
    }
    // The file is missing: the row is an orphan. Repaired below.

    this.logger.warn(
      `Screenshot row ${existing.id} had no file on disk (${existing.filePath}) — healing from agent retry`,
    );

    await this.storage.put(existing.filePath, file.buffer, ALLOWED_SCREENSHOT_MIME);

    const thumbPath = await this.storeThumb(
      existing.id,
      existing.filePath,
      file.size,
      thumb,
    );

    /**
     * `accepted: 1`: from the agent's side this really is accepted, for the first
     * time. So `duplicate: false` too: although the row is old, **the bytes are
     * new**, and the agent's decision (delete from its queue) depends on whether
     * the bytes arrived, not on whether a row existed.
     */
    return {
      accepted: 1,
      duplicate: false,
      path: existing.filePath,
      thumbPath,
    };
  }

  private async storeThumb(
    screenshotId: bigint,
    relPath: string,
    fullSizeBytes: number,
    thumb: Express.Multer.File | undefined,
  ): Promise<string | null> {
    // Old agents send no thumbnail; that is not an error, so nothing is logged.
    if (!thumb) return null;

    try {
      const candidate: ThumbCandidate = {
        mimetype: thumb.mimetype,
        size: thumb.size,
        buffer: thumb.buffer,
      };

      const rejection = checkThumb(candidate, fullSizeBytes);
      if (rejection !== null) {
        // Careful: warn, not error; the upload succeeded. But it cannot be
        //    dropped silently either: if the agent's encoder breaks, this line is
        //    the only thing that will say so.
        this.logger.warn(
          `Thumbnail rejected (${rejection}): ${relPath} — the full screenshot was stored fine`,
        );
        return null;
      }

      const thumbRel = thumbPathFor(relPath);
      if (thumbRel === null) {
        this.logger.error(`Could not derive the thumbnail path: ${relPath}`);
        return null;
      }

      await this.storage.put(thumbRel, thumb.buffer, ALLOWED_SCREENSHOT_MIME);

      // The DB learns of it only after the file has reached disk; the reverse
      //    means a grid of broken images (see the `thumbPath: null` note above).
      await this.prisma.screenshot.update({
        where: { id: screenshotId },
        data: { thumbPath: thumbRel },
      });

      return thumbRel;
    } catch (error) {
      this.logger.warn(
        `Thumbnail not stored: ${relPath} — ${String(error)} · ` +
          `the full screenshot is fine, the gallery will show that`,
      );
      return null;
    }
  }
}
