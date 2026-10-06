import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service';
import { PrivacyService } from '../privacy/privacy.service';
import {
  SCREENSHOT_STORAGE,
  isSafeRelPath,
  type ScreenshotStorage,
} from '../storage/screenshot-storage';
import { JOB_TIMEZONE, RunLock, SCHEDULING_ENABLED } from './scheduling';
import { retentionCutoff } from './summary.math';


/** Rows per pass; a bigger batch loses more work on a single failure. */
const BATCH = 500;

/** Last defence against an endless loop (500,000 rows = several years of photos). */
const MAX_BATCHES = 1000;

export interface RetentionResult {
  cutoff: Date | null;
  /** Rows marked "to delete" in this pass. */
  marked: number;
  filesDeleted: number;
  /** The row existed but the file did not: leftover from an earlier incomplete run. */
  filesMissing: number;
  rowsDeleted: number;
  /** File could not be deleted (locked?); the row is kept for the next run. */
  failed: number;
  /** Path outside the storage root; needs a human to look at it. */
  unsafePaths: number;
  skipped: boolean;
}

/**
 * **Retention**: at 2 am, delete screenshots older than 90 days, **both the
 * DB row and the file on disk**.
 *
 * **Which goes first is the main subject of this file.**
 *
 * Two simple orders, both harmful:
 *   - DB first -> an orphan file stays on disk. Nobody notices, because no
 *     row remembers that file. The whole purpose of retention was to keep the
 *     disk from filling up; this order defeats it, silently.
 *   - File first -> the row stays and the gallery shows 404. Annoying, but
 *     visible and fixable.
 *
 * A third order was chosen, and the schema already has room for it
 * (`screenshots.deleted_at`: "the retention job marks here, then deletes the file"):
 *
 *   1. Set `deleted_at` on the rows -> the photo **immediately** disappears
 *      from the gallery, since every reader filters `deleted_at: null`
 *   2. Delete the files from disk
 *   3. Hard-delete the rows **only for those whose file really went**
 *
 * So the window with a broken row is never visible, and no orphan file is
 * left. If the process dies midway, marked rows remain (invisible, harmless)
 * and the next run finishes from exactly there. The job is therefore idempotent.
 */
@Injectable()
export class RetentionJob {
  private readonly logger = new Logger(RetentionJob.name);
  private readonly lock = new RunLock();
  constructor(
    private readonly prisma: PrismaService,
    // local folder or S3 bucket — retention deletes wherever the bytes are
    @Inject(SCREENSHOT_STORAGE) private readonly storage: ScreenshotStorage,
    private readonly privacy: PrivacyService,
  ) {}

  /** Careful: without `timeZone`, 3 am UTC = 9 am in a UTC+6 zone, disk I/O during office hours. */
  @Cron('0 0 3 * * *', {
    name: 'screenshot-retention',
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    // Careful: second lock. This is the most destructive job: ticking once
    // during a test would remove both the fixture photos and files.
    if (!SCHEDULING_ENABLED) return;
    await this.runOnce();
  }

  async runOnce(now: Date = new Date()): Promise<RetentionResult> {
    const result = await this.lock.run(() => this.purge(now));

    if (result === null) {
      this.logger.warn('Previous retention run still going — skipping this tick');
      return {
        cutoff: null,
        marked: 0,
        filesDeleted: 0,
        filesMissing: 0,
        rowsDeleted: 0,
        failed: 0,
        unsafePaths: 0,
        skipped: true,
      };
    }

    return result;
  }

  private async purge(now: Date): Promise<RetentionResult> {
    // Settings → Privacy (90 days unless the owner changed it). Kept running
    // while the Screenshots module is off: pictures already stored still age out.
    const days = (await this.privacy.get()).screenshotRetentionDays;
    const cutoff = retentionCutoff(now, days);

    // -- Step 1: mark ------------------------------------------------------
    const { count: marked } = await this.prisma.screenshot.updateMany({
      where: { workDate: { lt: cutoff }, deletedAt: null },
      data: { deletedAt: now },
    });

    const result: RetentionResult = {
      cutoff,
      marked,
      filesDeleted: 0,
      filesMissing: 0,
      rowsDeleted: 0,
      failed: 0,
      unsafePaths: 0,
      skipped: false,
    };

    const removedPaths: string[] = [];

    /**
     * Careful: pages are walked with a cursor, not by repeatedly fetching the
     * first batch with `take`. Failed rows (file locked) are not deleted, so
     * they would stay at the head of the list and the loop would spin forever
     * on the same 500 rows.
     *
     * Careful: the condition includes `workDate < cutoff`, not only
     * `deleted_at IS NOT NULL`. If someone later builds a "delete this photo"
     * feature that sets `deleted_at` on a just-taken photo, the retention job
     * would hard-delete it.
     */
    let cursor = 0n;

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const rows = await this.prisma.screenshot.findMany({
        where: {
          deletedAt: { not: null },
          workDate: { lt: cutoff },
          id: { gt: cursor },
        },
        select: { id: true, filePath: true, thumbPath: true },
        orderBy: { id: 'asc' },
        take: BATCH,
      });

      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      const deletable: bigint[] = [];

      for (const row of rows) {
        /**
         * A06: **both files**: the full image and the thumbnail.
         *
         * Careful: deleting only `file_path` would be a mistake nobody would
         * notice for about a year: the row goes, the full image goes, but the
         * small images in the `.../emp-003/thumb/` folder would stay on disk
         * **forever**, and no DB row would remember them. The only purpose of
         * retention is to keep the disk from filling up; this way it would
         * fail silently.
         *
         * `thumb_path` can be null (old rows, or no thumbnail could be made),
         * so it is filtered, not assumed.
         */
        const paths = [row.filePath, row.thumbPath].filter(
          (p): p is string => typeof p === 'string' && p.length > 0,
        );

        if (paths.some((p) => !isSafeRelPath(p))) {
          // Careful: the row is **not** deleted either. Deleting it would lose
          // the report and bury the problem silently. It complains on every run.
          result.unsafePaths++;
          this.logger.error(
            `screenshot ${row.id}: file_path is outside the storage root — left untouched`,
          );
          continue;
        }

        const outcome = await this.removeFiles(paths);
        if (outcome === 'failed') {
          result.failed++;
          continue;
        }

        result.filesDeleted += outcome.deleted;
        result.filesMissing += outcome.missing;
        deletable.push(row.id);
        removedPaths.push(...paths);
      }

      // -- Step 3: files are really gone, now the rows ----------------------
      if (deletable.length > 0) {
        const { count } = await this.prisma.screenshot.deleteMany({
          where: { id: { in: deletable } },
        });
        result.rowsDeleted += count;
      }

      if (batch === MAX_BATCHES - 1) {
        this.logger.warn(
          `retention stopped at ${MAX_BATCHES} batches — the rest tomorrow night`,
        );
      }
    }

    // local: prune the folders left empty; S3: nothing to do
    await this.storage.afterRemove(removedPaths);

    this.logger.log(
      `retention · cutoff ${cutoff.toISOString().slice(0, 10)} · ` +
        `marked ${result.marked} · files ${result.filesDeleted} ` +
        `(missing ${result.filesMissing}) · rows ${result.rowsDeleted}` +
        (result.failed > 0 ? ` · failed ${result.failed}` : '') +
        (result.unsafePaths > 0 ? ` · ⚠️ unsafe paths ${result.unsafePaths}` : ''),
    );

    return result;
  }

  /**
   * Careful: a file that is **missing** counts as success, not failure
   * (ENOENT). An earlier run stopped after deleting the file but before the
   * row, so letting the row go now is right. Treating it as a failure would
   * leave those rows stuck forever.
   *
   * Careful: on any other error (file locked, permissions) the row is **kept**.
   * Deleting it would create exactly the orphan file all this effort avoids.
   */
  private async removeFiles(
    paths: readonly string[],
  ): Promise<'failed' | { deleted: number; missing: number }> {
    let deleted = 0;
    let missing = 0;

    for (const rel of paths) {
      try {
        if ((await this.storage.remove(rel)) === 'missing') {
          missing++;
          continue;
        }
        deleted++;
      } catch (error) {
        this.logger.warn(`Could not delete file: ${rel} — ${String(error)}`);
        return 'failed';
      }
    }

    return { deleted, missing };
  }
}
