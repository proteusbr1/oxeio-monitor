import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import {
  AgentVersionsService,
  type AgentVersionView,
} from './agent-versions.service';
import { AuditService } from '../audit/audit.service';
import { UpdateService } from '../agent/update.service';
import { PublishVersionDto, SetStageDto } from './devices.dto';

/**
 * Rolling out new agent versions.
 *
 * Careful: the whole class is owner-only, at class level — not even managers.
 * What software runs on the 15 PCs is the owner's decision, and if a bad build
 * goes out there is no automatic way back (G69).
 */
@Roles(UserRole.owner)
@Controller('agent-versions')
export class AgentVersionsController {
  constructor(
    private readonly versions: AgentVersionsService,
    private readonly updates: UpdateService,
    private readonly audit: AuditService,
  ) {}

  /** Which versions are out, at which stage, and how many PCs are already on each */
  @Get()
  list(): Promise<AgentVersionView[]> {
    return this.versions.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  publish(
    @CurrentUser() actor: SessionUser,
    @Body() dto: PublishVersionDto,
    @Ip() ip: string,
  ): Promise<AgentVersionView> {
    return this.versions.publish(actor, dto, ip);
  }

  /**
   * `canary` → `partial` → `all`, or **`halted`**.
   *
   * `halted` is the only emergency brake: if a bad update has gone out, those
   * who already got it must be fixed by hand, but the rest are at least spared.
   */
  /**
   * **Download the MSI — for manual installation.**
   *
   * Careful: **why it was needed:** agents **older** than 0.4.1 have no
   * "Install update" tray menu at all, so a staged rollout never reaches them —
   * the file downloads and sits there, and nobody knows (doc 09 § 3). Those PCs
   * need one manual install, and there was **no way at all to get the MSI by
   * hand**: `/agent/update/download` opens only with a device token, and the
   * owner has no token.
   *
   * The file is opened through `UpdateService.openMsi()`, not by joining a path
   * here — it has the guard against paths outside storage.
   *
   * Careful: owner-only (class-level `@Roles`) and written to the audit log:
   *    who downloaded which version, and when — that must be known before the
   *    installer starts passing from hand to hand.
   */
  @Get(':version/download')
  @Header('Content-Type', 'application/x-msi')
  async download(
    @CurrentUser() actor: SessionUser,
    @Param('version') version: string,
    @Ip() ip: string,
  ): Promise<StreamableFile> {
    const file = await this.updates.openMsi(version);

    await this.audit.record({
      userId: actor.userId,
      action: 'agent_version.download',
      targetType: 'agent_version',
      targetId: version,
      ipAddress: ip,
      meta: { sizeBytes: file.size },
    });

    return new StreamableFile(file.stream, {
      // Careful: the name is ASCII and predictable — while passing from PC to PC,
      // the answer to "which file is this" has to be in the name
      disposition: `attachment; filename="oXeioAgent-${version}.msi"`,
      length: file.size,
    });
  }

  @Post(':version/stage')
  @HttpCode(HttpStatus.OK)
  setStage(
    @CurrentUser() actor: SessionUser,
    @Param('version') version: string,
    @Body() dto: SetStageDto,
    @Ip() ip: string,
  ): Promise<AgentVersionView> {
    return this.versions.setStage(actor, version, dto, ip);
  }
}
