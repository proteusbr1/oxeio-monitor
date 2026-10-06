import { useCallback, useEffect, useRef, useState } from 'react';

import { translate } from '../i18n';

/**
 * F05: .xlsx download.
 *
 * `api<T>()` is not used. It always assumes the response is JSON and calls
 * `JSON.parse()`, while the server sends binary here, so the file would arrive
 * and then be lost as a `SyntaxError`. Hence a separate `fetch`, then `blob()`.
 *
 * A plain `<a href download>` would work too, but then there would be no way to
 * know when it finished. For a one-year range the server takes several seconds;
 * if the button sits silent during that time people press it repeatedly, and each
 * press makes the server build the whole report again. With fetch the button can
 * be disabled and say "Preparing...". On failure the message can also be shown
 * on screen: with `<a>`, a 403 would make the browser silently save a JSON file.
 */

/** `attachment; filename="oxeio-attendance-2026-08-01_2026-08-11.xlsx"` */
const DISPOSITION_NAME = /filename="?([^";]+)"?/i;

export interface XlsxDownload {
  /** A download is running: keep the button disabled. */
  busy: boolean;
  error: string | null;
  start: (url: string, fallbackName: string) => void;
  /**
   * Clear the old error. Careful: call it when the tab changes; otherwise an error
   * from downloading Attendance would stay hanging on the Summary tab too, and
   * it would look as if something were wrong with the Summary.
   */
  clear: () => void;
}

export function useXlsxDownload(): XlsxDownload {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Careful: building the file takes a few seconds; if the user moves to another
  // tab meanwhile, `setState` would run after unmount (React's warning, and in
  // practice a lost error). So check that it is still alive.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = useCallback((url: string, fallbackName: string) => {
    setBusy(true);
    setError(null);

    void (async () => {
      try {
        // Careful: without `credentials: 'include'` the session cookie is not sent; a
        // 401 would then come and throw the user suddenly onto the login screen.
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(await messageOf(res));

        saveBlob(await res.blob(), filenameOf(res) ?? fallbackName);
      } catch (err) {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : translate("Couldn't download the file"));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  }, []);

  const clear = useCallback(() => setError(null), []);

  return { busy, error, start, clear };
}

/**
 * Careful: on failure the server sends JSON (not binary), so the message can be
 * extracted. The 403 sentence is exactly what `<ErrorBox>` says ("You don't have
 * access"), so the two places do not sound different. Change it there and change it here.
 *
 * Careful: the middle `body.message` is the server's own text, shown as it
 * comes (as in `<ErrorBox>`; the server is the place to settle language, not the client).
 */
async function messageOf(res: Response): Promise<string> {
  if (res.status === 403) return translate("You don't have access");
  if (res.status === 401) return translate('Your session ended — please sign in again');

  try {
    const body = (await res.json()) as { message?: string | string[] } | null;
    const message = body?.message;
    if (Array.isArray(message)) return message.join(', ');
    if (typeof message === 'string') return message;
  } catch {
    // Body empty or binary: the generic message below will be used
  }

  return translate("Couldn't build the file ({{status}})", { status: res.status });
}

/**
 * Careful: the server decides the name (`reportFilename` in `reports.excel.ts`),
 * because the range is written in the file name. If the header cannot be read (a
 * proxy trimmed it) there is a fallback; otherwise the browser would save it as
 * `download.xlsx` and there would be no way to tell which report is which in the
 * downloads folder.
 */
function filenameOf(res: Response): string | null {
  const header = res.headers.get('Content-Disposition');
  const match = header ? DISPOSITION_NAME.exec(header) : null;
  return match ? match[1] : null;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Careful: `revokeObjectURL` must be called; otherwise the whole file stays in
  // memory until the tab is closed, and someone downloading reports does it ten
  // times in a row. But it cannot be revoked right after `click()`: the browser
  // is still reading the URL, and removing it would cancel the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
