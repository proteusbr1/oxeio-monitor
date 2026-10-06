/**
 * Service worker: caches the app shell, **never the API**.
 *
 * ═══ Why hand-written, not `vite-plugin-pwa` ═════════════════════════════
 *
 * The plugin pulls in workbox: not one dependency but twenty. This repo's
 *    web app has **three** deps (react, react-dom, react-router-dom), and that
 *    is deliberate.
 * Careful: the real reason is not size but **control**: by default workbox
 *    caches many things at runtime (images, fonts, same-origin GETs). In this
 *    app `/api/v1/screenshots/*` is **employees' screen pictures**; letting
 *    those pile up on a device's disk means everything leaks if the phone is
 *    lost. Reading, in 50 lines, the file that does the caching is safer than
 *    trusting "I switched the defaults off".
 * The one thing the plugin would really be needed for, the list of hashed
 *    files, is injected here at build time by the small plugin in
 *    `vite.config.ts`. Written by hand, the list would break on every build.
 *
 * ═══ The caching policy ═══════════════════════════════════════════════
 *
 *   `/api/*`          → **never touched**. The `fetch` handler excludes it
 *                        first of all, so the request goes straight to the
 *                        network, as if there were no service worker.
 *   navigation        → **network first**, else the cached `/index.html`
 *   `/assets/*` (hash)→ cache first (the hash is in the name, so it cannot change)
 *   icons, manifest   → cache first
 *   everything else   → network, nothing is cached
 *
 * Important: **there are two reasons for not caching API responses, both core
 * principles of this project:**
 *   1. This is a **live** monitoring dashboard. Showing yesterday's numbers
 *      offline makes the numbers lie: it says "this is it" for "I don't know".
 *      The owner calculates pay from those numbers.
 *   2. Screenshots are sensitive (above).
 *   With no network an API call fails, and the app's own error state cleanly
 *   says "no connection": that is the correct answer.
 */

/* ── Types ────────────────────────────────────────────────────────────────
   Careful: `ServiceWorkerGlobalScope`, `FetchEvent`, `ExtendableEvent` are in
      TypeScript's `"WebWorker"` lib, not in `"DOM"`. But this file is under
      `tsconfig.app.json`, where the whole rest of the app assumes DOM. Giving
      both libs together declares `self`/`fetch` twice in different ways and
      the whole project would fill with type errors.
   So these are small declarations of only what is really used: six members,
      all used below. Less machinery than building a separate tsconfig. */

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface ServiceWorkerScope {
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  readonly location: Location;
}

const sw = self as unknown as ServiceWorkerScope;

/* ── Two values injected at build time ─────────────────────────────────────
   Careful: the two placeholders are replaced by the `oxeio-service-worker`
      plugin in `vite.config.ts`. If they are **not replaced the plugin stops
      the build**; otherwise `JSON.parse('__OXEIO_PRECACHE__')` would run here and
      the service worker would silently never install, while the build looked green.
   The `JSON.parse(...)` wrapper is deliberate: the minifier keeps the string
      literal exactly, so the place to replace can still be found after the build. */

/** This build's app shell: `/index.html` + the hashed `/assets/*` */
const SHELL = JSON.parse('__OXEIO_PRECACHE__') as string[];

/**
 * A hash made from the shell list, **for the cache name**.
 *
 * Careful: without a version in the cache name, a new build's files would sit
 *    beside the old ones and the old ones would never be deleted. In a year
 *    useless bundles would pile up in the phone's storage and the user would
 *    never know why.
 *
 * Careful: this is **not the update signal**; that is the browser's job. It
 *    downloads `/sw.js` again and compares bytes; one byte of difference makes
 *    a new worker. So if only this file's code changes (the list staying the
 *    same) the hash stays the same, yet the update still arrives; and not
 *    changing the cache name is then right, because the files inside are identical.
 */
const VERSION = '__OXEIO_SW_VERSION__';

const CACHE = `oxeio-shell-${VERSION}`;

/**
 * Careful: files in `public/` get no hash, so the list cannot come from the
 *    build; it is hand-written. The paths are a **contract** with the icon
 *    agent; if changed, `index.html` and `manifest.webmanifest` must change too.
 * Careful: these are **best-effort**: install succeeds even if one is missing (see below).
 */
const STATIC = [
  '/manifest.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

/** Paths eligible to be served from the cache; everything else goes straight to the network */
const PRECACHED = new Set([...SHELL, ...STATIC]);

/**
 * How long to wait for the network, for navigation.
 *
 * Careful: on mobile data a fetch can take even 30 seconds to fail (a "there
 *    but not working" connection). For that long the app would seem **frozen**
 *    on the phone, while the whole shell sits in the cache. `/index.html` is a
 *    few kilobytes; if it has not come in 4 seconds it is no longer a "slow network".
 */
const NAV_TIMEOUT_MS = 4000;

/**
 * The cache lookup options: **without both, the app would not open offline.**
 * (This bug was really hit: with the server stopped and a refresh, `index.html`
 *  came from the cache but JS and CSS gave `net::ERR_FAILED`, though both were
 *  in the cache. Result: a black blank screen.)
 *
 * Careful: `ignoreVary` has a subtle and cruel reason. When filling the cache,
 *    `cache.addAll()` sends requests **without an `Origin` header**, but the
 *    `<script crossorigin>` request from the page **has** `Origin`. If the
 *    server answers with `Vary: Origin` (Vite preview does, and any
 *    CORS-aware server may), the browser treats the two as **different**: a
 *    cache miss, then the network, then failure offline. `Vary` is of no use
 *    to us: everything here is our own shell, one file per path.
 * Careful: `ignoreSearch` lets the same file match even with a query like `?v=2`.
 */
const MATCH: CacheQueryOptions = { ignoreSearch: true, ignoreVary: true };

/* ── install ─────────────────────────────────────────────────────────── */

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);

      /**
       * Careful: the shell goes through `addAll`: if even one is missing the
       *    **whole thing fails**, and that is wanted. A half-cached shell would
       *    serve HTML offline but no JS: a permanent white screen, worse than
       *    showing a network error.
       */
      await cache.addAll(SHELL);

      /**
       * The icons use `allSettled`: one missing does not block install.
       *
       * Careful: with `addAll`, a single icon returning 404 would mean the service
       *    worker never installs, i.e. **offline support gone entirely**, over one
       *    picture. A missing icon is a small problem, a missing shell a big one.
       */
      await Promise.allSettled(STATIC.map((url) => cache.add(url)));

      /**
       * `skipWaiting`: the new version **does not sit waiting**.
       *
       * Why this was chosen over a "new version available, please refresh" message:
       *   1. The app has no `import()`: the whole code is **one** bundle. With lazy
       *      chunks skipWaiting would be dangerous: the running page would later ask
       *      for an old chunk that no longer exists on the server after a new
       *      deploy, giving a 404. One bundle means the running page works from
       *      memory and asks for nothing.
       *   2. Navigation is network-first, so an online user gets a fresh
       *      `index.html` on the very next navigation; leaving a worker waiting
       *      would run old code until the tab is closed. Nobody "closes" a phone
       *      home-screen app; it stays open for days.
       *   3. Showing the message would need a toast in `src/components/**`,
       *      which would duplicate what `VersionBadge` does.
       *
       * Careful: this does **not fight `VersionBadge`**; it is the last net. The
       *    badge compares the web and api builds; if the shell somehow stays old,
       *    a red `⚠ #123` lights up in the corner. So a silent old-code state
       *    can never arise.
       * Careful: the page is **not reloaded by itself** (not on `controllerchange`).
       *    If it were, the page would jump while someone is filling a form or picking a date.
       */
      await sw.skipWaiting();
    })(),
  );
});

/* ── activate ────────────────────────────────────────────────────────── */

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      /**
       * Careful: only caches with **our own** prefix are deleted. `caches.keys()`
       *    should hold nothing else, but written without the filter, if someone
       *    later adds a second cache this line would silently delete it.
       */
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('oxeio-shell-') && name !== CACHE)
          .map((name) => caches.delete(name)),
      );

      /**
       * `clients.claim()`: this worker takes over the open tabs right away.
       * Careful: without it, after the **first** install the worker would do
       *    nothing until the next navigation: install, go into flight mode, and
       *    offline would not work, with a cause almost impossible to find.
       */
      await sw.clients.claim();
    })(),
  );
});

/* ── fetch ───────────────────────────────────────────────────────────── */

sw.addEventListener('fetch', (event) => {
  const request = event.request;

  /**
   * Careful: GET only. Not calling `respondWith` for POST/PATCH/DELETE is the
   *    only correct behaviour; login or saving settings going through a cache would be terrible.
   */
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Careful: another origin (if one ever appears) is not our business.
  if (url.origin !== sw.location.origin) return;

  /**
   * **The most important four lines in this file.**
   *
   * On seeing `/api/*` the handler returns at once: `respondWith` is not
   * called, so the browser sends the request to the network itself, exactly as
   * if there were no service worker.
   *
   * Careful: this comes **first**, deliberately. Put later, one day someone
   *    would add a new rule above it ("cache all images") and screenshots would
   *    silently start piling up on disk. Here, no rule ever reaches an API path.
   * Careful: `=== '/api'` is also caught, for the path without a slash.
   */
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  /**
   * Navigation (typing an address, refresh, opening from the home screen): every
   *    route gets `/index.html`, because routing is on the client (react-router).
   *    There is no file called `/monthly` on disk.
   */
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }

  if (PRECACHED.has(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else: nothing is done, i.e. network, and nothing is cached.
});

/**
 * Navigation: **network first, then cache.**
 *
 * The opposite (cache first) would be wrong here. Serving from the cache, even
 *    after a deploy the user would get the **old app** at least once; on a live
 *    dashboard, where the definition of a number may change, that would show
 *    wrong figures as "old code showing new data". When online, **always fresh
 *    code**: that is the rule.
 *
 * Careful: `index.html` is a few kilobytes and Caddy gives it `no-cache`, so
 *    the cost of going to the network on every open is almost zero.
 */
async function navigate(request: Request): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS);

  try {
    return await fetch(request, { signal: controller.signal });
  } catch {
    /**
     * No network (or so slow that it is as good as none): the stored shell is served.
     *
     * The app **opens**, and its own API calls fail and show "no connection" on
     *    the page. Careful: no old numbers are shown; no API response is stored
     *    anywhere. Instead of the browser's dinosaur page, an honest answer in the app's own words.
     */
    const cache = await caches.open(CACHE);
    const shell = await cache.match('/index.html', MATCH);
    return shell ?? offlineResponse();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Careful: if even the shell is not in the cache (the very first open is
 *    offline), still not the browser's error page but our own message. The text
 *    is English because the whole interface is English.
 */
function offlineResponse(): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8">' +
      '<title>oXeio — offline</title>' +
      '<body style="font-family:system-ui;background:#0e1116;color:#e8ecf1;' +
      'display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
      '<div><h1 style="font-size:1.1rem">No connection</h1>' +
      '<p style="color:#a6b0bd;font-size:.9rem">oXeio cannot reach the server. ' +
      'Live figures are never shown from a stale copy.</p></div>',
    {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    },
  );
}

/**
 * Hashed assets and icons: from the cache if present, otherwise the network.
 *
 * Careful: a response fetched from the network is **not put back in the
 *    cache**. If it were, this handler would turn into "store everything that
 *    is asked for", and then the list would be pointless, which is exactly
 *    what hand-writing it avoids.
 */
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, MATCH);
  return hit ?? fetch(request);
}
