import { reportCrash } from '../api/errorReporting';

/**
 * Sends what crashed in this browser to the server (Settings → Error
 * reporting decides whether it goes on to Sentry). The same error reported
 * twice in a row is sent once — a render loop would otherwise repeat it.
 */
let last = '';

export function sendCrash(error: unknown, componentStack?: string | null): void {
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : 'Unknown error');

  const key = `${err.name}:${err.message}`;
  if (key === last) return;
  last = key;

  void reportCrash({
    name: err.name.slice(0, 100) || 'Error',
    message: err.message.slice(0, 2000),
    stack: err.stack?.slice(0, 10000),
    componentStack: componentStack?.slice(0, 5000) || undefined,
    // the path only — the server turns ids into :id, the query never leaves
    path: window.location.pathname.slice(0, 500),
  });
}

let installed = false;

/** Errors outside React's render (event handlers, timers, promises) */
export function installCrashReports(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    // a failed <img>/<script> load has no error object — not a crash
    if (event.error) sendCrash(event.error);
  });
  window.addEventListener('unhandledrejection', (event) => {
    // an aborted fetch is someone leaving the page, not a bug
    const reason: unknown = event.reason;
    if (reason instanceof Error && reason.name === 'AbortError') return;
    // a refused request — the server already knows about its own 500s
    if (reason instanceof Error && reason.name === 'ApiError') return;
    sendCrash(reason);
  });
}
