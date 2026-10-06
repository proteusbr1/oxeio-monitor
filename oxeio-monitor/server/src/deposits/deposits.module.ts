import { Module } from '@nestjs/common';

import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';

/**
 * Security money (deposit).
 *
 * `DepositsService` is **exported** — it has two callers: the payroll sheet
 * (deduction rows) and the employee's own page (`/me/deposit`). If the
 * calculation were copied, one day the two screens would show two numbers,
 * with no way to say which is true.
 *
 * Careful: `PrismaModule` and `AuditModule` are `@Global`, so no separate import is needed.
 */
@Module({
  controllers: [DepositsController],
  providers: [DepositsService],
  exports: [DepositsService],
})
export class DepositsModule {}
