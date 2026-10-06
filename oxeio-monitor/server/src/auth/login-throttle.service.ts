import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { resolveThrottle, type ThrottleLimits } from './login-throttle.config';

interface Attempt {
  fails: number;
  lockedUntil: number;
  lastSeen: number;
}

/**
 * I11: brute-force prevention.
 *
 * Kept in memory: one server process, 17 users, so Redis makes no sense.
 * Careful: a server restart clears the counters. This is an accepted
 * trade-off; an attacker cannot make the server restart.
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);
  private readonly attempts = new Map<string, Attempt>();
  private readonly limits: ThrottleLimits;

  constructor(config: ConfigService) {
    this.limits = resolveThrottle({
      maxFails: config.get<string>('LOGIN_MAX_FAILS'),
      lockMinutes: config.get<string>('LOGIN_LOCK_MINUTES'),
      ipMaxFails: config.get<string>('LOGIN_IP_MAX_FAILS'),
    });

    /**
     * Careful: if it is off, that is logged **once at startup**. Otherwise six
     * months later, when someone asks "is there brute-force protection?",
     * they would have to read `.env` to find out, and everyone would assume
     * there is, because it is in the code.
     */
    if (!this.limits.enabled) {
      this.logger.warn(
        'Login lockout is OFF (LOGIN_LOCK_MINUTES=0) — wrong passwords can be tried without limit',
      );
    }
  }

  /** Careful: the prune window is needed even when there is no lock, hence a separate base value */
  private get pruneMs(): number {
    return this.limits.lockMs > 0 ? this.limits.lockMs : 5 * 60 * 1000;
  }

  /**
   * **Two keys, for two different attacks** (G116).
   *
   * Careful: this used to say "one email from many IPs, or one IP across
   *    many emails, both are caught", and that was **false**. The key was
   *    `email|ip`, so in both cases every attempt landed in **a different
   *    key** and no counter reached its limit. With a thousand emails tried
   *    from one IP the lock never fell.
   *
   *  - `email|ip`: one person's password guessed repeatedly (limit `maxFails`)
   *  - `ip` alone: many emails from one IP (limit `ipMaxFails`, much higher)
   */
  private pairKey(email: string, ip: string): string {
    return `${email.toLowerCase()}|${ip}`;
  }

  /** Careful: the prefix matters; otherwise the `ip` key could collide with some `email|ip` */
  private ipKey(ip: string): string {
    return `ip:${ip}`;
  }

  /** Throws 429 if locked */
  assertNotLocked(email: string, ip: string): void {
    if (!this.limits.enabled) return;

    this.prune();
    const now = Date.now();

    /**
     * Careful: of the two, the one with **more lock time remaining** is shown.
     * Otherwise when the pair lock ended the user would think "try now" and
     * try again while the IP lock was still on, and the message would be false.
     */
    const until = Math.max(
      this.attempts.get(this.pairKey(email, ip))?.lockedUntil ?? 0,
      this.attempts.get(this.ipKey(ip))?.lockedUntil ?? 0,
    );
    if (until <= now) return;

    const seconds = Math.ceil((until - now) / 1000);
    const minutes = Math.ceil(seconds / 60);
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        retryAfterSeconds: seconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  recordFailure(email: string, ip: string): void {
    this.bump(this.pairKey(email, ip), this.limits.maxFails);
    this.bump(this.ipKey(ip), this.limits.ipMaxFails);
  }

  /** Adds one to a key's count, and sets the lock when the limit is reached */
  private bump(key: string, max: number): void {
    const now = Date.now();
    const a = this.attempts.get(key) ?? { fails: 0, lockedUntil: 0, lastSeen: now };

    a.fails += 1;
    a.lastSeen = now;
    if (this.limits.enabled && a.fails >= max) {
      a.lockedUntil = now + this.limits.lockMs;
      a.fails = 0; // after the lock ends, counting starts afresh
    }
    this.attempts.set(key, a);
  }

  /**
   * Careful: on a successful login **only the pair key** is cleared, not the
   *    IP counter. Otherwise if an attacker succeeded even once among a
   *    thousand attempts, their whole count would reset to zero, so the lock
   *    would open exactly when they started to succeed.
   * On an office's shared IP this does no harm: the limit is five times
   *    higher, and `prune()` removes old counts anyway.
   */
  recordSuccess(email: string, ip: string): void {
    this.attempts.delete(this.pairKey(email, ip));
  }

  /** Stale entries are not left to pile up, to prevent a memory leak */
  private prune(): void {
    const cutoff = Date.now() - this.pruneMs * 2;
    for (const [k, a] of this.attempts) {
      if (a.lastSeen < cutoff && a.lockedUntil < Date.now()) {
        this.attempts.delete(k);
      }
    }
  }
}
