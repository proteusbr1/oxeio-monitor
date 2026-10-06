/**
 * I09: the **pure** idle calculation. No `Date.now()`, no timers, no DOM:
 * time always comes in as a parameter, so it can be tested without a DB.
 *
 * The same calculation is needed on both the server and the browser, but for
 * different reasons:
 *    - On the server the JWT lifetime (`SESSION_TTL_MIN`) is the **real**
 *      lock: whatever the browser does, the guard blocks an expired token.
 *    - In the browser this calculation is only **courtesy**: warning 1 minute
 *      ahead instead of quietly logging out.
 *    The web has an exact copy of this (`web/src/auth/idle.ts`); they are
 *    separate npm packages, so one cannot import the other. **This file is
 *    the source of truth**; if it changes, change that one too.
 */

export type IdlePhase =
  /** Normal: not yet time for the warning */
  | 'active'
  /** The last few seconds: the screen must show "x seconds left" */
  | 'warning'
  /** Time is up: logout */
  | 'expired';

export interface IdleState {
  phase: IdlePhase;
  /** Milliseconds remaining; 0 when `expired` */
  msLeft: number;
}

/**
 * Careful: `lastActivityMs > nowMs` means the clock went backwards (a laptop
 * waking from sleep, an NTP sync, a timezone change). The subtraction would
 * then be negative and `msLeft` would look bigger than the timeout, so it is
 * clamped above. Without this the warning would never appear.
 *
 * Careful: in the other direction, if the clock jumps **forward** (a machine
 * waking from sleep), `msLeft` goes straight to 0 -> `expired`. That is the
 * intent: closing a laptop and opening it 2 hours later must not bring the
 * session back.
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
  // `<=`: even standing exactly on the boundary, showing the warning is the safe choice
  if (msLeft <= warnBeforeMs) return { phase: 'warning', msLeft };
  return { phase: 'active', msLeft };
}

/**
 * The browser has to nudge the server now and then to keep its sliding window alive.
 *
 * Careful: without this there is a silent bug: the user is active on screen
 * (mouse moving, scrolling) but no API call is happening, for example while
 * reading a report. The browser would think "active", yet the server token
 * would die at 30 minutes, and on the next click the login screen would
 * suddenly appear. So while there is activity, a light call is sent at the
 * refresh-window interval.
 *
 * Careful: it is called only during **real activity**; otherwise a tab left
 * open would keep the session alive forever, and auto-logout would mean nothing.
 */
export function shouldPingSession(
  lastPingMs: number,
  nowMs: number,
  refreshAfterMs: number,
): boolean {
  return nowMs - lastPingMs >= refreshAfterMs;
}
