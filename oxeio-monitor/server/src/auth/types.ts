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
}

export interface AuthedRequest extends Request {
  user?: SessionUser;
}
