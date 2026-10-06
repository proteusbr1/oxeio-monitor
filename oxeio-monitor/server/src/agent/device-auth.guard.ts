import { createHash } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Device } from '@prisma/client';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { CLIENT_TIME_HEADER } from './agent.constants';
import { ClockDriftService, type Drift } from './clock-drift.service';

export interface DeviceRequest extends Request {
  device?: Device;
  drift?: Drift;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The gate for all agent endpoints.
 *
 * The token is **not stored in plaintext** on the server, only its sha256 (I02).
 * So even a database leak does not let anyone impersonate an agent and send data.
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockDriftService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<DeviceRequest>();

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Device token required');
    }

    const device = await this.prisma.device.findFirst({
      where: { tokenHash: hashToken(header.slice(7).trim()) },
    });
    if (!device) throw new UnauthorizedException('Device token is invalid');

    // H06 - once revoked remotely, the agent can no longer send anything.
    if (device.status === 'revoked') {
      throw new ForbiddenException({
        message: 'This device has been revoked',
        command: 'revoke',
      });
    }

    const clientTimeRaw = req.headers[CLIENT_TIME_HEADER];
    const clientTime =
      typeof clientTimeRaw === 'string' ? new Date(clientTimeRaw) : null;

    const drift = this.clock.measure(clientTime);
    req.device = device;
    req.drift = drift;

    /**
     * last_seen_at: the "agent silent for 10 minutes" alert depends on it (G01).
     *
     * **`last_drift_sec` is written here too** (G170).
     *
     * Careful, the bug this fixes: the column was written only by
     * `ClockDriftService.record()`, which returns immediately on
     * `if (drift.level === 'none') return;`. So once a large value was stored it
     * was **never cleared**, even after the clock was corrected.
     *
     * Seen in the field: OX-13's clock was 15 hours behind in the morning and
     * Windows corrected it within minutes, yet the fleet list kept showing
     * **54,223 seconds**. The number on screen was false, and there was no error.
     *
     * **No extra round-trip**: this UPDATE runs on every request anyway.
     * Careful: the value goes into the SET **only when it changes**, exactly like
     * `lastState`/`agentVersion` (the same lesson as G59).
     */
    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: new Date(),
        ...(drift.seconds === device.lastDriftSec
          ? {}
          : { lastDriftSec: drift.seconds }),
      },
    });

    // Record drift on the device if present; raise an alert if it is large (§ 2).
    await this.clock.record(device.id, device.employeeId, drift);

    return true;
  }
}
