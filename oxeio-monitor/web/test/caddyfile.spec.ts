import { describe, expect, it } from 'vitest';

// ⚠️ `?raw`, like api-callers.spec.ts — the web tests have no Node types
import raw from '../Caddyfile?raw';

/**
 * Guards for web/Caddyfile behind another proxy. Caddy itself is not run
 * here; these lines pin the three things the behaviour depends on (checked
 * end to end with containers when the change was made — see the PR).
 */
const caddyfile = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

describe('Caddyfile — client IP behind a reverse proxy', () => {
  it('trusts no proxy unless CADDY_TRUSTED_PROXIES says so', () => {
    // no default after the variable: empty = Caddy is the edge, as before
    expect(caddyfile).toMatch(
      /trusted_proxies static \{\$CADDY_TRUSTED_PROXIES\}/,
    );
  });

  it('keys the login rate limit on the client IP, not the connecting address', () => {
    expect(caddyfile).toMatch(/key \{client_ip\}/);
    expect(caddyfile).not.toMatch(/key \{remote_host\}/);
  });

  it('hands the API a single, already decided address', () => {
    expect(caddyfile).toMatch(/header_up X-Forwarded-For \{client_ip\}/);
  });
});
