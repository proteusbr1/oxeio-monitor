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
import { SessionsService, type UserSessionState } from '../sessions.service';
import { TokenService } from '../token.service';
import type { AuthedRequest, SessionUser } from '../types';

type Verdict = 'ok' | 'inactive' | 'revoked' | 'stale_claims';

/** What the account row says about this token. Pure, so the rule reads in one place. */
function judge(user: SessionUser, state: UserSessionState | null): Verdict {
  if (!state || !state.isActive) return 'inactive';
  if (state.sessionsRevokedAt && user.issuedAt * 1000 < state.sessionsRevokedAt.getTime()) {
    return 'revoked';
  }
  const same =
    state.role === user.role &&
    state.email === user.email &&
    state.employeeId === user.employeeId &&
    state.mustChangePw === user.mustChangePw;
  return same ? 'ok' : 'stale_claims';
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
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

    // Logout of this one session (M3): every copy of its token is refused
    if (this.sessions.isEnded(user.sessionId)) {
      throw new UnauthorizedException('You were signed out — please sign in again');
    }

    /**
     * **The account is checked on every request, not only at the refresh (M3).**
     *
     * Careful, the gap this closes: `is_active`, the role and
     * `sessions_revoked_at` used to be read only when the token was
     * re-issued, every 5 minutes. A dismissed employee, a demoted manager, or
     * a session cut by "Sign out other devices" or a password reset kept full
     * access until then. The read is cached for a few seconds
     * (`SessionsService`), so a page's burst of API calls costs one query.
     *
     * Careful: a cached answer only ever **lets a request through unchanged**.
     * Before refusing, or before re-issuing with different claims, the row is
     * read again from the database, so a stale cache entry can neither sign
     * someone out nor hand back an old role.
     */
    let fresh = await this.sessions.state(user.userId);
    let verdict = judge(user, fresh);
    if (verdict !== 'ok') {
      fresh = await this.sessions.state(user.userId, true);
      verdict = judge(user, fresh);
    }

    /**
     * Careful: the session of a deleted or deactivated account ends here.
     * This did not happen before: if someone who was dismissed left a tab
     * open, the dashboard stayed open for them.
     */
    if (verdict === 'inactive' || !fresh) {
      throw new UnauthorizedException('This account is no longer active');
    }

    // "Sign out other devices", a reset password, a new role: a token from before the cut ends here
    if (verdict === 'revoked') {
      throw new UnauthorizedException('You were signed out — please sign in again');
    }

    req.user = user;

    // Sliding window: keep working and the session continues; sit idle and it ends in 30 minutes
    const ageSec = Math.floor(Date.now() / 1000) - user.issuedAt;
    if (verdict === 'stale_claims' || ageSec > SESSION_REFRESH_AFTER_MIN * 60) {
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
       * Now claims that no longer match the row are re-issued at once, not
       * at the next 5-minute mark. The session id is carried over, so a
       * later logout still ends this session.
       */
      const { sessionsRevokedAt: _cut, isActive: _active, ...claims } = fresh;
      const updated = { ...user, ...claims, userId: user.userId };

      // Careful: the new role applies on this very request; otherwise the change
      // would take effect one request late, which is a gap when a role is reduced.
      req.user = updated;

      const res = ctx.switchToHttp().getResponse<Response>();
      await this.tokens.issue(res, updated);
    }

    return true;
  }
}
