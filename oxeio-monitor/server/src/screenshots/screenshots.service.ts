import type { Readable } from 'node:stream';

import {
  BadRequestException,
  Inject,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';

import { workDateOf } from '../agent/util/work-time';
import { AuditService } from '../audit/audit.service';
import { FeaturesService } from '../features/features.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SCREENSHOT_STORAGE,
  isSafeRelPath,
  type ScreenshotStorage,
} from '../storage/screenshot-storage';
import type { SessionUser } from '../auth/types';
import type { GalleryQueryDto } from './dto';
import { formatWorkDate, pageSlice, parseWorkDate } from './gallery.math';
import { SignedUrlService } from './signed-url.service';

export interface GalleryItem {
  /** Careful: a string, not a number; `screenshots.id` is a BigInt, which JSON cannot carry. */
  id: string;
  employeeId: number;
  empCode: string;
  fullName: string;
  capturedAt: string;
  slotStart: string;
  monitorIndex: number;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  activeApp: string | null;
  /** Careful: only the window title and domain; the full URL is never stored (spec section 7). */
  activeTitle: string | null;
  /** Expires after 5 minutes (I07). */
  thumbUrl: string;
  /** Full image for the lightbox: a separate token, a separate variant. */
  fullUrl: string;
}

export interface GalleryPage {
  date: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: GalleryItem[];
  /**
   * The gallery is for one person whose work policy takes no screenshots
   * (`screenshotsEnabled = false`) — so an empty day is expected, not a fault.
   */
  screenshotsOff: boolean;
}

export interface ResolvedScreenshotFile {
  /** Opened through the screenshot store — a local file or an S3 object */
  stream: Readable;
  sizeBytes: number;
  downloadName: string;
}

/** ADR-007: the agent sends only webp, so this is the only content type. */
export const SCREENSHOT_MIME = 'image/webp';

@Injectable()
export class ScreenshotsService {
  private readonly logger = new Logger(ScreenshotsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly urls: SignedUrlService,
    // ⚠️ the same store ingest writes to (one global instance, StorageModule)
    //    — so uploads and reads can never end up in two different places
    @Inject(SCREENSHOT_STORAGE) private readonly storage: ScreenshotStorage,
    // Settings → Modules › "Screenshots for staff"
    private readonly features: FeaturesService,
  ) {}

  /**
   * E06 — `GET /api/v1/screenshots?employeeId=&date=&page=`
   *
   * Audit (I08) is written here too: building the grid already means the
   * photos have been shown, so the audit is written here, not in the `/file` endpoint.
   */
  async gallery(
    actor: SessionUser,
    query: GalleryQueryDto,
    ip: string,
  ): Promise<GalleryPage> {
    const workDate = this.resolveDate(query.date);
    const employeeId = await this.scopeFor(actor, query.employeeId);

    const where: Prisma.ScreenshotWhereInput = {
      workDate,
      // Careful: the retention job sets `deleted_at` first and deletes the file
      // later (ADR-006). Without this condition the gallery would show rows whose photo is a 404.
      deletedAt: null,
      ...(employeeId === null ? {} : { employeeId }),
    };

    const total = await this.prisma.screenshot.count({ where });
    const slice = pageSlice(query.page ?? 1, total);

    const rows = await this.prisma.screenshot.findMany({
      where,
      // Careful: `capturedAt` can tie (two monitors in one slot, or the same
      // millisecond). Without a total order the same photo could appear on two
      // pages and another on none, silently.
      orderBy: [{ capturedAt: 'asc' }, { monitorIndex: 'asc' }, { id: 'asc' }],
      skip: slice.skip,
      take: slice.take,
      select: {
        id: true,
        employeeId: true,
        capturedAt: true,
        slotStart: true,
        monitorIndex: true,
        width: true,
        height: true,
        sizeBytes: true,
        activeApp: true,
        activeTitle: true,
        // Careful: only name and code from the employee. `monthly_salary` is
        // not selected here; salary belongs only to the payroll endpoint (ADR-023).
        employee: { select: { empCode: true, fullName: true } },
      },
    });

    const items: GalleryItem[] = rows.map((r) => ({
      id: r.id.toString(),
      employeeId: r.employeeId,
      empCode: r.employee.empCode,
      fullName: r.employee.fullName,
      capturedAt: r.capturedAt.toISOString(),
      slotStart: r.slotStart.toISOString(),
      monitorIndex: r.monitorIndex,
      width: r.width,
      height: r.height,
      sizeBytes: r.sizeBytes,
      activeApp: r.activeApp,
      activeTitle: r.activeTitle,
      thumbUrl: this.urls.urlFor(r.id, 'thumb', actor.userId),
      fullUrl: this.urls.urlFor(r.id, 'full', actor.userId),
    }));

    await this.recordView(actor, ip, workDate, slice.page, employeeId, rows);

    return {
      date: formatWorkDate(workDate),
      page: slice.page,
      pageSize: slice.pageSize,
      total,
      totalPages: slice.totalPages,
      items,
      screenshotsOff:
        employeeId === null ? false : !(await this.screenshotsEnabledFor(employeeId)),
    };
  }

  /**
   * I07 — `GET /api/v1/screenshots/:id/file?token=`
   *
   * Careful: this route needs no session (`@Public()`); **the token is the
   * identity**. Photos load through `<img src="...">`, where custom headers
   * cannot be set. So the permission check has already happened, when the
   * token was created (gallery). Staff only get tokens for their own photos,
   * so they cannot create a link to anyone else's (J05).
   */
  async resolveFile(
    idParam: string,
    token: string,
  ): Promise<ResolvedScreenshotFile> {
    if (!/^\d{1,19}$/.test(idParam)) {
      throw new BadRequestException('Screenshot id must be a number');
    }

    const result = this.urls.verify(token);
    if (!result.ok) {
      throw new ForbiddenException(
        result.reason === 'expired'
          ? 'This link has expired (5 minutes) — refresh the gallery'
          : 'This link is invalid',
      );
    }

    // Careful: the id in the token must be compared with the id in the path.
    // Otherwise someone could take a valid token, change `:id`, and fetch
    // **any** screenshot, and the signature would still say "valid", because
    // the signature belongs to the token, not the path.
    const { screenshotId, variant, viewerUserId } = result.claims;
    if (screenshotId !== BigInt(idParam)) {
      throw new ForbiddenException('This token is not for this screenshot');
    }

    const shot = await this.prisma.screenshot.findFirst({
      where: { id: screenshotId, deletedAt: null },
      select: { id: true, filePath: true, thumbPath: true, employeeId: true },
    });
    if (!shot)
      throw new NotFoundException('Screenshot does not exist or has been deleted');

    /**
     * A06: **the thumbnail is always optional**, at both levels:
     *
     *   1. `thumb_path` is null: an old row, or an agent that does not send
     *      thumbnails yet. The full image goes, exactly as before.
     *   2. The path exists but the file is missing on disk: if a backup
     *      restore left out the `thumb/` folder (see thumb.ts; leaving it out
     *      is deliberate), exactly this happens. Without a fallback here the
     *      whole gallery would fill with broken images while the full images
     *      sat fine on disk.
     *
     * Careful: this is **not** an exception to the rule of signing the
     * `variant`. Dropping from thumb to full is the server's own decision, and
     * only **downwards**: nobody can trigger it by fiddling with the URL, and a
     * full token never turns into a thumb. The risk is "everyone downloaded a
     * few more bytes", not "someone saw what they should not".
     */
    const wantsThumb = variant === 'thumb' && shot.thumbPath !== null;
    const relPath = wantsThumb ? shot.thumbPath! : shot.filePath;

    const found = await this.openInStorage(shot.id, relPath);

    if (found === null && wantsThumb) {
      this.logger.warn(
        `screenshot ${shot.id.toString()}: no thumbnail (${relPath}) — served the full image`,
      );
      const full = await this.openInStorage(shot.id, shot.filePath);
      if (full === null) throw new NotFoundException('Image file not found');

      this.logger.debug(
        `screenshot ${shot.id.toString()} (thumb→full) served, token was created by user ${viewerUserId}`,
      );
      return {
        stream: full.stream,
        sizeBytes: full.sizeBytes,
        downloadName: `${shot.id.toString()}_${variant}.webp`,
      };
    }

    if (found === null) {
      throw new NotFoundException('Image file not found');
    }

    const { stream, sizeBytes } = found;

    this.logger.debug(
      `screenshot ${shot.id.toString()} (${variant}) served, token was created by user ${viewerUserId}`,
    );

    return {
      stream,
      sizeBytes,
      downloadName: `${shot.id.toString()}_${variant}.webp`,
    };
  }

  // -- Internal helpers -----------------------------------------------

  /**
   * Checks the path is inside the storage root, then whether the file exists.
   *
   * Careful: outside the root it throws a 404 directly, not `null`. The
   * difference matters: "file missing" lets a thumbnail **fall back** to the
   * full image, but "suspicious path" must never fall back anywhere. Merging
   * the two would let a corrupted `thumb_path` quietly serve the full image,
   * with only a harmless warning in the log.
   *
   * @returns `null` means the path is fine, but the file is not on disk
   */
  private async openInStorage(
    id: bigint,
    relPath: string,
  ): Promise<{ stream: Readable; sizeBytes: number } | null> {
    // ⚠️ the path check from before, now the same for both drivers
    //    (isSafeRelPath); the local driver checks the root again itself
    if (!isSafeRelPath(relPath)) {
      this.logger.error(
        `screenshot ${id.toString()}: path is outside storage: ${relPath}`,
      );
      throw new NotFoundException('Screenshot does not exist');
    }

    const opened = await this.storage.open(relPath);
    if (opened === null) {
      this.logger.warn(
        `screenshot ${id.toString()}: row exists in the DB, but no file in storage (${relPath})`,
      );
    }
    return opened;
  }

  /**
   * Does this person's policy take screenshots? Their own policy, or the
   * active default when they have none — the same rule the agent's config
   * uses (AgentConfigService.build), so the gallery and the PC agree.
   */
  private async screenshotsEnabledFor(employeeId: number): Promise<boolean> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { policy: { select: { screenshotsEnabled: true } } },
    });
    if (employee?.policy) return employee.policy.screenshotsEnabled;

    const fallback = await this.prisma.workPolicy.findFirst({
      where: { isActive: true },
      select: { screenshotsEnabled: true },
    });
    return fallback?.screenshotsEnabled ?? true;
  }

  private resolveDate(iso?: string): Date {
    if (iso === undefined) {
      // Careful: the work zone's "today", not the server's UTC "today"; between
      // local midnight and the zone's offset hour they are two different dates.
      return workDateOf(new Date());
    }
    const parsed = parseWorkDate(iso);
    if (!parsed) throw new BadRequestException('That date is not valid');
    return parsed;
  }

  /**
   * J05: for role=employee, `employeeId` comes **from the session**, not from the query.
   *
   * @returns `null` means no filter (owner/manager: everyone's photos for that day)
   */
  /**
   * Whose pictures this person may see — and, for anyone but the owner and
   * managers, whether staff see their own at all (Settings → Modules ›
   * "Screenshots for staff"; on unless the owner turned it off).
   */
  private async scopeFor(actor: SessionUser, requested?: number): Promise<number | null> {
    const everyone = actor.role === UserRole.owner || actor.role === UserRole.manager;
    if (!everyone && !(await this.features.isOn('staffScreenshots'))) {
      throw new ForbiddenException(
        'Screenshots are not shown to staff on this system. They are still taken; the owner and managers see them.',
      );
    }
    return this.resolveEmployeeScope(actor, requested);
  }

  private resolveEmployeeScope(
    actor: SessionUser,
    requested?: number,
  ): number | null {
    /**
     * Careful: the condition is **"is owner or manager"**, not "is not
     * employee", and the difference is not one of letters but of security.
     *
     * It was caught when `researcher` was added to `UserRole`: the earlier
     * `role !== employee` condition would send any new role **down this
     * branch**, and `null` means *no filter*, so researchers would have seen
     * **everyone's screenshots, for every day**. There would be no compile
     * error, no failing test, and nobody would say anything.
     *
     * Careful: this controller deliberately has **no class-level `@Roles`**
     * (see the comment there), so this line is the only guard; nothing above stops anyone.
     *
     * Rule: write permissions as an **allow list**, not a deny list. Then a
     * new role is **outside** by default, not inside.
     */
    if (actor.role === UserRole.owner || actor.role === UserRole.manager) {
      return requested ?? null;
    }

    if (actor.employeeId === null) {
      // role=employee but not linked to any staff member: a mistake in account
      // creation. Returning an empty list would hide the problem.
      throw new ForbiddenException(
        'This account is not linked to any staff member',
      );
    }

    // Careful: when someone asks for another person's id we do not quietly
    // return their own; the frontend would think the filter worked and show
    // their own photos under another name.
    if (requested !== undefined && requested !== actor.employeeId) {
      throw new ForbiddenException('You can only view your own screenshots');
    }

    return actor.employeeId;
  }

  /**
   * I08: the answer to "who viewed my screenshots" is produced here. For
   * staff, the credibility of the whole system rests on these rows.
   *
   * **One** row per page, not per photo. A grid opens 60 photos at once, so
   * 60 separate rows would write the same fact 60 times; audit_log would only
   * bloat and the real events would get lost in the E11 viewer. Which photos
   * were shown is all in `meta.screenshotIds`.
   *
   * Careful: if nothing is shown (an empty page) nothing is written; nobody saw anything.
   */
  /**
   * **Each employee's newest photo of today** (G159): for the Live Board and
   * Worklog cards.
   *
   * Careful: **the bug this fixes:** the screen used to fetch the gallery's
   * **last one or two pages** (60-120 photos) and pick each employee's newest
   * from inside them. Someone whose last photo fell outside that window (who
   * left early, or a big team) got *"No screenshot yet today"* on their card.
   * Field figures: on the evening of 25 August OX-05 had **114** photos, yet
   * the card said there were none.
   *
   * No guessing here: take each employee's maximum `capturedAt` and fetch
   * exactly those rows.
   *
   * Careful: **audit is still one row, as before**, not one per employee.
   * This path replaces exactly that earlier call, so the *"who viewed my
   * screenshots"* (I08) ledger stays as it was; otherwise opening the board
   * would write 12 rows and fill the ledger with junk.
   */
  async latestPerEmployee(
    actor: SessionUser,
    ip: string,
  ): Promise<{ date: string; items: GalleryItem[] }> {
    const workDate = workDateOf(new Date());

    /**
     * Careful: when an employee calls it, only their own: exactly the gallery's
     * rule. Written separately here, one day one would change and not the other.
     */
    // the same rule as the gallery — a researcher sees only their own too
    const mine = await this.scopeFor(actor);

    const where = {
      workDate,
      deletedAt: null,
      ...(mine === null ? {} : { employeeId: mine }),
    };

    // Step 1: each employee's newest moment.
    const peaks = await this.prisma.screenshot.groupBy({
      by: ['employeeId'],
      where,
      _max: { capturedAt: true },
    });

    if (peaks.length === 0) {
      return { date: formatWorkDate(workDate), items: [] };
    }

    /**
     * Step 2: the rows at exactly those moments.
     *
     * Careful: two photos from two monitors can share a moment, so more than
     * one row can come back; the `reduce` below keeps one per employee.
     */
    const moments = peaks
      .map((p) => p._max.capturedAt)
      .filter((d): d is Date => d !== null);

    const rows = await this.prisma.screenshot.findMany({
      where: { ...where, capturedAt: { in: moments } },
      orderBy: [{ capturedAt: 'desc' }, { monitorIndex: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        employeeId: true,
        capturedAt: true,
        slotStart: true,
        monitorIndex: true,
        width: true,
        height: true,
        sizeBytes: true,
        activeApp: true,
        activeTitle: true,
        employee: { select: { empCode: true, fullName: true } },
      },
    });

    const newest = new Map<number, (typeof rows)[number]>();
    for (const r of rows) {
      const known = newest.get(r.employeeId);
      if (!known || r.capturedAt > known.capturedAt) newest.set(r.employeeId, r);
    }

    const picked = [...newest.values()];

    const items: GalleryItem[] = picked.map((r) => ({
      id: r.id.toString(),
      employeeId: r.employeeId,
      empCode: r.employee.empCode,
      fullName: r.employee.fullName,
      capturedAt: r.capturedAt.toISOString(),
      slotStart: r.slotStart.toISOString(),
      monitorIndex: r.monitorIndex,
      width: r.width,
      height: r.height,
      sizeBytes: r.sizeBytes,
      activeApp: r.activeApp,
      activeTitle: r.activeTitle,
      thumbUrl: this.urls.urlFor(r.id, 'thumb', actor.userId),
      fullUrl: this.urls.urlFor(r.id, 'full', actor.userId),
    }));

    await this.recordView(actor, ip, workDate, 1, mine, picked);

    return { date: formatWorkDate(workDate), items };
  }

  private async recordView(
    actor: SessionUser,
    ip: string,
    workDate: Date,
    page: number,
    employeeId: number | null,
    rows: { id: bigint; employeeId: number }[],
  ): Promise<void> {
    if (rows.length === 0) return;

    const subjects = [...new Set(rows.map((r) => r.employeeId))];

    await this.audit.record({
      userId: actor.userId,
      action: 'view_screenshot',
      // Whose photos: the id if one person is filtered, otherwise E11 looks at meta.
      targetType: 'employee',
      targetId: employeeId ?? undefined,
      ipAddress: ip,
      meta: {
        date: formatWorkDate(workDate),
        page,
        count: rows.length,
        // Careful: giving a BigInt straight to JSON makes Prisma throw; it must be a string.
        screenshotIds: rows.map((r) => r.id.toString()),
        employeeIds: subjects,
        /**
         * Marks viewing one's own photos (J05); E11 can tell these apart.
         *
         * Careful: this used to be `role === employee`, a guess from the role.
         * After the `researcher` role arrived it would have become false:
         * researchers are also measured and view their own photos, yet the
         * audit log would have recorded it as **viewing someone else's**. Now
         * the question is direct: are the rows their own? Whatever the role,
         * the answer does not change.
         */
        self: actor.employeeId !== null && employeeId === actor.employeeId,
      },
    });
  }
}
