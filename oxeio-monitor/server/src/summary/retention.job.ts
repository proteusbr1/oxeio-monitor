import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service';
import {
  SCREENSHOT_STORAGE,
  isSafeRelPath,
  type ScreenshotStorage,
} from '../storage/screenshot-storage';
import { JOB_TIMEZONE, RunLock, SCHEDULING_ENABLED } from './scheduling';
import { retentionCutoff } from './summary.math';

/** 07 § ১ (locked configuration) — `retention.screenshots_days` */
export const SCREENSHOT_RETENTION_DAYS = 90;

/** এক দফায় কত সারি — বড় করলে একটা ব্যর্থতায় বেশি কাজ হারায় */
const BATCH = 500;

/** অসীম লুপের শেষ প্রতিরোধ (৫ লাখ সারি = কয়েক বছরের ছবি) */
const MAX_BATCHES = 1000;

export interface RetentionResult {
  cutoff: Date | null;
  /** এই দফায় যত সারি "মুছে ফেলার জন্য" মার্ক হলো */
  marked: number;
  filesDeleted: number;
  /** সারি ছিল, ফাইল ছিল না — আগের কোনো অসম্পূর্ণ রানের বাকি কাজ */
  filesMissing: number;
  rowsDeleted: number;
  /** ফাইল মুছতে ব্যর্থ (লক করা?) — সারি রেখে দেওয়া হয়েছে, পরের রানে আবার */
  failed: number;
  /** storage রুটের বাইরের পাথ — মানুষ না দেখলে ঠিক হবে না */
  unsafePaths: number;
  skipped: boolean;
}

/**
 * **K01** — রাত ২টায় ৯০ দিনের পুরোনো স্ক্রিনশট মুছে ফেলা: **DB সারি ও
 * ডিস্কের ফাইল দুটোই**।
 *
 * ⭐ **কোনটা আগে — এই সিদ্ধান্তটাই এই ফাইলের মূল বিষয়।**
 *
 * দুটো সরল পথ, দুটোতেই ক্ষতি:
 *   · DB আগে → ডিস্কে অনাথ ফাইল পড়ে থাকে। কেউ টেরই পায় না, কারণ কোথাও
 *     কোনো সারি নেই যেটা ওই ফাইলের কথা মনে রেখেছে। retention-এর পুরো
 *     উদ্দেশ্যই ছিল ডিস্ক ভরতে না দেওয়া — এই পথে সেটাই ব্যর্থ, আর
 *     ব্যর্থতাটা নীরব।
 *   · ফাইল আগে → সারি থেকে যায়, গ্যালারি ৪০৪ দেখায়। বিরক্তিকর, কিন্তু
 *     দৃশ্যমান এবং সারানো যায়।
 *
 * তৃতীয় পথটাই বেছে নেওয়া হয়েছে, আর schema সেটার জন্য আগেই জায়গা রেখেছে
 * (`screenshots.deleted_at` — "retention job এখানে মার্ক করে, তারপর ফাইল মোছে"):
 *
 *   ১· সারিগুলোতে `deleted_at` বসাও  → ছবি **আগেই** গ্যালারি থেকে উধাও,
 *      কারণ সব পাঠক `deleted_at: null` ফিল্টার করে
 *   ২· ডিস্ক থেকে ফাইল মোছো
 *   ৩· যেগুলোর ফাইল সত্যিই গেছে **শুধু সেগুলোরই** সারি হার্ড-ডিলিট
 *
 * ফলে ভাঙা সারির জানালাটা কখনো দেখাই যায় না, আর অনাথ ফাইলও থাকে না।
 * মাঝপথে প্রসেস মরে গেলে পড়ে থাকে মার্ক-করা সারি (অদৃশ্য, ক্ষতিহীন) —
 * পরের রান ঠিক সেখান থেকেই কাজ শেষ করে। জবটা তাই idempotent।
 */
@Injectable()
export class RetentionJob {
  private readonly logger = new Logger(RetentionJob.name);
  private readonly lock = new RunLock();
  constructor(
    private readonly prisma: PrismaService,
    // local folder or S3 bucket — retention deletes wherever the bytes are
    @Inject(SCREENSHOT_STORAGE) private readonly storage: ScreenshotStorage,
  ) {}

  /** ⚠️ `timeZone` ছাড়া UTC-র রাত ২টা = ঢাকার সকাল ৮টা — অফিস-সময়ে ডিস্ক I/O। */
  @Cron('0 0 2 * * *', {
    name: 'screenshot-retention',
    timeZone: JOB_TIMEZONE,
    disabled: !SCHEDULING_ENABLED,
    waitForCompletion: true,
  })
  async scheduled(): Promise<void> {
    // ⚠️ দ্বিতীয় তালা। এই জবটাই সবচেয়ে ধ্বংসাত্মক — টেস্ট চলাকালীন একবার
    //    টিক করলে ফিক্সচারের ছবি ও ফাইল দুটোই চলে যেত।
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
    const cutoff = retentionCutoff(now, SCREENSHOT_RETENTION_DAYS);

    // ── ধাপ ১ · মার্ক ────────────────────────────────────────────────────
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
     * ⚠️ cursor দিয়ে পাতা ওল্টানো হচ্ছে, `take` দিয়ে বারবার প্রথম ব্যাচ
     * টেনে নয়। কারণ ব্যর্থ সারিগুলো (ফাইল লক) মোছা হয় না — তারা তালিকার
     * শুরুতেই থেকে যেত, আর লুপ চিরকাল একই ৫০০টা সারি নিয়ে ঘুরত।
     *
     * ⚠️ শর্তে `workDate < cutoff`-ও আছে, শুধু `deleted_at IS NOT NULL` নয়।
     * ভবিষ্যতে কেউ যদি "এই ছবিটা মুছে দাও" ফিচার বানিয়ে সদ্য তোলা কোনো
     * ছবিতে `deleted_at` বসায়, retention জব সেটাকে হার্ড-ডিলিট করে ফেলত।
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
         * A06 — ⭐ **দুটো ফাইলই**: ফুল ছবি আর থাম্বনেইল।
         *
         * ⚠️ শুধু `file_path` মুছলে ভুলটা এমন যে বছরখানেক কেউ টেরই পেত না:
         *    সারি যেত, ফুল ছবি যেত, কিন্তু `…/emp-003/thumb/` ফোল্ডারের
         *    ছোট ছবিগুলো ডিস্কে **চিরকাল** থেকে যেত — আর DB-তে তখন এমন
         *    কোনো সারিই নেই যে ওদের কথা মনে রেখেছে। retention-এর একমাত্র
         *    উদ্দেশ্যই ডিস্ক ভরতে না দেওয়া; ওই পথে সেটা নীরবে ব্যর্থ হতো।
         *
         * `thumb_path` null হতে পারে (পুরোনো সারি, বা থাম্বনেইল বানানো
         * যায়নি) — তাই ছেঁকে নেওয়া, ধরে নেওয়া নয়।
         */
        const paths = [row.filePath, row.thumbPath].filter(
          (p): p is string => typeof p === 'string' && p.length > 0,
        );

        if (paths.some((p) => !isSafeRelPath(p))) {
          // ⚠️ সারিটাও মোছা হচ্ছে **না** — মুছে দিলে প্রতিবেদনটা হারিয়ে যেত
          //    আর সমস্যাটা চুপচাপ চাপা পড়ত। প্রতি রানে আবার চেঁচাবে।
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

      // ── ধাপ ৩ · ফাইল সত্যিই গেছে, এবার সারি ───────────────────────────
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
   * ⚠️ ফাইল **নেই** মানে সফল, ব্যর্থ নয় (ENOENT)। আগের কোনো রান ফাইল মুছে
   * সারি মোছার আগেই থেমে গিয়েছিল — এখন সারিটা যেতে দেওয়াই ঠিক। এটাকে
   * ব্যর্থতা ধরলে ওই সারিগুলো চিরকাল আটকে থাকত।
   *
   * ⚠️ অন্য যেকোনো ভুলে (ফাইল লক, পারমিশন) সারিটা **রেখে দেওয়া হয়**।
   * মুছে দিলে ঠিক সেই অনাথ ফাইলটাই তৈরি হতো যেটা এড়াতে এত আয়োজন।
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
