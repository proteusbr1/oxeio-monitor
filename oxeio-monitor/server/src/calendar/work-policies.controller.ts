import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { CreateWorkPolicyDto, UpdateWorkPolicyDto } from './calendar.dto';
import {
  WorkPoliciesService,
  type WorkPolicyView,
} from './work-policies.service';

/**
 * `CRUD /api/v1/work-policies`: entirely owner-only (spec § 4.2, § 4.3).
 *
 * Careful: this config is not just a dashboard matter: `AgentConfigService`
 * builds the agent's config from here. Changing one number here changes the
 * behavior of 15 PCs at the next config sync. So every change is audited.
 */
@Roles(UserRole.owner)
@Controller('work-policies')
export class WorkPoliciesController {
  constructor(private readonly policies: WorkPoliciesService) {}

  @Get()
  list(): Promise<{ rows: WorkPolicyView[] }> {
    return this.policies.list();
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): Promise<WorkPolicyView> {
    return this.policies.get(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() actor: SessionUser,
    @Body() dto: CreateWorkPolicyDto,
    @Ip() ip: string,
  ): Promise<WorkPolicyView> {
    return this.policies.create(actor, dto, ip);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWorkPolicyDto,
    @Ip() ip: string,
  ): Promise<WorkPolicyView> {
    return this.policies.update(actor, id, dto, ip);
  }

  /** Careful: no `@Delete`; employees and old months' calculations still point at the policy */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ): Promise<WorkPolicyView> {
    return this.policies.deactivate(actor, id, ip);
  }

  /**
   * G85: the twin of `deactivate`. Without it a deactivated policy stayed
   * deactivated for good, and the only way back was SQL.
   */
  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ): Promise<WorkPolicyView> {
    return this.policies.reactivate(actor, id, ip);
  }
}
