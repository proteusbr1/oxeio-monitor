import { describe, expect, it } from 'vitest';

import {
  describeFailed,
  failedCapabilities,
  sameCapabilities,
  sanitizeCapabilities,
} from '../src/agent/capabilities.rules';

/**
 * The capability report is cleaned, never refused: a heartbeat answered with
 * 400 would also lose its commands, revoke among them.
 */
describe('sanitizeCapabilities', () => {
  it('an older agent sends nothing — null, so nothing is stored', () => {
    expect(sanitizeCapabilities(undefined)).toBeNull();
    expect(sanitizeCapabilities(null)).toBeNull();
  });

  it.each([
    ['a string', 'ok'],
    ['a list', ['ok']],
    ['a number', 3],
  ])('garbage (%s) is null, not an error', (_, raw) => {
    expect(sanitizeCapabilities(raw)).toBeNull();
  });

  it('keeps known parts with known states, drops the rest', () => {
    expect(
      sanitizeCapabilities({
        browserDomain: 'degraded',
        sync: 'ok',
        somethingNew: 'failed',
        screenCapture: 'on fire',
      }),
    ).toEqual({ browserDomain: 'degraded', sync: 'ok' });
  });
});

describe('what raises an alert', () => {
  it('failed only — degraded is shown, never alerted; off by policy is a choice', () => {
    const report = sanitizeCapabilities({
      screenCapture: 'disabled_by_policy',
      browserDomain: 'degraded',
      screenActivity: 'failed',
      sync: 'ok',
    });

    expect(failedCapabilities(report)).toEqual(['screenActivity']);
    expect(describeFailed(report!)).toBe('Jiggler check');
  });

  it('a retry or two on upload is degraded, so no alert', () => {
    expect(
      failedCapabilities(sanitizeCapabilities({ sync: 'degraded' })),
    ).toEqual([]);
  });
});

describe('sameCapabilities — only a change is written', () => {
  it('key order does not matter', () => {
    expect(
      sameCapabilities(
        sanitizeCapabilities({ sync: 'ok', idleProbe: 'ok' }),
        sanitizeCapabilities({ idleProbe: 'ok', sync: 'ok' }),
      ),
    ).toBe(true);
  });

  it('a changed state is a change', () => {
    expect(
      sameCapabilities(
        sanitizeCapabilities({ sync: 'ok' }),
        sanitizeCapabilities({ sync: 'degraded' }),
      ),
    ).toBe(false);
  });

  it('first report after none is a change', () => {
    expect(sameCapabilities(null, sanitizeCapabilities({ sync: 'ok' }))).toBe(
      false,
    );
  });
});
