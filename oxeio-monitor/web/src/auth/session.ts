import { me, type Me } from '../api/auth';
import { ApiError } from '../api/client';

export type SessionResult =
  | { kind: 'authenticated'; user: Me }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** Only a 401 establishes that sign-in is needed; service failure is unknown. */
export async function loadSession(): Promise<SessionResult> {
  try {
    return { kind: 'authenticated', user: await me() };
  } catch (error) {
    return error instanceof ApiError && error.status === 401
      ? { kind: 'signed-out' }
      : { kind: 'unavailable' };
  }
}
