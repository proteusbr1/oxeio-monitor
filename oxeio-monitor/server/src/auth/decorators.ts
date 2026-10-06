import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { UserRole } from '@prisma/client';

import type { AuthedRequest, SessionUser } from './types';

export const IS_PUBLIC = 'oxeio:public';
export const REQUIRED_ROLES = 'oxeio:roles';
export const ALLOW_PW_CHANGE = 'oxeio:allowWhileMustChangePw';

/** Reachable without logging in: health, login */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC, true);

/** Cannot be entered without a specific role */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLES, roles);

/**
 * Routes that stay open even while `mustChangePw = true`;
 * otherwise the user could not change the password.
 */
export const AllowWhileMustChangePw = (): MethodDecorator =>
  SetMetadata(ALLOW_PW_CHANGE, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) {
      // JwtAuthGuard should have blocked it already; reaching here means a wiring mistake
      throw new Error('CurrentUser used on a route marked @Public');
    }
    return req.user;
  },
);
