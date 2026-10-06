import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Device, Prisma, SegmentState } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Response } from 'express';

import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_SCREENSHOT_BYTES } from './agent.constants';
import { AgentConfigService, type AgentConfig } from './agent-config.service';
import type { Drift } from './clock-drift.service';
import { DeviceAuthGuard } from './device-auth.guard';
import { DeviceRateLimitService } from './device-rate-limit.service';
import { CurrentDevice, CurrentDrift } from './device.decorator';
import {
  AppUsageBatchDto,
  EnrollDto,
  EnrollLoginDto,
  EventBatchDto,
  HeartbeatDto,
  ScreenshotMetaDto,
  SegmentBatchDto,
} from './dto';
import {
  EnrollmentService,
  type EnrollLoginResult,
  type EnrollResult,
} from './enrollment.service';
import { IngestService, type IngestResult } from './ingest.service';
import { ProgressService, type EmployeeProgress } from './progress.service';
import {
  ScreenshotIngestService,
  type ScreenshotResult,
} from './screenshot-ingest.service';
import { UpdateService } from './update.service';
import { CapabilityHealthService } from './capability-health.service';

type AgentCommand =
  | 'reload_config'
  | 'capture_now'
  | 'pause_tracking'
  | 'update_agent'
  | 'revoke';

/**
 * All agent endpoints.
 *
 * `@Public()` at class level, because these are protected by the **device
 * token** (`DeviceAuthGuard`), not the dashboard's JWT/CSRF. Two separate worlds.
 */
@Public()
@Controller('agent')
export class AgentController {
  constructor(
    private readonly enrollment: EnrollmentService,
    private readonly configs: AgentConfigService,
    private readonly ingest: IngestService,
    private readonly screenshots: ScreenshotIngestService,
    private readonly updates: UpdateService,
    private readonly rate: DeviceRateLimitService,
    private readonly progress: ProgressService,
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilityHealthService,
  ) {}

  /** Once, at install time. No token yet; the enrollment code is the identity (H05). */
  @Post('enroll')
  @HttpCode(HttpStatus.CREATED)
  enroll(@Body() dto: EnrollDto): Promise<EnrollResult> {
    return this.enrollment.enroll(dto);
  }

  /**
   * **Staff add their own PC using their own email and password.**
   *
   * This is now the normal path; the code-based one (`/enroll`) remains for
   * scripted rollouts. For why, see `EnrollmentService.enrollWithLogin()`.
   *
   * Careful: `@Ip()` **is required**, and not just for logging:
   * `AuthService.login()` throttles brute-force attempts by that IP. Passing an
   * empty string would put all attempts in one bucket, so one wrong password
   * would block enrollment for **the whole office**.
   *
   * Careful: it returns 200, not 201. The answer can be one of two things (a
   * device was created, or a 2FA code is needed), and saying "created" would be
   * false half the time.
   */
  @Post('enroll-login')
  @HttpCode(HttpStatus.OK)
  enrollWithLogin(
    @Body() dto: EnrollLoginDto,
    @Ip() ip: string,
  ): Promise<EnrollLoginResult> {
    return this.enrollment.enrollWithLogin(dto, ip);
  }

  @UseGuards(DeviceAuthGuard)
  @Get('config')
  config(
    @CurrentDevice() device: Device,
  ): Promise<{ version: string; config: AgentConfig }> {
    return this.configs.buildForDevice(device);
  }

  @UseGuards(DeviceAuthGuard)
  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  async heartbeat(
    @CurrentDevice() device: Device,
    @Body() dto: HeartbeatDto,
  ): Promise<{
    commands: AgentCommand[];
    configVersion: string;
    progress: EmployeeProgress | null;
  }> {
    this.rate.hit(device.id, 'ingest');

    const { version } = await this.configs.buildForDevice(device);
    const commands: AgentCommand[] = [];

    if (dto.configVersion && dto.configVersion !== version) {
      commands.push('reload_config');
    }

    // The version the agent reports is the truth, not the database's.
    //
    // Careful, the order matters: update the record **first**, **then** decide on
    // an update offer. Reversed, an agent that has just updated would be treated
    // as still on the old version and offered the same update again; it would
    // update and send another heartbeat, an infinite loop
    // ([G59](../../../docs/08-Gap-Analysis.md)).
    const runningVersion = dto.agentVersion?.trim() || device.agentVersion;

    await this.recordHeartbeatState(device, dto.state, runningVersion);
    await this.capabilities.record(device, dto.capabilities);

    if (runningVersion) {
      const offer = await this.updates.offerFor(
        runningVersion,
        device.machineGuid,
        device.id,
      );
      if (offer) commands.push('update_agent');
    }

    // TODO: capture_now / pause_tracking need a command-queue table; a button
    //    pressed on the dashboard has to be stored somewhere (A09, Phase 6).
    // The agent does not know the month's totals itself: its counter resets to
    //    zero after a reboot. To show the true number on the tray, it must come
    //    from here.
    const progress = device.employeeId
      ? await this.progress.forEmployee(device.employeeId)
      : null;

    return { commands, configVersion: version, progress };
  }

  /**
   * The heartbeat `state` is stored in `devices` here; the Live Board's colour
   * depends on it. Before this, the value was received but never written, so the
   * board **guessed** from the last `activity_segments` row; since the agent
   * sends segments in batches, that guess was several minutes stale.
   *
   * Careful: `lastState` and `agentVersion` go into the SET **only when they
   *    change**, but `lastStateAt` is written every time. Without knowing "when
   *    it said so" there is no way to tell whether the value can still be
   *    trusted. A stopped agent's last word was `active`; without a timestamp
   *    that would sit in the column and the card would show **green forever**
   *    (`dashboard.math.ts` -> `freshReportedState`).
   *
   * All three columns go in **one** UPDATE. Separately, 15 devices x every 30 s
   *    = 21,600 heartbeats a day would cost 21,600 extra round-trips; the same
   *    lesson as G59, from the opposite direction.
   */
  private async recordHeartbeatState(
    device: Device,
    state: SegmentState,
    runningVersion: string | null,
  ): Promise<void> {
    const data: Prisma.DeviceUpdateInput = { lastStateAt: new Date() };

    if (state !== device.lastState) data.lastState = state;

    // Careful: when no version arrives, the previous one is **not erased**. An
    //    old agent does not know the field, and writing null would stop its
    //    update offers (G59).
    if (runningVersion && runningVersion !== device.agentVersion) {
      data.agentVersion = runningVersion;

      /**
       * **The only proof that a rollout advances by itself.**
       *
       * Careful: the time is set **only when the version changes**, not on every
       * heartbeat. Setting it every time would restart the clock daily, so the
       * "has survived six hours" condition would **never** become true; the
       * rollout would stay stuck at canary forever, and the very problem being
       * fixed would come back, only more quietly.
       *
       * Careful: so being inside the `if` is not an accident; the condition is
       * the definition.
       */
      data.agentVersionSince = new Date();
    }

    await this.prisma.device.update({ where: { id: device.id }, data });
  }

  @UseGuards(DeviceAuthGuard)
  @Post('segments')
  @HttpCode(HttpStatus.OK)
  segments(
    @CurrentDevice() device: Device,
    @CurrentDrift() drift: Drift,
    @Body() dto: SegmentBatchDto,
  ): Promise<IngestResult> {
    this.rate.hit(device.id, 'ingest');
    return this.ingest.ingestSegments(device, drift, dto.segments);
  }

  @UseGuards(DeviceAuthGuard)
  @Post('app-usage')
  @HttpCode(HttpStatus.OK)
  appUsage(
    @CurrentDevice() device: Device,
    @CurrentDrift() drift: Drift,
    @Body() dto: AppUsageBatchDto,
  ): Promise<IngestResult> {
    this.rate.hit(device.id, 'ingest');
    return this.ingest.ingestAppUsage(device, drift, dto.items);
  }

  @UseGuards(DeviceAuthGuard)
  @Post('events')
  @HttpCode(HttpStatus.OK)
  events(
    @CurrentDevice() device: Device,
    @CurrentDrift() drift: Drift,
    @Body() dto: EventBatchDto,
  ): Promise<IngestResult> {
    this.rate.hit(device.id, 'ingest');
    return this.ingest.ingestEvents(device, drift, dto.events);
  }

  @UseGuards(DeviceAuthGuard)
  @Post('screenshots')
  @HttpCode(HttpStatus.CREATED)
  /**
   * **A06 - `FileFieldsInterceptor`, not `FileInterceptor`.** The latter takes
   * exactly one part, so multer silently dropped the agent's `thumb` part and it
   * never reached `ingest()`. The whole thumbnail code was written but never
   * ran, and `thumb_path` stayed null forever.
   *
   * Careful: `maxCount: 1` on **both**; otherwise many parts with the same name
   * could fill memory with buffers (`limits.fileSize` applies per file, not in
   * total).
   *
   * Careful: a request with only `file` is still accepted, so old agents that do
   * not know thumbnails keep working; the gallery then falls back to the full
   * image.
   */
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'thumb', maxCount: 1 },
      ],
      { limits: { fileSize: MAX_SCREENSHOT_BYTES } },
    ),
  )
  async screenshot(
    @CurrentDevice() device: Device,
    @CurrentDrift() drift: Drift,
    @Body('meta') metaRaw: string,
    @UploadedFiles()
    files?: { file?: Express.Multer.File[]; thumb?: Express.Multer.File[] },
  ): Promise<ScreenshotResult> {
    this.rate.hit(device.id, 'screenshot');

    const full = files?.file?.[0];
    if (!full) throw new BadRequestException('The `file` part is missing');

    const meta = await this.parseMeta(metaRaw);
    return this.screenshots.ingest(
      device,
      drift,
      meta,
      full,
      files?.thumb?.[0],
    );
  }

  /**
   * In multipart, `meta` arrives as a JSON string, so the global ValidationPipe
   * cannot touch it; it must be parsed and validated by hand.
   */
  private async parseMeta(raw: string): Promise<ScreenshotMetaDto> {
    if (!raw) throw new BadRequestException('The `meta` part is missing');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('`meta` is not valid JSON');
    }

    const dto = plainToInstance(ScreenshotMetaDto, parsed, {
      enableImplicitConversion: false,
    });
    const errors = await validate(dto, { whitelist: true });
    if (errors.length > 0) {
      throw new BadRequestException(
        errors.map((e) => Object.values(e.constraints ?? {}).join(', ')),
      );
    }
    return dto;
  }

  @UseGuards(DeviceAuthGuard)
  @Get('update')
  async update(
    @CurrentDevice() device: Device,
    @Query('current') current: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const offer = await this.updates.offerFor(
      current ?? device.agentVersion ?? '0.0.0',
      device.machineGuid,
      /**
       * **Without `device.id`, "First to" never worked.**
       *
       * Careful: the field was added to `offerFor()`, and the **heartbeat
       * caller** was updated, but this caller was not. So `deviceId` is
       * `undefined` here and `isPilot` was always `false`.
       *
       * Careful: the failure was especially confusing because it **half worked**:
       * the heartbeat (which sends `device.id`) sent the chosen PC an
       * `update_agent` command, so the agent knew an update existed, then came
       * here and got `204 No Content`. No error, no log, just an update that
       * never downloaded.
       *
       * That is why OX-05 did not get 0.4.10 earlier, although the feature was
       * written for them.
       */
      device.id,
    );
    if (!offer) {
      res.status(HttpStatus.NO_CONTENT);
      return null;
    }
    return offer;
  }

  /**
   * Careful: **it must return a `StreamableFile`; calling `stream.pipe(res)` and
   *    returning `void` does not work.**
   *
   * `passthrough: true` means Nest sends the response. If the handler returns
   * `void`, Nest **ends** the response immediately, before pipe has written a
   * single byte. From outside everything looks fine: `200 OK`,
   * `Content-Length: 65139658`, no error in the log, but **zero bytes** in the
   * body, and the client gets `CURLE_PARTIAL_FILE`.
   *
   * So the MSI download step of H04 never worked. It went unnoticed because the
   * endpoint was never called over real HTTP; a unit test that only checks
   * whether `pipe` was called could never have caught it.
   */
  @UseGuards(DeviceAuthGuard)
  @Get('update/download')
  async download(
    @Query('version') version: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!version) throw new BadRequestException('version is required');

    const { stream, size } = await this.updates.openMsi(version);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', size);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="oXeioAgent-${version}.msi"`,
    );
    return new StreamableFile(stream);
  }
}
