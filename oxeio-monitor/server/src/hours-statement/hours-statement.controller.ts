import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { UserRole, type PayPeriod } from '@prisma/client';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { RequiresFeature } from '../features/requires-feature';
import { PrismaService } from '../prisma/prisma.service';
import { XLSX_MIME } from '../reports/reports.download';
import {
  HoursStatementService,
  type ComputedLine,
} from './hours-statement.service';
import { StatementDeliveryService } from './statement-delivery.service';
import { statementWorkbook, type StatementDayRow } from './statement-sheet';

class PostedDto {
  /** the value actually posted, when different from the proposal (negative: a statement posted as negative) */
  @IsOptional()
  @IsInt()
  @Min(-100_000)
  @Max(100_000)
  postedMin?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export type LineView = ComputedLine & {
  id: number | null;
  postedMin: number | null;
  postedAt: string | null;
  postedBy: string | null;
  note: string | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The hours statement screen: owner and finance. Hours only — never money.
 * Resend is the owner's (it emails people).
 */
@Roles(UserRole.owner, UserRole.finance)
@RequiresFeature('hoursStatement')
@Controller('hours-statement')
export class HoursStatementController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly statements: HoursStatementService,
    private readonly delivery: StatementDeliveryService,
  ) {}

  @Get('periods')
  async periods() {
    const rows = await this.prisma.payPeriod.findMany({
      orderBy: { startDate: 'desc' },
    });
    return rows.map((p) => this.summaryOf(p));
  }

  @Get('periods/:id')
  async period(@Param('id', ParseIntPipe) id: number) {
    const p = await this.periodOrThrow(id);
    return {
      period: this.summaryOf(p),
      locked: p.snapshotAt ? await this.statements.isLocked(id) : false,
      lines: await this.linesOf(p),
    };
  }

  @Get('periods/:id/people/:employeeId')
  async person(
    @Param('id', ParseIntPipe) id: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ): Promise<StatementDayRow[]> {
    const p = await this.periodOrThrow(id);
    const line = (await this.linesOf(p)).find(
      (l) => l.employeeId === employeeId,
    );
    return line ? this.statements.days([line]) : [];
  }

  @Get('periods/:id/file')
  async file(@Param('id', ParseIntPipe) id: number): Promise<StreamableFile> {
    const p = await this.periodOrThrow(id);
    const start = iso(p.startDate);
    const end = iso(p.endDate);
    const lines = await this.linesOf(p);
    const bytes = await statementWorkbook({
      start,
      end,
      lines,
      days: await this.statements.days(lines),
    });
    return new StreamableFile(bytes, {
      type: XLSX_MIME,
      disposition: `attachment; filename="oxeio-hours-${start}_${end}.xlsx"`,
      length: bytes.byteLength,
    });
  }

  @Post('lines/:id/posted')
  async posted(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PostedDto,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ) {
    await this.statements.markPosted(id, actor, dto.postedMin, dto.note, ip);
    return { ok: true };
  }

  @Delete('lines/:id/posted')
  async unposted(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() actor: SessionUser,
    @Ip() ip: string,
  ) {
    await this.statements.unmarkPosted(id, actor, ip);
    return { ok: true };
  }

  /** Sends the stored statement again — also the way out of no_recipients / not_configured after fixing the settings */
  @Roles(UserRole.owner)
  @Post('periods/:id/resend')
  async resend(@Param('id', ParseIntPipe) id: number) {
    const p = await this.periodOrThrow(id);
    if (!p.snapshotAt)
      throw new NotFoundException(
        'This period is still open — there is nothing to send yet',
      );
    return { status: await this.delivery.deliver(id) };
  }

  /** The open period answers live (computed) lines; a frozen one its stored lines */
  private async linesOf(p: PayPeriod): Promise<LineView[]> {
    if (p.snapshotAt === null) {
      const live = await this.statements.computeLines({
        id: p.id,
        start: iso(p.startDate),
        end: iso(p.endDate),
      });
      return live.map((l) => ({
        ...l,
        id: null,
        postedMin: null,
        postedAt: null,
        postedBy: null,
        note: null,
      }));
    }
    const lines = await this.prisma.payPeriodLine.findMany({
      where: { periodId: p.id },
      include: {
        employee: { select: { fullName: true, empCode: true } },
        postedBy: { select: { fullName: true } },
      },
      orderBy: { employee: { fullName: 'asc' } },
    });
    return lines.map((l) => ({
      id: l.id,
      employeeId: l.employeeId,
      empCode: l.employee.empCode,
      fullName: l.employee.fullName,
      fromDate: iso(l.fromDate),
      toDate: iso(l.toDate),
      measuredSec: l.measuredSec,
      carryInSec: l.carryInSec,
      toPostMin: l.toPostMin,
      leaveDays: l.leaveDays,
      holidayDays: l.holidayDays,
      noDataDays: l.noDataDays,
      postedMin: l.postedMin,
      postedAt: l.postedAt?.toISOString() ?? null,
      postedBy: l.postedBy?.fullName ?? null,
      note: l.note,
    }));
  }

  private async periodOrThrow(id: number) {
    const p = await this.prisma.payPeriod.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Pay period not found');
    return p;
  }

  private summaryOf(p: PayPeriod) {
    return {
      id: p.id,
      start: iso(p.startDate),
      end: iso(p.endDate),
      open: p.snapshotAt === null,
      snapshotAt: p.snapshotAt?.toISOString() ?? null,
      deliveryStatus: p.deliveryStatus,
      sentAt: p.sentAt?.toISOString() ?? null,
      deliveryError: p.deliveryError,
    };
  }
}
