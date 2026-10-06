import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import {
  type DeviceView,
  DevicesService,
  type EnrollmentCodeResult,
} from './devices.service';
import { CreateEnrollmentCodeDto, DeviceListQueryDto, RestoreDeviceDto, RevokeDeviceDto } from './devices.dto';

/**
 * Device management — the whole class is owner-only.
 *
 * Careful: unlike the employee list, no gap is left here for managers: under
 * spec § 4.3, "Device revoke / audit log" belongs to the owner only.
 */
@Roles(UserRole.owner)
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** `GET /api/v1/devices?employeeId=&status=active|revoked` */
  @Get()
  list(
    @Query() query: DeviceListQueryDto,
  ): Promise<{ rows: DeviceView[]; total: number }> {
    return this.devices.list(query);
  }

  /**
   * `POST /api/v1/devices/enrollment-code` → `{ code, expiresAt }`
   *
   * Careful: written **before** the `:id` routes. There is no clash now (they
   * have two segments), but if someone later adds `POST /devices/:id`, Express
   * would take `enrollment-code` for `:id` — and code creation would silently 404.
   */
  @Post('enrollment-code')
  @HttpCode(HttpStatus.CREATED)
  enrollmentCode(
    @CurrentUser() actor: SessionUser,
    @Body() dto: CreateEnrollmentCodeDto,
    @Ip() ip: string,
  ): Promise<EnrollmentCodeResult> {
    return this.devices.createEnrollmentCode(actor, dto, ip);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): Promise<DeviceView> {
    return this.devices.get(id);
  }

  /** `POST /api/v1/devices/:id/revoke`. Not a delete. */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RevokeDeviceDto,
    @Ip() ip: string,
  ): Promise<DeviceView> {
    return this.devices.revoke(actor, id, dto, ip);
  }

  /** `POST /api/v1/devices/:id/restore` */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RestoreDeviceDto,
    @Ip() ip: string,
  ): Promise<DeviceView> {
    return this.devices.restore(actor, id, dto, ip);
  }
}
