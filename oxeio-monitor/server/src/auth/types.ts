import type { UserRole } from '@prisma/client';
import type { Request } from 'express';

/** What is in the JWT, and what goes onto `req.user` */
export interface SessionUser {
  userId: number;
  email: string;
  role: UserRole;
  /** Which staff member if role = employee; otherwise null */
  employeeId: number | null;
  /** When true nothing can be done until the password is changed */
  mustChangePw: boolean;
  /** When the token was issued (epoch seconds), for the sliding refresh */
  issuedAt: number;
  /**
   * The session this token belongs to (its `jti`). Kept across sliding
   * refreshes, so logout can end exactly this session (`SessionsService.end`).
   * Absent on a token from before it existed, and on a fresh login, where
   * `TokenService.sign()` starts a new one.
   */
  sessionId?: string;
}

export interface AuthedRequest extends Request {
  user?: SessionUser;
}
