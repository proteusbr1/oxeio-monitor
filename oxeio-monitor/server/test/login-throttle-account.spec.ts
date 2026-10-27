import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EMAIL_BACKOFF_CAP_MS,
  emailBackoffMs,
} from '../src/auth/login-throttle.config';
import { LoginThrottleService } from '../src/auth/login-throttle.service';

/**
 * **L1 — one account guessed from many IPs.**
 *
 * Both older keys contain the IP (`email|ip`, `ip`), so ten tries from each of
 * a thousand IPs never reached either limit. The account key only slows down
 * (doubling, capped at 15 minutes) and never applies to an IP the account
 * already signed in from, so it cannot be turned into "lock the owner out".
 *
 * The clock is faked: the waits are seconds to minutes long.
 */
function serviceWith(env: Record<string, string> = {}): LoginThrottleService {
  const config = {
    get: (key: string): string | undefined => env[key],
  } as unknown as ConfigService;
  return new LoginThrottleService(config);
}

function waitSeconds(svc: LoginThrottleService, email: string, ip: string): number {
  try {
    svc.assertNotLocked(email, ip);
    return 0;
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    return (err.getResponse() as { retryAfterSeconds: number }).retryAfterSeconds;
  }
}

const OWNER = 'owner@oxeio.local';
const HOME = '198.51.100.4';
/** A different IP for every attempt, like a botnet: never reaches pair or IP limits */
const botnet = (i: number) => `203.0.${Math.floor(i / 250)}.${i % 250}`;

describe('emailBackoffMs', () => {
  it('nothing within the allowance, then 1 s, 2 s, 4 s ...', () => {
    expect(emailBackoffMs(10, 10)).toBe(0);
    expect(emailBackoffMs(11, 10)).toBe(1000);
    expect(emailBackoffMs(12, 10)).toBe(2000);
    expect(emailBackoffMs(14, 10)).toBe(8000);
  });

  it('never above the cap, however many failures', () => {
    expect(emailBackoffMs(25, 10)).toBe(EMAIL_BACKOFF_CAP_MS);
    expect(emailBackoffMs(10_000, 10)).toBe(EMAIL_BACKOFF_CAP_MS);
  });
});

describe('LoginThrottleService — per-account backoff (L1)', () => {
  let svc: LoginThrottleService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    svc = serviceWith();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('one account from many IPs is slowed down, with the wait doubling', () => {
    for (let i = 0; i < 10; i++) svc.recordFailure(OWNER, botnet(i));
    expect(waitSeconds(svc, OWNER, botnet(99))).toBe(0);

    svc.recordFailure(OWNER, botnet(10));
    expect(waitSeconds(svc, OWNER, botnet(99))).toBe(1);

    vi.advanceTimersByTime(1_000);
    for (let i = 11; i < 16; i++) svc.recordFailure(OWNER, botnet(i));
    expect(waitSeconds(svc, OWNER, botnet(99))).toBe(32);
  });

  it('the wait stops at 15 minutes; it is never a lock', () => {
    for (let i = 0; i < 200; i++) svc.recordFailure(OWNER, botnet(i));
    expect(waitSeconds(svc, OWNER, botnet(999))).toBe(15 * 60);

    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(waitSeconds(svc, OWNER, botnet(999))).toBe(0);
  });

  /** The point of "soft": an attacker cannot keep the owner out of their own office */
  it('an IP the account signed in from before is not slowed down', () => {
    svc.recordSuccess(OWNER, HOME);
    for (let i = 0; i < 200; i++) svc.recordFailure(OWNER, botnet(i));

    expect(waitSeconds(svc, OWNER, botnet(999))).toBeGreaterThan(0);
    expect(waitSeconds(svc, OWNER, HOME)).toBe(0);
  });

  it('other accounts are untouched', () => {
    for (let i = 0; i < 200; i++) svc.recordFailure(OWNER, botnet(i));
    expect(waitSeconds(svc, 'staff@oxeio.local', botnet(999))).toBe(0);
  });

  it('the right password ends the backoff', () => {
    for (let i = 0; i < 15; i++) svc.recordFailure(OWNER, botnet(i));
    svc.recordSuccess(OWNER, HOME);

    expect(waitSeconds(svc, OWNER, botnet(999))).toBe(0);
    svc.recordFailure(OWNER, botnet(16));
    expect(waitSeconds(svc, OWNER, botnet(999))).toBe(0);
  });

  it('an hour with no failures and the count starts again', () => {
    for (let i = 0; i < 12; i++) svc.recordFailure(OWNER, botnet(i));
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(waitSeconds(svc, OWNER, botnet(999))).toBe(0);

    svc.recordFailure(OWNER, botnet(50));
    expect(waitSeconds(svc, OWNER, botnet(999))).toBe(0);
  });

  it('with lockout off it is quiet too', () => {
    const off = serviceWith({ LOGIN_LOCK_MINUTES: '0' });
    for (let i = 0; i < 200; i++) off.recordFailure(OWNER, botnet(i));
    expect(waitSeconds(off, OWNER, botnet(999))).toBe(0);
  });
});
