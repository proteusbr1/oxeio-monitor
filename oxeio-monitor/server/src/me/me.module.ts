import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module';
import { DepositsModule } from '../deposits/deposits.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';

/**
 * **J04 · J05 · J08** — the employee's own page.
 *
 * Careful: `AgentModule` is imported only for `ProgressService`. A duplicate
 * calculation would one day make the tray and the web show two different numbers,
 * which would break trust, the whole point of this feature.
 *
 * Careful: `PrismaModule` is `@Global`, so it needs no separate import.
 */
@Module({
  imports: [AgentModule, DepositsModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
