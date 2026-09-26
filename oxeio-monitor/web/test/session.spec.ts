import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSession } from '../src/auth/session';
afterEach(() => vi.unstubAllGlobals());
describe('session verification', () => {
  it('retains the server user on success', async () => {
    const user = { userId: 1, role: 'owner' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(user), { status: 200 })));
    expect(await loadSession()).toEqual({ kind: 'authenticated', user });
  });
  it('requires sign-in for 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    expect(await loadSession()).toEqual({ kind: 'signed-out' });
  });
  it.each([403, 429, 500, 502, 503])('keeps session state unknown for HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    expect(await loadSession()).toEqual({ kind: 'unavailable' });
  });
  it('does not confuse a network outage with an expired session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await loadSession()).toEqual({ kind: 'unavailable' });
  });
});
