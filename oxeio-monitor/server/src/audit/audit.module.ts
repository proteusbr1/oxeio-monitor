import { Global, Module } from '@nestjs/common';

import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';
import { AuditService } from './audit.service';

@Global()
@Module({
  // the writer every module uses, and the owner's screen that reads it back
  controllers: [AuditLogController],
  providers: [AuditService, AuditLogService],
  exports: [AuditService],
})
export class AuditModule {}
