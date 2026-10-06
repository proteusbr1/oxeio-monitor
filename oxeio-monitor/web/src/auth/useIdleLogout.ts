import { useCallback, useEffect, useRef, useState } from 'react';

import { me } from '../api/auth';
import { idleStateAt, shouldPingSession, type IdleState } from './idle';
import { sessionPolicy } from './twoFactorApi';

/**
 * The server moves the sliding window every 5 minutes (`SESSION_REFRESH_AFTER_MIN`).
 * Careful: pinging more often than that only adds pointless traffic; pinging
 * less often would let an active user's token expire.
 */
const PING_EVERY_MS = 5 * 60 * 1000;

/** Assumed when the server cannot be reached; equal to the server's defaults. */
const FALLBACK_TIMEOUT_MS = 30 * 60 * 1000;
const FALLBACK_WARN_MS = 60 * 1000;

/**
 * Careful: `scroll` is deliberately absent. Momentum scrolling (touchpad) keeps
 * firing events even when nobody is at the screen.
 * Careful: `mousemove` is included, because a user who is only reading does
 * nothing else, but without the throttle below it would change state 60 times a second.
 */
const ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'keydown',
  'touchstart',
  'wheel',
] as const;

/** Key for sharing activity across multiple tabs. */
const SHARED_KEY = 'oxeio:lastActivity';

/** Minimum interval between state updates; otherwise every mouse movement re-renders. */
const THROTTLE_MS = 5_000;

export interface IdleLogout extends IdleState {
  /** "I'm still here": the warning's button and any click call this. */
  stayLoggedIn: () => void;
}

/**
 * I09: automatic logout after 30 minutes of inactivity, with a warning 1 minute before.
 *
 * Careful: no silent logout in the middle of work; that is the whole reason for
 * this hook. The server would kill the token anyway, but the user would find out
 * on the next click, suddenly facing the login screen, with unfinished work.
 *
 * It does three things at once:
 *   1. Measures activity (throttled, shared across tabs)
 *   2. Pings the server while the user is active; otherwise you get "active on
 *      screen but token dead" (see the `me()` call below)
 *   3. Calls `onExpire` when time runs out
 */
export function useIdleLogout(
  enabled: boolean,
  onExpire: () => void,
): IdleLogout {
  const [timeoutMs, setTimeoutMs] = useState(FALLBACK_TIMEOUT_MS);
  const [warnMs, setWarnMs] = useState(FALLBACK_WARN_MS);
  const [state, setState] = useState<IdleState>({
    phase: 'active',
    msLeft: FALLBACK_TIMEOUT_MS,
  });

  const lastActivityRef = useRef(Date.now());
  const lastPingRef = useRef(Date.now());
  const lastWriteRef = useRef(0);
  /**
   * Careful: kept in a ref so the effect below does not restart when `onExpire`
   * changes. In the dependencies, the event listeners would be removed and added on
   * every render and the countdown would restart from zero each time.
   */
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  // The server's real numbers; fall back if missing (not worth showing an error for)
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void sessionPolicy().then(
      (p) => {
        if (!alive) return;
        setTimeoutMs(p.idleTimeoutSec * 1000);
        setWarnMs(p.warnBeforeSec * 1000);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [enabled]);

  const markActive = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;

    // Careful: writing to localStorage every time would mean 60 writes a second on mousemove
    if (now - lastWriteRef.current >= THROTTLE_MS) {
      lastWriteRef.current = now;
      try {
        localStorage.setItem(SHARED_KEY, String(now));
      } catch {
        // Careful: localStorage throws in private mode or when the quota is full.
        // Losing the cross-tab sharing is acceptable; breaking the logout timing is not.
      }
    }

    setState((prev) =>
      prev.phase === 'active' ? prev : { phase: 'active', msLeft: timeoutMs },
    );
  }, [timeoutMs]);

  // ── Listening for activity ──────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    let throttleUntil = 0;
    const onActivity = (): void => {
      const now = Date.now();
      if (now < throttleUntil) {
        // Careful: time must advance even inside the throttle; otherwise for a user
        // moving the mouse continuously, `lastActivity` would always be 5 seconds old
        lastActivityRef.current = now;
        return;
      }
      throttleUntil = now + THROTTLE_MS;
      markActive();
    };

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }

    /**
     * Careful: working in another tab wakes this tab too. Without it, a user with two
     * tabs open who works in one would be logged out in the other, and since the
     * session cookie is shared, both would be closed.
     */
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== SHARED_KEY || e.newValue === null) return;
      const other = Number(e.newValue);
      if (Number.isFinite(other) && other > lastActivityRef.current) {
        lastActivityRef.current = other;
        setState((prev) =>
          prev.phase === 'active'
            ? prev
            : { phase: 'active', msLeft: timeoutMs },
        );
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActivity);
      }
      window.removeEventListener('storage', onStorage);
    };
  }, [enabled, markActive, timeoutMs]);

  // ── Per-second calculation ─────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;

    // Counting starts right after login, not from some old state
    lastActivityRef.current = Date.now();
    lastPingRef.current = Date.now();

    // Careful: `onExpire` runs once after expiry. Without this guard it would be
    // called every second until the logout finished.
    let fired = false;

    /**
     * Careful: the countdown does not count `setInterval` ticks, it only looks at the
     * clock. When a tab goes to the background or a laptop sleeps, the browser slows
     * timers (up to 1 minute); counting ticks would show "29 minutes left" on a
     * machine that woke after 2 hours, though the server's token died long ago.
     */
    const tick = (): void => {
      const now = Date.now();
      const next = idleStateAt(lastActivityRef.current, now, timeoutMs, warnMs);
      setState(next);

      if (next.phase === 'expired') {
        if (!fired) {
          fired = true;
          expireRef.current();
        }
        return;
      }
      fired = false;

      /**
       * Careful: the ping is `me()`, not `session-policy`. That one is `@Public()`, so
       * it never enters JwtAuthGuard and would not move the session's sliding window.
       * A user active on screen but quiet toward the API (say, reading a report) would
       * then be logged out suddenly after 30 minutes.
       *
       * Careful: `lastActivity >= lastPing` checks that something really happened since
       * the last ping. Without that condition an idle tab would also ping every 5
       * minutes for 29 minutes, and the server's token would keep moving. Then, if the
       * browser closed abruptly (crash, force quit), the session would survive for
       * about 55 minutes instead of 30 minutes after the last real work.
       */
      if (
        next.phase === 'active' &&
        lastActivityRef.current >= lastPingRef.current &&
        shouldPingSession(lastPingRef.current, now, PING_EVERY_MS)
      ) {
        lastPingRef.current = now;
        // Silent on failure: if the session really is dead, the 401 of the next real
        // request will wake the global handler
        void me().catch(() => undefined);
      }
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [enabled, timeoutMs, warnMs]);

  const stayLoggedIn = useCallback(() => {
    lastWriteRef.current = 0; // tell the other tabs right away too
    lastPingRef.current = 0; // Careful: the server's window must move right away too
    markActive();
  }, [markActive]);

  return { ...state, stayLoggedIn };
}
