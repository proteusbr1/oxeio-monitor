import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';

import { EVERY_ROLE, REQUIRED_ROLES } from '../decorators';
import type { AuthedRequest } from '../types';

/**
 * I05: owner / manager / coordinator / employee / finance (spec § 4.3). A
 * route without `@Roles` stays open to every role except `finance`, which
 * needs `@EveryRole()` or an explicit `@Roles(..., finance)`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(
      REQUIRED_ROLES,
      [ctx.getHandler(), ctx.getClass()],
    );
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    if (!required || required.length === 0) {
      // finance sees the hours statement and its own account, nothing else
      if (req.user?.role === 'finance') {
        const open = this.reflector.getAllAndOverride<boolean>(EVERY_ROLE, [
          ctx.getHandler(),
          ctx.getClass(),
        ]);
        if (!open) {
          throw new ForbiddenException("You don't have access to this action");
        }
      }
      return true;
    }

    if (!req.user || !required.includes(req.user.role)) {
      throw new ForbiddenException("You don't have access to this action");
    }
    return true;
  }
}
