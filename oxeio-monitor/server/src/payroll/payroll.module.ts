import { Module } from '@nestjs/common';

import { DepositsModule } from '../deposits/deposits.module';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

@Module({
  // R21: the sheet needs `DepositsService` to add the deposit rows
  imports: [DepositsModule],
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollModule {}
