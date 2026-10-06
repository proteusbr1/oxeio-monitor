import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CSRF_COOKIE, CSRF_HEADER } from '../auth.constants';
import { IS_PUBLIC } from '../decorators';
import type { AuthedRequest } from '../types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF (ADR-016).
 *
 * The token is in a cookie (not httpOnly); the frontend reads it and sends it
 * in the `X-CSRF-Token` header. A request from a different origin can send the
 * cookie but cannot **read** it, so it cannot match the header.
 *
 * SameSite=Strict is also set; that is the second layer.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    if (SAFE_METHODS.has(req.method)) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // At login there is no cookie yet, so a CSRF check on public routes is meaningless
    if (isPublic) return true;

    const cookies = req.cookies as Record<string, string> | undefined;
    const fromCookie = cookies?.[CSRF_COOKIE];
    const fromHeader = req.headers[CSRF_HEADER];

    if (
      !fromCookie ||
      typeof fromHeader !== 'string' ||
      fromHeader !== fromCookie
    ) {
      throw new ForbiddenException(
        'CSRF token mismatch — send the cookie value in the X-CSRF-Token header',
      );
    }

    return true;
  }
}
