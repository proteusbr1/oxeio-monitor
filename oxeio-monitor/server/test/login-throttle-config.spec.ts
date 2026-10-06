import { describe, expect, it } from 'vitest';

import { resolveThrottle } from '../src/auth/login-throttle.config';

/**
 * Reading the login lockout settings from `.env`.
 *
 * A mistake in this function is the worst kind — login is the only door in.
 * Too strict and the owner locks themselves out of their own system; if it
 * silently switches off, nobody knows the protection is gone. So the
 * boundary cases dominate here.
 */
describe('resolveThrottle', () => {
  it('soft defaults when nothing is given — 10 attempts, 2 minutes', () => {
    const t = resolveThrottle({});

    expect(t.enabled).toBe(true);
    expect(t.maxFails).toBe(10);
    expect(t.lockMs).toBe(2 * 60 * 1000);
  });

  it('given values are honoured', () => {
    const t = resolveThrottle({ maxFails: '20', lockMinutes: '5' });

    expect(t.maxFails).toBe(20);
    expect(t.lockMs).toBe(5 * 60 * 1000);
  });

  /** What the owner asked for — lockout switched off entirely */
  it('zero minutes means lockout off', () => {
    const t = resolveThrottle({ lockMinutes: '0' });

    expect(t.enabled).toBe(false);
    expect(t.lockMs).toBe(0);
  });

  /**
   * `Number('')` gives zero. If an empty string counted as zero, merely
   * writing `LOGIN_LOCK_MINUTES=` in `.env` would silently switch the
   * protection off — nobody meant to disable it, and nobody would notice.
   */
  it('an empty value does not mean off, it means the default', () => {
    expect(resolveThrottle({ lockMinutes: '' }).enabled).toBe(true);
    expect(resolveThrottle({ lockMinutes: '   ' }).enabled).toBe(true);
    expect(resolveThrottle({ lockMinutes: null }).enabled).toBe(true);
    expect(resolveThrottle({ lockMinutes: undefined }).enabled).toBe(true);
  });

  /** A typo in `.env` does not stop the server — it falls back to the default */
  it('a meaningless value falls back to the default', () => {
    expect(resolveThrottle({ lockMinutes: 'ten' }).lockMs).toBe(2 * 60 * 1000);
    expect(resolveThrottle({ maxFails: 'abc' }).maxFails).toBe(10);
  });

  /**
   * Without the upper limit above, `LOGIN_LOCK_MINUTES=100000` would be an
   * effectively permanent lock, and since the counter is in memory the only
   * way back would be a server restart — one typo locking the whole office.
   */
  it('an unusually large value falls back to the default', () => {
    expect(resolveThrottle({ lockMinutes: '100000' }).lockMs).toBe(2 * 60 * 1000);
    expect(resolveThrottle({ maxFails: '99999' }).maxFails).toBe(10);
  });

  it('a negative value falls back to the default, not off', () => {
    const t = resolveThrottle({ lockMinutes: '-5', maxFails: '-1' });

    expect(t.enabled).toBe(true);
    expect(t.maxFails).toBe(10);
  });

  /** Lock after one mistake — strict, but the owner's right if they want it */
  it('the strictest value can be given too', () => {
    const t = resolveThrottle({ maxFails: '1', lockMinutes: '60' });

    expect(t.maxFails).toBe(1);
    expect(t.lockMs).toBe(60 * 60 * 1000);
  });

  it('a decimal is cut down', () => {
    expect(resolveThrottle({ maxFails: '7.9' }).maxFails).toBe(7);
  });

  it('a number (not a string) works too', () => {
    expect(resolveThrottle({ maxFails: 12, lockMinutes: 3 }).maxFails).toBe(12);
  });
});
