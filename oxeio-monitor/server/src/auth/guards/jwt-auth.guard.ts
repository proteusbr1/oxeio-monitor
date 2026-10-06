import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';

import {
  SESSION_COOKIE,
  SESSION_REFRESH_AFTER_MIN,
} from '../auth.constants';
import { IS_PUBLIC } from '../decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import type { AuthedRequest } from '../types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const cookies = req.cookies as Record<string, string> | undefined;
    const token = cookies?.[SESSION_COOKIE];

    if (!token) throw new UnauthorizedException('Please sign in');

    const user = await this.tokens.verify(token);
    // Expiry is caught here too -> auto logout after 30 minutes of inactivity (I09)
    if (!user) {
      throw new UnauthorizedException('Session expired, please sign in again');
    }

    req.user = user;

    // Sliding window: keep working and the session continues; sit idle and it ends in 30 minutes
    const ageSec = Math.floor(Date.now() / 1000) - user.issuedAt;
    if (ageSec > SESSION_REFRESH_AFTER_MIN * 60) {
      /**
       * **The new token's claims are read from the database, not copied from
       * the old token; that is the real decision here.**
       *
       * This used to be `this.tokens.issue(res, user)`, i.e. the old claims
       * were carried forward. The result was silent and serious: the sliding
       * window re-issues the token every 5 minutes, so for a user who keeps
       * working **the role was never updated**.
       *
       *   - A manager demoted to employee who kept working with a tab open
       *     would stay a manager **forever**
       *   - A deactivated employee's running session would never die
       *   - `mustChangePw` from a password reset would not apply to a running session
       *
       * The cost is negligible: this lookup happens **once per 5 minutes**,
       * not on every request.
       */
      const fresh = await this.prisma.user.findUnique({
        where: { id: user.userId },
        select: {
          email: true,
          role: true,
          employeeId: true,
          mustChangePw: true,
          isActive: true,
        },
      });

      /**
       * Careful: the session of a deleted or deactivated account ends here.
       * This did not happen before: if someone who was dismissed left a tab
       * open, the dashboard stayed open for them.
       */
      if (!fresh || !fresh.isActive) {
        throw new UnauthorizedException('This account is no longer active');
      }

      const updated = { ...user, ...fresh, userId: user.userId };

      // Careful: the new role applies on this very request; otherwise the change
      // would take effect one request late, which is a gap when a role is reduced.
      req.user = updated;

      const res = ctx.switchToHttp().getResponse<Response>();
      await this.tokens.issue(res, updated);
    }

    return true;
  }
}
