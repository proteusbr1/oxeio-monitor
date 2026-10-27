import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  EMAIL_FORGET_MS,
  emailBackoffMs,
  resolveThrottle,
  TRUSTED_IP_DAYS,
  type ThrottleLimits,
} from './login-throttle.config';

const DAY_MS = 86_400_000;

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

  /**
   * **L1 — the third key: the account itself, whatever the IP.**
   *
   * Careful, the gap: both keys above contain the IP. A guesser spreading
   *    attempts for **one** account over many IPs (a botnet, a rotating
   *    proxy) stayed under both limits forever: ten tries per IP, and never
   *    fifty from one.
   *
   * This key only **slows** (`emailBackoffMs`, capped at 15 minutes), never
   * locks, and IPs the account has signed in from before are exempt
   * (`trusted`). Otherwise anyone could keep the owner out of their own
   * system by typing wrong passwords for the owner's email.
   */
  private emailKey(email: string): string {
    return `email:${email.toLowerCase()}`;
  }

  /** email -> (ip -> last successful sign-in, epoch ms) */
  private readonly trusted = new Map<string, Map<string, number>>();

  private isTrusted(email: string, ip: string): boolean {
    const seen = this.trusted.get(email.toLowerCase())?.get(ip);
    return seen !== undefined && Date.now() - seen < TRUSTED_IP_DAYS * DAY_MS;
  }

  /** Throws 429 if locked */
  assertNotLocked(email: string, ip: string): void {
    if (!this.limits.enabled) return;

    this.prune();
    const now = Date.now();

    /**
     * Careful: of the three, the one with **the most time remaining** is shown.
     * Otherwise when the pair lock ended the user would think "try now" and
     * try again while the IP lock was still on, and the message would be false.
     */
    const until = Math.max(
      this.attempts.get(this.pairKey(email, ip))?.lockedUntil ?? 0,
      this.attempts.get(this.ipKey(ip))?.lockedUntil ?? 0,
      this.isTrusted(email, ip)
        ? 0
        : (this.attempts.get(this.emailKey(email))?.lockedUntil ?? 0),
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
    this.slowDown(this.emailKey(email));
  }

  /**
   * Counts one more failure for the account and sets its backoff.
   *
   * Careful: unlike `bump()` the count is **not** reset when the wait is set;
   *    the next failure has to wait twice as long. It resets on a successful
   *    sign-in, or after `EMAIL_FORGET_MS` with no failures (`prune()`).
   */
  private slowDown(key: string): void {
    const now = Date.now();
    const a = this.attempts.get(key) ?? { fails: 0, lockedUntil: 0, lastSeen: now };

    a.fails += 1;
    a.lastSeen = now;
    if (this.limits.enabled) {
      const wait = emailBackoffMs(a.fails, this.limits.maxFails);
      if (wait > 0) a.lockedUntil = now + wait;
    }
    this.attempts.set(key, a);
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

    // the right password ends the account's backoff, and this IP is now a known one
    this.attempts.delete(this.emailKey(email));
    const lower = email.toLowerCase();
    const ips = this.trusted.get(lower) ?? new Map<string, number>();
    ips.set(ip, Date.now());
    this.trusted.set(lower, ips);
  }

  /** Stale entries are not left to pile up, to prevent a memory leak */
  private prune(): void {
    const now = Date.now();
    const cutoff = now - this.pruneMs * 2;
    for (const [k, a] of this.attempts) {
      // the account key lives longer: forgetting it after minutes would let a
      // slow guesser restart the doubling every time
      const idleSince = k.startsWith('email:') ? now - EMAIL_FORGET_MS : cutoff;
      if (a.lastSeen < idleSince && a.lockedUntil < now) {
        this.attempts.delete(k);
      }
    }

    for (const [email, ips] of this.trusted) {
      for (const [ip, at] of ips) {
        if (now - at >= TRUSTED_IP_DAYS * DAY_MS) ips.delete(ip);
      }
      if (ips.size === 0) this.trusted.delete(email);
    }
  }
}
