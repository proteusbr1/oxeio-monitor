import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';

import { resolveThrottle } from '../src/auth/login-throttle.config';
import { LoginThrottleService } from '../src/auth/login-throttle.service';

/**
 * **G116 — many emails from one IP.**
 *
 * The hole this file guards: the throttle key was `email|ip`, so if an
 * attacker used a different email on every attempt, each attempt landed on a
 * different key, no counter reached its limit, and the lock never engaged.
 * Yet the code comment said exactly the opposite — "one IP, many emails ...
 * is caught". The first test below failed on the code before the fix.
 *
 * `LoginThrottleService` asks for `ConfigService`, but inside it reads only
 * three `.env` keys — so there is no need to boot all of Nest; a small fake is enough.
 */
function serviceWith(env: Record<string, string> = {}): LoginThrottleService {
  const config = {
    get: (key: string): string | undefined => env[key],
  } as unknown as ConfigService;

  return new LoginThrottleService(config);
}

/** Whether it is locked — `true` when it throws 429 */
function locked(svc: LoginThrottleService, email: string, ip: string): boolean {
  try {
    svc.assertNotLocked(email, ip);
    return false;
  } catch (err) {
    if (err instanceof HttpException) return true;
    throw err;
  }
}

describe('LoginThrottleService — IP-based limit (G116)', () => {
  let svc: LoginThrottleService;

  beforeEach(() => {
    // Defaults: pair 10, IP 50 (five times ten)
    svc = serviceWith();
  });

  it('many different emails from one IP — the IP is locked in the end', () => {
    const ip = '203.0.113.9';

    // 49 different emails, one wrong attempt each — never reaches the pair limit
    for (let i = 0; i < 49; i++) {
      svc.recordFailure(`victim${i}@oxeio.local`, ip);
    }
    expect(locked(svc, 'victim99@oxeio.local', ip)).toBe(false);

    // The 50th — the IP limit is reached
    svc.recordFailure('victim49@oxeio.local', ip);

    // Now any email is blocked from that IP, even one never tried — this is
    // the core of the whole fix
    expect(locked(svc, 'never-tried@oxeio.local', ip)).toBe(true);
  });

  it('another IP stays intact — one person does not lock the whole world', () => {
    const attacker = '203.0.113.9';
    for (let i = 0; i < 60; i++) {
      svc.recordFailure(`victim${i}@oxeio.local`, attacker);
    }

    expect(locked(svc, 'owner@oxeio.local', attacker)).toBe(true);
    expect(locked(svc, 'owner@oxeio.local', '198.51.100.4')).toBe(false);
  });

  it('the pair limit works as before — same email, same IP', () => {
    const ip = '198.51.100.4';
    for (let i = 0; i < 9; i++) svc.recordFailure('owner@oxeio.local', ip);
    expect(locked(svc, 'owner@oxeio.local', ip)).toBe(false);

    svc.recordFailure('owner@oxeio.local', ip);
    expect(locked(svc, 'owner@oxeio.local', ip)).toBe(true);

    // Another email from the same IP can still get in — the IP limit is still far away
    expect(locked(svc, 'other@oxeio.local', ip)).toBe(false);
  });

  /**
   * A successful login does not clear the IP counter. Otherwise one success
   * among a thousand attempts would reset the attacker's count to zero — the
   * lock would open at the very moment they started succeeding.
   */
  it('a successful login does not clear the IP count, only its own pair', () => {
    const ip = '203.0.113.9';
    for (let i = 0; i < 49; i++) svc.recordFailure(`victim${i}@oxeio.local`, ip);

    svc.recordSuccess('victim0@oxeio.local', ip);

    // One wrong attempt should reach the IP limit — the count was not reset
    svc.recordFailure('victim50@oxeio.local', ip);
    expect(locked(svc, 'anyone@oxeio.local', ip)).toBe(true);
  });

  it('with lockout off the IP limit is quiet too', () => {
    const off = serviceWith({ LOGIN_LOCK_MINUTES: '0' });
    const ip = '203.0.113.9';
    for (let i = 0; i < 200; i++) off.recordFailure(`v${i}@oxeio.local`, ip);

    expect(locked(off, 'anyone@oxeio.local', ip)).toBe(false);
  });

  it('the limit can be changed with `LOGIN_IP_MAX_FAILS`', () => {
    const tight = serviceWith({ LOGIN_IP_MAX_FAILS: '12' });
    const ip = '203.0.113.9';

    for (let i = 0; i < 11; i++) tight.recordFailure(`v${i}@oxeio.local`, ip);
    expect(locked(tight, 'anyone@oxeio.local', ip)).toBe(false);

    tight.recordFailure('v11@oxeio.local', ip);
    expect(locked(tight, 'anyone@oxeio.local', ip)).toBe(true);
  });
});

describe('resolveThrottle — IP limit value', () => {
  it('by default five times the pair limit', () => {
    expect(resolveThrottle({}).ipMaxFails).toBe(50);
    expect(resolveThrottle({ maxFails: '4' }).ipMaxFails).toBe(20);
  });

  /**
   * The IP limit can never be smaller than the pair limit — if it were, the
   * IP would lock first and the meaning of the two knobs would invert.
   */
  it('a value smaller than the pair limit falls back to the default', () => {
    const t = resolveThrottle({ maxFails: '10', ipMaxFails: '3' });
    expect(t.ipMaxFails).toBe(50);
  });

  it('with a large `maxFails` the IP limit does not drop below it', () => {
    const t = resolveThrottle({ maxFails: '100' });
    expect(t.ipMaxFails).toBeGreaterThanOrEqual(100);
  });

  it('an invalid value falls back to the default', () => {
    expect(resolveThrottle({ ipMaxFails: 'abc' }).ipMaxFails).toBe(50);
    expect(resolveThrottle({ ipMaxFails: '' }).ipMaxFails).toBe(50);
  });
});
