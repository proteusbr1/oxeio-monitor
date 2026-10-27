import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SESSION_TTL_MIN } from './auth.constants';

/** What the guard compares against the token on every request */
export interface UserSessionState {
  email: string;
  role: UserRole;
  employeeId: number | null;
  mustChangePw: boolean;
  isActive: boolean;
  sessionsRevokedAt: Date | null;
}

/**
 * **How stale the per-request account check may be: 5 seconds.**
 *
 * Careful: the check runs on **every** authenticated request (M3). A dashboard
 * page fires a handful of API calls at once; without a cache each one would
 * read the `users` row. Five seconds turns that burst into one read.
 *
 * Careful: changes made **by this server** do not wait for the five seconds:
 * every writer of these columns calls `invalidate()` (reset password, role,
 * email, deactivate, sign-out). The window only applies to edits made from
 * outside the process (the `recover-owner` script, a hand-run SQL), and there
 * five seconds is the whole delay.
 */
const STATE_TTL_MS = 5_000;

/**
 * **Session lifecycle: the per-request account check, and logout of one session.**
 *
 * Careful: why this exists: the account's state (`is_active`, role,
 * `sessions_revoked_at`) used to be read only at the 5-minute sliding refresh.
 * A dismissed employee, a demoted manager, or a session "signed out
 * everywhere" kept full access for up to five minutes, and logout only
 * cleared the browser's cookie: a copied token stayed valid, and the sliding
 * refresh kept it alive for as long as someone kept using it.
 *
 * Logout now ends **that one session**: every token carries a session id
 * (`jti`), kept across sliding refreshes, and logout puts it on a deny list
 * until the last token it could have issued has expired by itself. Other
 * devices of the same person stay signed in; "Sign out other devices" is
 * still `revokeAll()`.
 *
 * Careful: the deny list is checked **from memory** (one server process,
 * single tenant), and written through to `revoked_sessions` so a restart does
 * not bring a signed-out token back. It is tiny: one row per logout, gone
 * after `SESSION_TTL_MIN`.
 */
@Injectable()
export class SessionsService implements OnModuleInit {
  private readonly logger = new Logger(SessionsService.name);
  private readonly states = new Map<number, { state: UserSessionState | null; at: number }>();
  /** session id -> when its last possible token expires (epoch ms) */
  private readonly ended = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.prisma.revokedSession.findMany({
      where: { expiresAt: { gt: new Date() } },
      select: { sessionId: true, expiresAt: true },
    });
    for (const r of rows) this.ended.set(r.sessionId, r.expiresAt.getTime());
  }

  /**
   * The account as the guard should judge it.
   *
   * @param fresh skip the cache: the guard asks again this way before acting
   *   on a difference, so a stale entry can never sign anyone out or hand out
   *   an old role.
   */
  async state(userId: number, fresh = false): Promise<UserSessionState | null> {
    const now = Date.now();
    const cached = this.states.get(userId);
    if (!fresh && cached && now - cached.at < STATE_TTL_MS) return cached.state;

    const state = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        role: true,
        employeeId: true,
        mustChangePw: true,
        isActive: true,
        sessionsRevokedAt: true,
      },
    });

    this.states.set(userId, { state, at: now });
    this.prune(now);
    return state;
  }

  /** After any write to the columns above: the next request reads the row again */
  invalidate(userId: number): void {
    this.states.delete(userId);
  }

  /**
   * Every session issued before this second ends **on its next request**.
   * The caller re-issues its own token right after when this device should
   * stay signed in.
   *
   * Careful: whole seconds. A token's `iat` is in seconds; storing the
   * milliseconds would make the token re-issued in this same second look
   * older than the cut and sign this device out too.
   */
  async revokeAll(userId: number): Promise<void> {
    const cut = new Date(Math.floor(Date.now() / 1000) * 1000);
    await this.prisma.user.update({ where: { id: userId }, data: { sessionsRevokedAt: cut } });
    this.invalidate(userId);
  }

  /**
   * Logout: this one session can no longer be used, from any copy of its token.
   *
   * Careful: the expiry is "now + the token lifetime". The sliding refresh
   * keeps the session id, so the newest token of this session was issued at
   * the latest now, and no new one can be issued once it is on this list.
   */
  async end(sessionId: string): Promise<void> {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MIN * 60_000);
    this.ended.set(sessionId, expiresAt.getTime());

    await this.prisma.revokedSession.upsert({
      where: { sessionId },
      create: { sessionId, expiresAt },
      update: { expiresAt },
    });
    // housekeeping on the write path: logouts are rare, requests are not
    const { count } = await this.prisma.revokedSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) this.logger.debug(`${count} expired signed-out sessions removed`);
  }

  isEnded(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const until = this.ended.get(sessionId);
    return until !== undefined && until > Date.now();
  }

  /** For the tests: their database is truncated between cases, ids start again */
  forget(): void {
    this.states.clear();
    this.ended.clear();
  }

  private prune(now: number): void {
    // Careful: bounded by the number of accounts (17 in the office), so a
    //    sweep only when the map grows is enough
    if (this.states.size > 500) {
      for (const [id, entry] of this.states) {
        if (now - entry.at >= STATE_TTL_MS) this.states.delete(id);
      }
    }
    for (const [sid, until] of this.ended) {
      if (until <= now) this.ended.delete(sid);
    }
  }
}
