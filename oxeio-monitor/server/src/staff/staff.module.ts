import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EmployeePortalController } from './employee-portal.controller';
import { EmployeesReadController } from './employees-read.controller';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { UsersController } from './users.controller';

/** Staff: the people, their portal logins and roles, staff codes */
@Module({
  imports: [AuthModule],
  controllers: [
    EmployeesReadController,
    EmployeesController,
    UsersController,
    EmployeePortalController,
  ],
  providers: [EmployeesService],
})
export class StaffModule {}
