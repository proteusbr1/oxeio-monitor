import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_TARGET } from '../audit/admin-audit';
import type { CreateEnrollmentCodeDto, DeviceListQueryDto, RestoreDeviceDto, RevokeDeviceDto } from './devices.dto';
import {
  enrollmentCodeExpiry,
  formatEnrollmentCode,
  hashEnrollmentCode,
} from './enrollment-code';

/**
 * Whitelist — `tokenHash` is deliberately **not** included.
 *
 * Careful: writing `include: { employee: true }` would send the whole row,
 * including `monthlySalary`. The device list is not for managers, so that is
 * not an immediate danger, but "which endpoint can leak salary" should have
 * one answer: none — only selected fields go out.
 */
const DEVICE_SELECT = {
  id: true,
  hostname: true,
  windowsUsername: true,
  machineGuid: true,
  osVersion: true,
  agentVersion: true,
  monitors: true,
  status: true,
  lastSeenAt: true,
  lastDriftSec: true,
  maxDriftSec: true,
  capabilities: true,
  capabilitiesAt: true,
  enrolledAt: true,
  employee: { select: { id: true, empCode: true, fullName: true } },
} satisfies Prisma.DeviceSelect;

/** The type is derived from the select — a hand-written interface would drift apart */
export type DeviceView = Prisma.DeviceGetPayload<{
  select: typeof DEVICE_SELECT;
}>;

export interface EnrollmentCodeResult {
  /** Careful: sent this one time only — the server keeps just the sha256 */
  code: string;
  expiresAt: string;
  employee: { id: number; empCode: string; fullName: string };
}

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: DeviceListQueryDto,
  ): Promise<{ rows: DeviceView[]; total: number }> {
    const rows = await this.prisma.device.findMany({
      where: {
        ...(query.employeeId === undefined
          ? {}
          : { employeeId: query.employeeId }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      select: DEVICE_SELECT,
      // Silent agents first is the useful order (matches the G01 alert)
      orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
    });

    return { rows, total: rows.length };
  }

  async get(id: number): Promise<DeviceView> {
    const row = await this.prisma.device.findUnique({
      where: { id },
      select: DEVICE_SELECT,
    });
    if (!row) throw new NotFoundException('Device not found');
    return row;
  }

  /**
   * Remotely switch a device off.
   *
   * Careful: not a delete. work_sessions, activity_segments and screenshots
   * are all tied to the device by FK; deleting the row would make someone's
   * month of hours vanish.
   *
   * Careful: `tokenHash` is not erased, only the door is closed —
   * `DeviceAuthGuard` blocks on `status === 'revoked'`. So **restoring wakes
   * the old token again**. If a laptop is lost, do not restore; issue a new
   * enrollment code — enroll upserts by `machineGuid` and replaces tokenHash,
   * and the old token then dies.
   */
  async revoke(
    actor: SessionUser,
    id: number,
    dto: RevokeDeviceDto,
    ip: string,
  ): Promise<DeviceView> {
    const before = await this.prisma.device.findUnique({
      where: { id },
      select: { id: true, hostname: true, status: true },
    });
    if (!before) throw new NotFoundException('Device not found');
    if (before.status === 'revoked') {
      throw new ConflictException('This device has already been revoked');
    }

    const row = await this.prisma.device.update({
      where: { id },
      data: { status: 'revoked' },
      select: DEVICE_SELECT,
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'revoke_device',
      targetType: ADMIN_TARGET.device,
      targetId: id,
      ipAddress: ip,
      meta: { hostname: before.hostname, reason: dto.reason },
    });

    this.logger.warn(`device ${id} (${before.hostname}) revoke — ${dto.reason}`);
    return row;
  }

  /**
   * Switch back on.
   *
   * Careful: the `revoke_device` action is not used here — recording the
   * opposite act under the same action would leave anyone reading the audit
   * log unable to tell which was off and which was on. So `change_setting` +
   * `meta.op = 'restore'`.
   */
  async restore(
    actor: SessionUser,
    id: number,
    dto: RestoreDeviceDto,
    ip: string,
  ): Promise<DeviceView> {
    const before = await this.prisma.device.findUnique({
      where: { id },
      select: { id: true, hostname: true, status: true, employeeId: true },
    });
    if (!before) throw new NotFoundException('Device not found');
    if (before.status === 'active') {
      throw new ConflictException('This device is already active');
    }

    // Careful: restoring an inactive employee's device means the screenshots of
    // someone who left start again — what deactivate had stopped would
    // silently come back.
    if (before.employeeId !== null) {
      const employee = await this.prisma.employee.findUnique({
        where: { id: before.employeeId },
        select: { status: true, empCode: true },
      });
      if (employee?.status === 'inactive') {
        throw new ConflictException(
          `${employee.empCode} is inactive — activate the staff member first`,
        );
      }
    }

    const row = await this.prisma.device.update({
      where: { id },
      data: { status: 'active' },
      select: DEVICE_SELECT,
    });

    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: ADMIN_TARGET.device,
      targetId: id,
      ipAddress: ip,
      meta: { op: 'restore', hostname: before.hostname, reason: dto.reason },
    });

    return row;
  }

  /**
   * `POST /api/v1/devices/enrollment-code`.
   *
   * Careful: the code is shown **only once**; the database holds just the
   * sha256. If lost, a new code must be made, there is no way to recover it —
   * that is the point.
   */
  async createEnrollmentCode(
    actor: SessionUser,
    dto: CreateEnrollmentCodeDto,
    ip: string,
  ): Promise<EnrollmentCodeResult> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { id: true, empCode: true, fullName: true, status: true },
    });
    if (!employee) throw new NotFoundException('Staff member not found');

    // Careful: no code may be issued to enroll a new agent for an employee who has left
    if (employee.status === 'inactive') {
      throw new BadRequestException(
        `${employee.empCode} is inactive — an enrolment code cannot be issued for an inactive staff member`,
      );
    }

    const now = new Date();
    const code = formatEnrollmentCode(randomBytes(32));
    const expiresAt = enrollmentCodeExpiry(now);

    try {
      await this.prisma.$transaction(async (tx) => {
        // A new code expires the earlier ones immediately. Otherwise several live
        // codes would circulate for the same employee, with no answer to
        // "which one did I give to whom".
        await tx.enrollmentCode.updateMany({
          where: {
            employeeId: employee.id,
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: { expiresAt: now },
        });

        await tx.enrollmentCode.create({
          data: {
            codeHash: hashEnrollmentCode(code),
            employeeId: employee.id,
            createdById: actor.userId,
            expiresAt,
          },
        });
      });
    } catch (err) {
      // Careful: codeHash is UNIQUE. A collision in 60 bits is practically
      // impossible, but if it happens, blowing up with a 500 is better than
      // quietly handing out an old code again — two people could enroll with one code.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.error('Enrolment code hash collision — please try again');
      }
      throw err;
    }

    await this.audit.record({
      userId: actor.userId,
      action: 'create_enrollment_code',
      targetType: ADMIN_TARGET.employee,
      targetId: employee.id,
      ipAddress: ip,
      // Careful: neither the code nor its hash ever goes into the audit meta —
      // even though audit_log is owner-only, it is a log, not a place for secrets
      meta: { empCode: employee.empCode, expiresAt: expiresAt.toISOString() },
    });

    return {
      code,
      expiresAt: expiresAt.toISOString(),
      employee: {
        id: employee.id,
        empCode: employee.empCode,
        fullName: employee.fullName,
      },
    };
  }
}
