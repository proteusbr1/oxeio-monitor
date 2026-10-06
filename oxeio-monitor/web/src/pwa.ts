/**
 * Registers the service worker: the only place in the app where `sw.js`
 *    is started.
 *
 * The service worker itself is in `src/pwa-sw.ts`, and the full explanation of
 * what it caches (and, importantly, what it **never** caches) is at the top of that file.
 */

/**
 * Careful: updates are checked at most once an hour.
 *
 * This app is opened from the phone's home screen, and then the tab stays
 *    open **for days on end**; nobody "closes and reopens" it. The browser itself
 *    checks for updates only at navigation, so without this a new deploy would take
 *    about a week to reach phones, while on desktop everyone saw the new code.
 *    "It looks different on my phone" bugs are the hardest to track down.
 * Careful: written without the throttle, every switch in and out of the app
 *    switcher would fetch `/sw.js` again: needless cost on mobile data.
 */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  /**
   * Careful: in dev mode it does **not register, quite the opposite**: whatever exists is removed.
   *
   * `sw.js` is only produced by `vite build` (the plugin in `vite.config.ts`).
   * The dev server does not have the file, so registering would only give a 404.
   *
   * The real danger is the other way round: once someone runs `npm run
   *    preview` and installs the worker on localhost, it **stays on the
   *    origin**. Back on `npm run dev`, that old worker would sit on navigations
   *    and serve the old built app, and the developer would keep changing code
   *    and see nothing change. Falling into this trap once costs hours.
   */
  if (!import.meta.env.PROD) {
    void navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
      // Careful: stay quiet: failing to remove the worker in dev is no reason to break the app.
      .catch(() => {});
    return;
  }

  /**
   * Careful: after `load`, not before. Registration itself downloads `sw.js`
   *    and install downloads the whole shell again; competing with the first
   *    render for bandwidth would make the page arrive late on a slow
   *    connection. The PWA's benefit is for next time, not at the cost of this time's speed.
   */
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => watchForUpdates(registration))
      /**
       * Careful: if it fails, stay quiet. Without HTTPS (except localhost) the
       *    browser blocks registration, and some corporate/privacy settings do too.
       *    Neither breaks the app: without a service worker the dashboard works
       *    exactly as before, only the home-screen/offline benefit is missing.
       */
      .catch(() => {});
  });
}

/**
 * When the tab becomes visible again, check whether a new version has come.
 *
 * If something new is found, the service worker does the rest itself
 *    (`skipWaiting` + `clientsClaim`, as explained in `pwa-sw.ts`). A reload is
 *    not forced here: the user may be in the middle of filling a form.
 */
function watchForUpdates(registration: ServiceWorkerRegistration): void {
  let lastCheck = Date.now();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return;
    lastCheck = Date.now();
    // Careful: stay quiet: offline this is bound to fail, and that is normal.
    void registration.update().catch(() => {});
  });
}
