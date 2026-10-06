import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { Roles } from '../auth/decorators';
import { type AuditLogPage, AuditLogService } from './audit-log.service';
import { AuditLogQueryDto } from './audit-log.dto';

/**
 * E11: `GET /api/v1/audit-log`, **owner-only** (spec § 4.3).
 *
 * Careful: deliberately only `@Get`, with no POST/PATCH/DELETE. A log that
 * can be changed is no longer evidence, so no write door was provided.
 *
 * Careful: **viewing** the audit log is not itself audited. If it were, every
 * page load would create another row, and that row could be viewed too: the
 * table would keep feeding on itself.
 */
@Roles(UserRole.owner)
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  /** `?userId=&action=&targetType=&targetId=&from=&to=&page=&pageSize=` */
  @Get()
  list(@Query() query: AuditLogQueryDto): Promise<AuditLogPage> {
    return this.auditLog.list(query);
  }
}
