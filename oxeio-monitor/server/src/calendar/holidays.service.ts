import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { workDateOf } from '../agent/util/work-time';
import { ADMIN_TARGET } from '../audit/admin-audit';
import { parseHolidayFile, type ImportResult } from './holiday-import';
import {
  publicHolidayCountries,
  publicHolidays,
  PublicHolidaysError,
  type PublicHolidayCountry,
} from './public-holidays';
import { parseCalendarDate } from './calendar-date';
import type { CreateHolidayDto, HolidayListQueryDto, UpdateHolidayDto } from './calendar.dto';

export interface HolidayImportRow {
  date: string;
  name: string;
  type: string;
  approximate: boolean;
}

export interface HolidayImportPlan {
  /** will be (or were) added */
  add: HolidayImportRow[];
  /** the date is already a holiday — left as it is */
  existing: (HolidayImportRow & { nameInDb: string })[];
  /** current or past month — left out unless allowPast */
  pastMonths: HolidayImportRow[];
  /** lines or events the file could not give — never silent */
  problems: string[];
  /** rows written (0 on a preview) */
  created: number;
}

export interface HolidayView {
  id: number;
  /** 'YYYY-MM-DD' */
  holidayDate: string;
  name: string;
  type: string;
  /** the date is an estimate that may still move */
  approximate: boolean;
}

/**
 * The holiday calendar (owner-only).
 *
 * Careful: this is not a block: if someone works on a holiday their hours are
 * counted in full (see the schema comment). A holiday is used for only two
 * things: marking the day on the heatmap, and counting workdays for pace (§ 2.1(b)).
 */
@Injectable()
export class HolidaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: HolidayListQueryDto): Promise<{ rows: HolidayView[] }> {
    const where: Prisma.HolidayWhereInput = {};

    if (query.year !== undefined) {
      // Careful: `getFullYear()` cannot be used to filter; this has to go into
      // SQL, so the year's bounds are built as two UTC dates. The end is
      // **exclusive**, otherwise 31 December would be dropped or the next 1 January let in.
      where.holidayDate = {
        gte: new Date(Date.UTC(query.year, 0, 1)),
        lt: new Date(Date.UTC(query.year + 1, 0, 1)),
      };
    }

    const rows = await this.prisma.holiday.findMany({
      where,
      orderBy: { holidayDate: 'asc' },
    });

    return { rows: rows.map(toView) };
  }

  async create(
    actor: SessionUser,
    dto: CreateHolidayDto,
    ip: string,
  ): Promise<HolidayView> {
    const holidayDate = this.parse(dto.holidayDate);

    const row = await this.prisma.holiday
      .create({
        data: {
          holidayDate,
          name: dto.name,
          ...(dto.type === undefined ? {} : { type: dto.type }),
          ...(dto.approximate === undefined ? {} : { approximate: dto.approximate }),
        },
      })
      .catch((err: unknown) => {
        throw this.translateDuplicate(err, dto.holidayDate);
      });

    await this.record(actor, ip, row.id, {
      op: 'create',
      holidayDate: dto.holidayDate,
      name: row.name,
    });

    return toView(row);
  }

  /**
   * A calendar from a file (CSV or ICS) — shown first (`dryRun`), then
   * imported.
   *
   * Careful: same rules as the seed (prisma/seed.ts):
   *    · one holiday per date, and a date already in the table is never
   *      changed — a different name is only reported;
   *    · a date in the current or a past month changes that month's
   *      workdays, targets and prorated salary, so it is left out unless
   *      `allowPast` says otherwise, in so many words.
   */
  async importFile(
    actor: SessionUser,
    input: { fileName: string; content: string; allowPast: boolean; dryRun: boolean },
    ip: string,
    now = new Date(),
  ): Promise<HolidayImportPlan> {
    return this.importParsed(
      actor,
      parseHolidayFile(input.fileName, input.content),
      { source: input.fileName.slice(0, 120), allowPast: input.allowPast, dryRun: input.dryRun },
      ip,
      now,
    );
  }

  /**
   * A country's nationwide public holidays for one year, from the public
   * calendar (public-holidays.ts) — same preview and past-month rules as a
   * file.
   */
  async importPublic(
    actor: SessionUser,
    input: { country: string; year: number; allowPast: boolean; dryRun: boolean },
    ip: string,
    now = new Date(),
    fetchImpl: typeof fetch = fetch,
  ): Promise<HolidayImportPlan> {
    let parsed: ImportResult;
    try {
      parsed = await publicHolidays(input.country, input.year, fetchImpl);
    } catch (err) {
      if (err instanceof PublicHolidaysError) throw new BadRequestException(err.message);
      throw err;
    }
    return this.importParsed(
      actor,
      parsed,
      {
        source: `public holidays ${input.country.toUpperCase()} ${input.year}`,
        allowPast: input.allowPast,
        dryRun: input.dryRun,
      },
      ip,
      now,
    );
  }

  /** The countries the public calendar covers — for the country picker */
  countries(fetchImpl: typeof fetch = fetch): Promise<PublicHolidayCountry[]> {
    return publicHolidayCountries(fetchImpl).catch((err: unknown) => {
      if (err instanceof PublicHolidaysError) throw new BadRequestException(err.message);
      throw err;
    });
  }

  /**
   * The nightly automatic update (holiday-sync.service.ts): the same import,
   * done by the system — never into the current or a past month.
   */
  async importPublicAutomatically(country: string, year: number, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<HolidayImportPlan> {
    const parsed = await publicHolidays(country, year, fetchImpl);
    return this.importParsed(
      null,
      parsed,
      { source: `automatic update ${country.toUpperCase()} ${year}`, allowPast: false, dryRun: false },
      null,
      now,
    );
  }

  private async importParsed(
    actor: SessionUser | null,
    { holidays, problems }: ImportResult,
    input: { source: string; allowPast: boolean; dryRun: boolean },
    ip: string | null,
    now: Date,
  ): Promise<HolidayImportPlan> {

    const existing = await this.prisma.holiday.findMany({
      where: { holidayDate: { in: holidays.map((h) => new Date(`${h.entry.date}T00:00:00Z`)) } },
      select: { holidayDate: true, name: true },
    });
    const byDate = new Map(existing.map((r) => [r.holidayDate.toISOString().slice(0, 10), r.name]));
    const thisMonth = workDateOf(now).toISOString().slice(0, 7);

    const plan: HolidayImportPlan = { add: [], existing: [], pastMonths: [], problems, created: 0 };
    for (const { entry, type } of holidays) {
      const row = { date: entry.date, name: entry.name, type, approximate: entry.approximate };
      const inDb = byDate.get(entry.date);
      if (inDb !== undefined) plan.existing.push({ ...row, nameInDb: inDb });
      else if (entry.date.slice(0, 7) <= thisMonth && !input.allowPast) plan.pastMonths.push(row);
      else plan.add.push(row);
    }

    if (input.dryRun || plan.add.length === 0) return plan;

    const { count } = await this.prisma.holiday.createMany({
      data: plan.add.map((h) => ({
        holidayDate: new Date(`${h.date}T00:00:00Z`),
        name: h.name,
        type: h.type,
        approximate: h.approximate,
      })),
      // a row added by someone else meanwhile wins — never overwritten
      skipDuplicates: true,
    });
    plan.created = count;

    await this.record(actor, ip, 0, {
      op: 'import',
      file: input.source,
      created: count,
      allowPast: input.allowPast,
      dates: plan.add.map((h) => h.date),
    });
    return plan;
  }

  async update(
    actor: SessionUser,
    id: number,
    dto: UpdateHolidayDto,
    ip: string,
  ): Promise<HolidayView> {
    const before = await this.prisma.holiday.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Holiday not found');

    const row = await this.prisma.holiday
      .update({
        where: { id },
        data: {
          ...(dto.holidayDate === undefined
            ? {}
            : { holidayDate: this.parse(dto.holidayDate) }),
          ...(dto.name === undefined ? {} : { name: dto.name }),
          ...(dto.type === undefined ? {} : { type: dto.type }),
          ...(dto.approximate === undefined ? {} : { approximate: dto.approximate }),
        },
      })
      .catch((err: unknown) => {
        throw this.translateDuplicate(err, dto.holidayDate ?? '');
      });

    await this.record(actor, ip, id, {
      op: 'update',
      from: toAuditMeta(toView(before)),
      to: toAuditMeta(toView(row)),
    });

    return toView(row);
  }

  /**
   * The real `DELETE` is here: the only one in the whole module.
   *
   * No FK points at `holidays`; the row holds nobody's hours or screenshots.
   *
   * Careful: still not harmless: deleting a holiday raises that month's
   * `expected_workdays`, so at the next rollup everyone's **pace falls
   * behind**, though nobody did anything. So the deleted row's date and name
   * are kept in the audit meta, to answer "why did everyone's pace suddenly
   * drop last Tuesday".
   */
  async remove(
    actor: SessionUser,
    id: number,
    ip: string,
  ): Promise<{ deleted: HolidayView }> {
    const before = await this.prisma.holiday.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Holiday not found');

    await this.prisma.holiday.delete({ where: { id } });

    await this.record(actor, ip, id, {
      op: 'delete',
      deleted: toAuditMeta(toView(before)),
    });

    return { deleted: toView(before) };
  }

  private parse(value: string): Date {
    const parsed = parseCalendarDate(value);
    if (!parsed) {
      throw new BadRequestException('holidayDate is not a valid date');
    }
    return parsed;
  }

  private translateDuplicate(err: unknown, date: string): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException(
        `A holiday has already been set for ${date}`,
      );
    }
    return err;
  }

  /** `actor` null = done by the system (the automatic holiday update) */
  private async record(
    actor: SessionUser | null,
    ip: string | null,
    id: number,
    meta: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.audit.record({
      userId: actor?.userId ?? null,
      action: 'change_setting',
      targetType: ADMIN_TARGET.holiday,
      targetId: id,
      ipAddress: ip,
      meta,
    });
  }
}

/**
 * Careful: `HolidayView` cannot be passed straight into the audit meta:
 * Prisma's `InputJsonValue` wants an index signature, which an interface does
 * not have. So it is flattened into a plain `Record`.
 */
function toAuditMeta(view: HolidayView): Record<string, string | number | boolean> {
  return {
    id: view.id,
    holidayDate: view.holidayDate,
    name: view.name,
    type: view.type,
    approximate: view.approximate,
  };
}

function toView(holiday: {
  id: number;
  holidayDate: Date;
  name: string;
  type: string;
  approximate: boolean;
}): HolidayView {
  return {
    id: holiday.id,
    // `@db.Date` comes as UTC midnight, so the first ten characters of the ISO string are the date
    holidayDate: holiday.holidayDate.toISOString().slice(0, 10),
    name: holiday.name,
    type: holiday.type,
    approximate: holiday.approximate,
  };
}
