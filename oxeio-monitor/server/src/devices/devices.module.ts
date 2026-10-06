import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module';
import { AgentVersionsController } from './agent-versions.controller';
import { AgentVersionsService } from './agent-versions.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

/**
 * The owner's side of the PCs: devices (enrolment codes, revoke, restore)
 * and the agent builds offered to them. What the agent itself calls is in
 * AgentModule, which provides the update service used here.
 */
@Module({
  imports: [AgentModule],
  controllers: [DevicesController, AgentVersionsController],
  providers: [DevicesService, AgentVersionsService],
})
export class DevicesModule {}
