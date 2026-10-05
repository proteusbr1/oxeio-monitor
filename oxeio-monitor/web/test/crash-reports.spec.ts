import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function setup() {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('document', { cookie: 'oxeio_csrf=tok' });
  vi.stubGlobal('window', { location: { pathname: '/staff/12' } });
  const { sendCrash } = await import('../src/lib/crash-reports');
  return { fetch, sendCrash };
}

describe('crash reports from the dashboard', () => {
  it('sends the error and the page path to the server, never the query', async () => {
    const { fetch, sendCrash } = await setup();
    sendCrash(new TypeError("reading 'name'"), '\n at StaffRow');

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/error-reports');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body).toMatchObject({
      name: 'TypeError',
      message: "reading 'name'",
      path: '/staff/12',
      componentStack: '\n at StaffRow',
    });
  });

  it('the same crash twice in a row is sent once (a render loop)', async () => {
    const { fetch, sendCrash } = await setup();
    sendCrash(new Error('boom'));
    sendCrash(new Error('boom'));
    sendCrash(new Error('other'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a failed report is swallowed — and does not sign anyone out', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('document', { cookie: '' });
    vi.stubGlobal('window', { location: { pathname: '/' } });
    const client = await import('../src/api/client');
    const signOut = vi.fn();
    client.setUnauthorizedHandler(signOut);
    const { reportCrash } = await import('../src/api/errorReporting');

    await expect(reportCrash({ name: 'E', message: 'm', path: '/' })).resolves.toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
  });
});
