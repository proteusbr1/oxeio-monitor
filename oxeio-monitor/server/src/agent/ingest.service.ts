import { randomUUID } from 'node:crypto';

import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import type { Device, Prisma } from '@prisma/client';

import { AppCategoryService } from '../activity/app-category.service';
import { matchCategory } from '../activity/category-matcher';
import { PrismaService } from '../prisma/prisma.service';
import { ClockDriftService, type Drift } from './clock-drift.service';
import type { AppUsageDto, EventDto, SegmentDto } from './dto';
import { deriveUuid } from './util/derive-uuid';
import { nextLocalMidnight, workDateOf } from './util/dhaka-time';

export interface IngestResult {
  accepted: number;
  duplicates: number;
  /** How many records had to be split because they crossed midnight. */
  split: number;
}

interface Span {
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
}

/** The events that close a session. */
const SESSION_CLOSING = new Set(['logoff', 'shutdown', 'agent_stop']);

/**
 * Prisma's foreign key violation code.
 *
 * Careful: `instanceof PrismaClientKnownRequestError` is not used. It would need
 * a **runtime** import from `@prisma/client`, tying this tightly to the version
 * of the generated client. The code is part of Prisma's public contract, so that
 * is what is checked.
 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2003'
  );
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockDriftService,
    private readonly categories: AppCategoryService,
  ) {}

  /**
   * Spec § 4.1: a record without `client_uuid` is not accepted, and the status is
   * **422**. (ValidationPipe would give 400, so the check is here.)
   */
  private assertClientUuids(items: Array<{ clientUuid?: string }>): void {
    const missing = items.findIndex((i) => !i.clientUuid);
    if (missing >= 0) {
      throw new UnprocessableEntityException(
        `Record ${missing} has no client_uuid — it is required to prevent duplicates`,
      );
    }
  }

  /**
   * § 2.1-a: no record may span two work_dates.
   * The agent is supposed to split them; this is the server's safeguard (for old agents).
   */
  private splitAtMidnight(span: Span): Span[] {
    if (span.endedAt <= span.startedAt) {
      return [{ ...span, endedAt: span.startedAt, durationSec: 0 }];
    }

    const parts: Span[] = [];
    let cursor = span.startedAt;
    const wallMs = span.endedAt.getTime() - span.startedAt.getTime();

    while (cursor < span.endedAt) {
      const boundary = nextLocalMidnight(cursor);
      const end = boundary < span.endedAt ? boundary : span.endedAt;
      const partMs = end.getTime() - cursor.getTime();

      parts.push({
        startedAt: cursor,
        endedAt: end,
        // For an unsplit record the agent's monotonic durationSec is kept (the most exact).
        // When split, it is divided proportionally so the total stays intact.
        durationSec:
          parts.length === 0 && partMs === wallMs
            ? span.durationSec
            : Math.round((span.durationSec * partMs) / wallMs),
      });

      cursor = end;
    }

    return parts;
  }

  /**
   * Which `work_session` the segment goes into.
   *
   * Careful: when the offline queue is replayed (A05), **an older batch can arrive
   * after a newer one**. So "the last open session is the current session" cannot
   * be assumed: doing so lets old data arrive and close the current session at a time
   * in the past (ended_at < started_at). So the session is always looked up by
   * **(device, work_date)**.
   */
  private async resolveSession(
    tx: Prisma.TransactionClient,
    device: Device,
    employeeId: number,
    workDate: Date,
    startedAt: Date,
    endedAt: Date,
  ): Promise<bigint> {
    /**
     * Careful: **`employeeId` is part of the condition too, and that is the most
     * important line here.**
     *
     * It used to match only on (device, date). So if a PC was handed to another
     * employee in the middle of the day, the new employee's segments went into **the
     * previous employee's** session. No error; the timeline just showed one person's
     * work under another's name, and `trackedFromBy()` (which reads `work_sessions`)
     * pushed the real employee's tracking start later.
     *
     * Careful: branch 3 below deliberately does **not** filter by employee: closing
     * a previous day's open session is the device's job, not the employee's.
     */

    // 1. The open session for that same date
    const open = await tx.workSession.findFirst({
      where: { deviceId: device.id, employeeId, workDate, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (open) {
      await this.widen(tx, open, startedAt, endedAt);
      return open.id;
    }

    // 2. A closed session for that date: with a backfill, it goes into that one, not a new session
    const closed = await tx.workSession.findFirst({
      where: { deviceId: device.id, employeeId, workDate },
      orderBy: { startedAt: 'desc' },
    });
    if (closed) {
      await this.widen(tx, closed, startedAt, endedAt);
      return closed.id;
    }

    // 3. Is a session from an earlier date still open? It is closed at **its own**
    //    midnight, not at the new segment's time (§ 2.1-a)
    const stale = await tx.workSession.findFirst({
      where: { deviceId: device.id, endedAt: null, workDate: { lt: workDate } },
      orderBy: { startedAt: 'desc' },
    });
    if (stale) {
      await tx.workSession.update({
        where: { id: stale.id },
        data: {
          endedAt: nextLocalMidnight(stale.startedAt),
          endReason: 'day_rollover',
        },
      });
    }

    const created = await tx.workSession.create({
      data: { employeeId, deviceId: device.id, workDate, startedAt },
    });
    return created.id;
  }

  /**
   * A session's bounds should hold the segments inside it.
   * When an older segment arrives in a backfill, the session start must move back;
   * otherwise the segment falls outside the session on the timeline.
   */
  private async widen(
    tx: Prisma.TransactionClient,
    session: { id: bigint; startedAt: Date; endedAt: Date | null },
    startedAt: Date,
    endedAt: Date,
  ): Promise<void> {
    const data: Prisma.WorkSessionUpdateInput = {};

    if (startedAt < session.startedAt) data.startedAt = startedAt;
    // An open session has no end; it is set at logoff or day-close.
    if (session.endedAt !== null && endedAt > session.endedAt) {
      data.endedAt = endedAt;
    }

    if (Object.keys(data).length > 0) {
      await tx.workSession.update({ where: { id: session.id }, data });
    }
  }

  // ── segments ──────────────────────────────────────────────────────────────

  async ingestSegments(
    device: Device,
    drift: Drift,
    segments: SegmentDto[],
  ): Promise<IngestResult> {
    this.assertClientUuids(segments);
    if (segments.length === 0) return { accepted: 0, duplicates: 0, split: 0 };

    const employeeId = device.employeeId;
    if (employeeId === null) {
      throw new UnprocessableEntityException(
        'This device is not linked to any staff member',
      );
    }

    let split = 0;

    // Create the session and insert the segments in the same transaction;
    // otherwise a failed insert would leave an orphan work_session
    const { count, total } = await this.prisma.$transaction(async (tx) => {
      const rows: Prisma.ActivitySegmentCreateManyInput[] = [];
      const sessionByDate = new Map<number, bigint>();

      /**
       * **Measure the envelope first, then the session** (G164).
       *
       * Careful, the bug this fixes: the session used to be created/widened using the
       * time of the **first** fragment in the batch, and the other fragments went
       * straight into that session on a memo hit; `widen()` never saw them. So the
       * session's own bounds no longer held its segments, although the comment on
       * `widen()` says that is exactly its job.
       *
       * Careful: measured in the field: **7** of 226 sessions were broken, with 52
       * segments and **24.47 hours** outside their own session. The largest was 6 hours
       * (a night lock segment); in another, the session started **8 hours 34 minutes
       * after** its own first segment.
       *
       * Careful, why they arrive out of order: the agent puts each closed segment on a
       * fire-and-forget queue (`AgentHost.Record`), so a small idle row that closes at
       * the same moment can overtake the long lock row.
       *
       * **The memo was not removed**: without it, a 500-segment batch would run
       * `resolveSession` 500 times (1-3 findFirst each) inside one transaction. The
       * cost stays as before: once per date.
       */
      type PreparedPart = {
        workDate: Date;
        part: Span;
        clientUuid: string;
        state: SegmentDto['state'];
        inputScore: number | null;
      };

      const prepared: PreparedPart[] = [];
      const bounds = new Map<
        number,
        { workDate: Date; startedAt: Date; endedAt: Date }
      >();

      for (const seg of segments) {
        const corrected: Span = {
          startedAt: this.clock.correct(seg.startedAt, drift),
          endedAt: this.clock.correct(seg.endedAt, drift),
          durationSec: seg.durationSec,
        };

        const parts = this.splitAtMidnight(corrected);
        if (parts.length > 1) split += parts.length - 1;

        for (const [i, part] of parts.entries()) {
          const workDate = workDateOf(part.startedAt);
          const key = workDate.getTime();

          prepared.push({
            workDate,
            part,
            clientUuid: deriveUuid(seg.clientUuid as string, i),
            state: seg.state,
            inputScore: seg.inputScore ?? null,
          });

          const known = bounds.get(key);
          if (known === undefined) {
            bounds.set(key, {
              workDate,
              startedAt: part.startedAt,
              endedAt: part.endedAt,
            });
            continue;
          }

          if (part.startedAt < known.startedAt) known.startedAt = part.startedAt;
          if (part.endedAt > known.endedAt) known.endedAt = part.endedAt;
        }
      }

      /**
       * Careful: **older dates first.** Branch 3 of `resolveSession()` closes a previous
       * day's open session at **its own** midnight. In the opposite order the new day's
       * session would be created first, and the old day would no longer fall under that
       * branch's `workDate: { lt: ... }` condition.
       */
      for (const key of [...bounds.keys()].sort((a, b) => a - b)) {
        const envelope = bounds.get(key)!;

        sessionByDate.set(
          key,
          await this.resolveSession(
            tx,
            device,
            employeeId,
            envelope.workDate,
            envelope.startedAt,
            envelope.endedAt,
          ),
        );
      }

      for (const p of prepared) {
        rows.push({
          sessionId: sessionByDate.get(p.workDate.getTime())!,
          employeeId,
          deviceId: device.id,
          clientUuid: p.clientUuid,
          workDate: p.workDate,
          state: p.state,
          startedAt: p.part.startedAt,
          endedAt: p.part.endedAt,
          durationSec: p.part.durationSec,
          inputScore: p.inputScore,
          // § 2.1 - only ACTIVE counts, nothing else
          countsAsWork: p.state === 'active',
        });
      }

      const res = await tx.activitySegment.createMany({
        data: rows,
        skipDuplicates: true, // <- client_uuid is UNIQUE, so re-upload is safe
      });

      /**
       * **A late-arriving day must be recounted.**
       *
       * Careful, the bug this fixes: the rollup ran only on **two** days: today (K06,
       * every 15 minutes) and yesterday (K05, at 00:15, **once**). A segment for any
       * other day arriving later was stored here correctly but **never reached
       * `daily_summary`**, and from there the monthly row and the pay deficit.
       *
       * Careful: this is not rare, it is daily: when a PC shuts down in the evening the
       * last segment stays in the outbox and uploads next morning after login, by which
       * time the 00:15 day-close has passed. Measured in the field: in August-September
       * **39 (employee, day) pairs, 17.78 hours** were lost this way.
       *
       * **Today is not marked**: K06 recounts it every 15 minutes anyway, so marking it
       * would do the same work twice. Yesterday and everything before it is marked,
       * because their scheduled chance has already passed.
       *
       * Careful: the mark is set **in the same transaction**. Separately, the segment
       * write could succeed and the mark fail, and then the hours would be lost silently
       * just as before, only more rarely.
       */
      const today = workDateOf(this.clock.correct(new Date(), drift)).getTime();
      const stale = [...sessionByDate.keys()].filter((ms) => ms < today);

      if (stale.length > 0) {
        await tx.summaryDirty.createMany({
          data: stale.map((ms) => ({ workDate: new Date(ms) })),
          // Careful: the same day can arrive again and again; keep the first mark's
          //    `marked_at`, otherwise it would keep sliding back in drain order and
          //    the old day would never get reached
          skipDuplicates: true,
        });
      }

      return { count: res.count, total: rows.length };
    });

    if (split > 0) {
      await this.logSplit(device, employeeId, split);
    }

    return { accepted: count, duplicates: total - count, split };
  }

  private async logSplit(
    device: Device,
    employeeId: number,
    split: number,
  ): Promise<void> {
    this.logger.warn(
      `device ${device.id}: ${split} segment(s) had to be split at midnight on the server — ` +
        'the agent was supposed to split them itself',
    );
    await this.prisma.event.create({
      data: {
        deviceId: device.id,
        employeeId,
        clientUuid: randomUUID(),
        type: 'segment_split',
        occurredAt: new Date(),
        meta: { count: split, by: 'server' },
      },
    });
  }

  // ── app usage ─────────────────────────────────────────────────────────────

  async ingestAppUsage(
    device: Device,
    drift: Drift,
    items: AppUsageDto[],
  ): Promise<IngestResult> {
    this.assertClientUuids(items);
    if (items.length === 0) return { accepted: 0, duplicates: 0, split: 0 };

    const employeeId = device.employeeId;
    if (employeeId === null) {
      throw new UnprocessableEntityException(
        'This device is not linked to any staff member',
      );
    }

    // Careful: resolve the rules once. Awaiting per row would mean 500 cache
    //    checks for a 500-row batch, each one a microtask.
    const rules = await this.categories.rules();

    const rows: Prisma.AppUsageCreateManyInput[] = [];
    let split = 0;

    for (const item of items) {
      const parts = this.splitAtMidnight({
        startedAt: this.clock.correct(item.startedAt, drift),
        endedAt: this.clock.correct(item.endedAt, drift),
        durationSec: item.durationSec,
      });
      if (parts.length > 1) split += parts.length - 1;

      for (const [i, part] of parts.entries()) {
        rows.push({
          employeeId,
          deviceId: device.id,
          clientUuid: deriveUuid(item.clientUuid as string, i),
          workDate: workDateOf(part.startedAt),
          startedAt: part.startedAt,
          endedAt: part.endedAt,
          durationSec: part.durationSec,
          processName: item.processName,
          appName: item.appName ?? null,
          windowTitle: item.windowTitle ?? null,
          // ADR-013 - nothing is stored without a domain
          domain: item.domain ?? null,
          isBrowser: item.isBrowser ?? false,

          /**
           * **R22a** - the state in which the fragment was seen.
           *
           * Careful: an old agent does not send the field, so when `undefined` the column
           * default (`active`) is allowed to apply; forcing `'active'` would make "the agent
           * said so" and "we assumed so" the same thing.
           */
          ...(item.state === undefined ? {} : { segmentState: item.state }),

          // D05 - Careful: the category is set **here**, not when reading. Reports
          //    (D07, D08) group by over about a hundred thousand rows a month;
          //    matching 109 rules each time would make that query unusable.
          //    The price: when rules change, old rows keep the old decision;
          //    hence `AppCategoryService.recategorize()`.
          categoryId: matchCategory(rules, {
            processName: item.processName,
            domain: item.domain,
            windowTitle: item.windowTitle,
          })?.id ?? null,
        });
      }
    }

    const count = await this.insertAppUsage(rows);

    return { accepted: count, duplicates: rows.length - count, split };
  }

  /**
   * Careful: when a category rule is **deleted**, its id stays in the cache, and every
   * insert then violates the foreign key and returns 500 until the TTL expires,
   * i.e. for five minutes none of the 15 PCs' app-usage gets in.
   *
   * No data was lost (a 5xx is transient to the agent, which resends), but a
   * five-minute stall is too heavy a penalty for deleting one rule. So the cache is
   * cleared once and tried again; if it fails a second time, it really is some other
   * problem, and that should propagate.
   */
  private async insertAppUsage(
    rows: Prisma.AppUsageCreateManyInput[],
  ): Promise<number> {
    try {
      const { count } = await this.prisma.appUsage.createMany({
        data: rows,
        skipDuplicates: true,
      });
      return count;
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;

      this.logger.warn(
        'Category rules changed — dropping the cache and retrying',
      );
      this.categories.invalidate();

      const rules = await this.categories.rules();
      const retried = rows.map((row) => ({
        ...row,
        categoryId:
          matchCategory(rules, {
            processName: row.processName,
            domain: row.domain ?? null,
            windowTitle: row.windowTitle ?? null,
          })?.id ?? null,
      }));

      const { count } = await this.prisma.appUsage.createMany({
        data: retried,
        skipDuplicates: true,
      });
      return count;
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  async ingestEvents(
    device: Device,
    drift: Drift,
    events: EventDto[],
  ): Promise<IngestResult> {
    this.assertClientUuids(events);
    if (events.length === 0) return { accepted: 0, duplicates: 0, split: 0 };

    const rows: Prisma.EventCreateManyInput[] = events.map((e) => ({
      deviceId: device.id,
      employeeId: device.employeeId,
      clientUuid: e.clientUuid as string,
      type: e.type,
      occurredAt: this.clock.correct(e.occurredAt, drift),
      meta: (e.meta ?? undefined) as Prisma.InputJsonValue | undefined,
    }));

    const { count } = await this.prisma.event.createMany({
      data: rows,
      skipDuplicates: true,
    });

    await this.applySessionEffects(device, rows);

    return { accepted: count, duplicates: rows.length - count, split: 0 };
  }

  /**
   * On logoff / shutdown / agent_stop the open session is closed;
   * otherwise `ended_at` would stay NULL forever (G24).
   */
  private async applySessionEffects(
    device: Device,
    rows: Prisma.EventCreateManyInput[],
  ): Promise<void> {
    const closing = rows
      .filter((r) => SESSION_CLOSING.has(r.type))
      .sort(
        (a, b) =>
          new Date(a.occurredAt as Date).getTime() -
          new Date(b.occurredAt as Date).getTime(),
      )
      .pop();

    if (!closing) return;

    const at = closing.occurredAt as Date;
    const workDate = workDateOf(at);

    /**
     * That day's session: closed at the event's time.
     *
     * **But never before its own start** (G165).
     *
     * Careful, the bug this fixes: if a stop event gets stuck in the outbox (the
     * first attempt fails after a reboot, before the network is up), the `SyncWorker`
     * sends **segments first** and the event later on the next cycle. By then the day's
     * session has been created in the post-reboot period, and the **older** shutdown
     * event arriving after it would close it **before its own start**, i.e.
     * `ended_at < started_at`, a session of negative length.
     *
     * Careful: it has not happened in the field yet, but it was missed by 3 minutes
     * 30 seconds on 24 August (device 25: event 09:59:14, session start 10:01:38; if
     * the two batches arrive in reverse order that is a -144 second session). And
     * late stop events are not rare: over 3 weeks, **50** of 364 were more than a
     * minute late, up to 50 minutes.
     *
     * Careful: **it is dropped, not clamped.** Setting `max(at, startedAt)` would put a
     * zero length and a false `end_reason: shutdown` on a session that is still
     * running. Being left open is not a loss: the 00:15 day-close closes it at its own
     * midnight with `day_rollover`.
     *
     * Careful: the comparison is **moment against moment** (`startedAt` vs `at`), not
     * against the label: compared with `workDate`, that would read as 6 am Dhaka time,
     * and almost every valid close would be dropped too.
     */
    await this.prisma.workSession.updateMany({
      where: {
        deviceId: device.id,
        workDate,
        endedAt: null,
        startedAt: { lte: at },
      },
      data: {
        endedAt: at,
        endReason: closing.type === 'logoff' ? 'logoff' : 'shutdown',
      },
    });

    // Careful: a session left open from a previous day must not be closed with
    //    today's logoff, or a one-day session would look two days long.
    //    Each one is closed at **its own** midnight.
    const stale = await this.prisma.workSession.findMany({
      where: { deviceId: device.id, endedAt: null, workDate: { lt: workDate } },
      select: { id: true, startedAt: true },
    });

    for (const s of stale) {
      await this.prisma.workSession.update({
        where: { id: s.id },
        data: {
          endedAt: nextLocalMidnight(s.startedAt),
          endReason: 'day_rollover',
        },
      });
    }
  }
}
