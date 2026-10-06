/**
 * I09: the pure idle calculation.
 *
 * Careful: this is an exact copy of `server/src/auth/idle-timeout.ts`. The server
 * and the web app are separate npm packages, so it cannot be imported. The
 * server's file is the source of truth: its test (`server/test/totp.spec.ts`)
 * guards this behavior. If you change something here, change it there too, or
 * the browser will count one way and the server another.
 *
 * Careful: this calculation provides no security. The real lock is the lifetime
 * of the server's JWT. The job here is only courtesy: warn before signing the
 * user out, rather than doing it silently.
 */

export type IdlePhase = 'active' | 'warning' | 'expired';

export interface IdleState {
  phase: IdlePhase;
  /** Milliseconds remaining; 0 once `expired`. */
  msLeft: number;
}

/**
 * Careful: when the clock goes backwards (laptop waking from sleep, NTP sync) the
 * subtraction would be negative and `msLeft` would look larger than the timeout,
 * so the warning would never appear.
 */
export function idleStateAt(
  lastActivityMs: number,
  nowMs: number,
  timeoutMs: number,
  warnBeforeMs: number,
): IdleState {
  const elapsed = Math.max(0, nowMs - lastActivityMs);
  const msLeft = Math.max(0, timeoutMs - elapsed);

  if (msLeft <= 0) return { phase: 'expired', msLeft: 0 };
  if (msLeft <= warnBeforeMs) return { phase: 'warning', msLeft };
  return { phase: 'active', msLeft };
}

export function shouldPingSession(
  lastPingMs: number,
  nowMs: number,
  refreshAfterMs: number,
): boolean {
  return nowMs - lastPingMs >= refreshAfterMs;
}
