import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import {
  fetchCurrency,
  fetchDisplayLocale,
  fetchWorkTimeZone,
} from './api/auth';
import { App } from './App';
import './index.css';
import { installCrashReports } from './lib/crash-reports';
import { setCurrency, setDisplayLocale, setWorkTimeZone } from './lib/format';
import { registerServiceWorker } from './pwa';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

/**
 * The work-day zone comes from the server before the first render: pages
 * compute "today" once, in `useState` initialisers. If the request fails or
 * is slow (older server without the endpoint, offline PWA), the default
 * Asia/Dhaka stays — the same behaviour as before the zone was configurable.
 */
async function loadWorkTimeZone(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    setWorkTimeZone(await fetchWorkTimeZone(controller.signal));
  } catch {
    // keep the default
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The currency symbol comes from the server before the first render, so no
 * amount is ever drawn with the wrong one. If the request fails or is slow
 * (older server, offline PWA) the default ৳ stays — as before.
 */
async function loadCurrency(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    setCurrency(await fetchCurrency(controller.signal));
  } catch {
    // keep the default
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The display locale comes from the server before the first render, so no
 * date is drawn in one format and redrawn in another. If the request fails or
 * is slow (older server, offline PWA) the default formats stay — as before.
 */
async function loadDisplayLocale(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    setDisplayLocale((await fetchDisplayLocale(controller.signal)).locale);
  } catch {
    // keep the default
  } finally {
    clearTimeout(timer);
  }
}

// crashes outside React's render go to the server too (Settings → Error reporting)
installCrashReports();

// all in parallel — none waits for another
void Promise.all([
  loadWorkTimeZone(),
  loadCurrency(),
  loadDisplayLocale(),
]).then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

/**
 * PWA: the app shell is cached so it can be opened from the home screen.
 *
 * Careful: called after render: the function itself waits for the `load` event,
 * so it does not compete with the first paint.
 * Careful: the service worker caches no API responses, for the reason written in
 * `pwa-sw.ts` (live numbers + screenshots).
 */
registerServiceWorker();
