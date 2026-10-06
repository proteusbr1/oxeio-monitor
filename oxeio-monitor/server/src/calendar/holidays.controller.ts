import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { CreateHolidayDto, HolidayAutoDto, HolidayListQueryDto, ImportHolidaysDto, ImportPublicHolidaysDto, UpdateHolidayDto } from './calendar.dto';
import type { PublicHolidayCountry } from './public-holidays';
import { AuditService } from '../audit/audit.service';
import { HOLIDAY_SYNC_SETTING_KEY, HolidaySyncService, type HolidaySyncView } from './holiday-sync.service';
import {
  HolidaysService,
  type HolidayImportPlan,
  type HolidayView,
} from './holidays.service';

/**
 * `CRUD /api/v1/holidays`: **owner and manager** (the owner's decision on 15
 * August; it used to be owner-only, spec § 4.2).
 *
 * Careful: before giving this to a manager, know that **holiday dates move
 * money**: adding or removing one date changes that month's workdays (D), and
 * with it `target_sec`, `expected_sec`, `pace_sec` and payroll's `d / D`, all
 * of it. Two things limit the damage: a closed month (E16/R1) can no longer
 * be touched, and every change is written to `audit_log` by name.
 */
@Roles(UserRole.owner, UserRole.manager)
@Controller('holidays')
export class HolidaysController {
  constructor(
    private readonly holidays: HolidaysService,
    private readonly sync: HolidaySyncService,
    private readonly audit: AuditService,
  ) {}

  /** `GET /api/v1/holidays?year=2026` */
  @Get()
  list(@Query() query: HolidayListQueryDto): Promise<{ rows: HolidayView[] }> {
    return this.holidays.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() actor: SessionUser,
    @Body() dto: CreateHolidayDto,
    @Ip() ip: string,
  ): Promise<HolidayView> {
    return this.holidays.create(actor, dto, ip);
  }

  /** The countries the public holiday calendar covers */
  @Get('public/countries')
  countries(): Promise<PublicHolidayCountry[]> {
    return this.holidays.countries();
  }

  /** The automatic update: on or off, which years are done, what the last run did */
  @Get('auto')
  autoStatus(): Promise<HolidaySyncView> {
    return this.sync.view();
  }

  /**
   * Turns the automatic update on or off — the owner's decision, since it
   * adds holidays (and so changes targets) without anyone pressing a button.
   */
  @Roles(UserRole.owner)
  @Patch('auto')
  async setAuto(
    @CurrentUser() actor: SessionUser,
    @Body() dto: HolidayAutoDto,
    @Ip() ip: string,
  ): Promise<HolidaySyncView> {
    const before = await this.sync.view();
    if (before.enabled !== dto.enabled) {
      await this.audit.record({
        userId: actor.userId,
        action: 'change_setting',
        targetType: 'setting',
        targetId: HOLIDAY_SYNC_SETTING_KEY,
        ipAddress: ip,
        meta: { op: 'holidays_auto', enabled: dto.enabled },
      });
    }
    return this.sync.setEnabled(dto.enabled, actor.userId);
  }

  /** "Update now": fills this year and next if they are not done yet */
  @Post('auto/run')
  @HttpCode(HttpStatus.OK)
  async runAuto(): Promise<HolidaySyncView> {
    return (await this.sync.runOnce()) ?? this.sync.view();
  }

  /** A country's public holidays for a year — `dryRun` shows what would happen */
  @Post('public')
  @HttpCode(HttpStatus.OK)
  importPublic(
    @CurrentUser() actor: SessionUser,
    @Body() dto: ImportPublicHolidaysDto,
    @Ip() ip: string,
  ): Promise<HolidayImportPlan> {
    return this.holidays.importPublic(
      actor,
      {
        country: dto.country,
        year: dto.year,
        allowPast: dto.allowPast === true,
        dryRun: dto.dryRun !== false,
      },
      ip,
    );
  }

  /** CSV or ICS calendar — `dryRun` shows what would happen */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  importFile(
    @CurrentUser() actor: SessionUser,
    @Body() dto: ImportHolidaysDto,
    @Ip() ip: string,
  ): Promise<HolidayImportPlan> {
    return this.holidays.importFile(
      actor,
      {
        fileName: dto.fileName,
        content: dto.content,
        allowPast: dto.allowPast === true,
        dryRun: dto.dryRun !== false,
      },
      ip,
    );
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateHolidayDto,
    @Ip() ip: string,
  ): Promise<HolidayView> {
    return this.holidays.update(actor, id, dto, ip);
  }

  /**
   * Careful: this is the only real DELETE in all of E10: no FK points at the
   * holiday row. Even so, the deleted row is kept in the audit meta, because
   * deleting a holiday pushes everyone's pace back for that month.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ): Promise<{ deleted: HolidayView }> {
    return this.holidays.remove(actor, id, ip);
  }
}
