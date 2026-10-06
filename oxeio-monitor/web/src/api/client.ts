const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Set when the server sends the mustChangePassword flag. */
    readonly mustChangePassword = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The CSRF token is read from the cookie. The server deliberately does not make it
 * httpOnly: the double-submit technique relies on a different origin being able to
 * send the cookie but not read it (ADR-016).
 */
function csrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)oxeio_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skip the automatic logout on 401 (e.g. for the login call itself). */
  silent401?: boolean;
  /**
   * Used to cancel stale requests (`useApi` relies on it).
   *
   * Careful: a cancelled fetch throws an `AbortError`, which is NOT an `ApiError`.
   * Filter with `isAbortError()` before any catch that shows "something went
   * wrong", otherwise harmless actions like changing the date would flash an error.
   */
  signal?: AbortSignal;
}

/** A cancelled request is not a failure, so it needs to be recognised separately. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

type Unauthorized = () => void;
let onUnauthorized: Unauthorized = () => {};

export function setUnauthorizedHandler(fn: Unauthorized): void {
  onUnauthorized = fn;
}

export async function api<T>(
  path: string,
  { method = 'GET', body, silent401 = false, signal }: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};

  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (MUTATING.has(method)) {
    const token = csrfToken();
    if (token) headers['X-CSRF-Token'] = token;
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    // required so the cookie is sent
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const p = payload as {
      message?: string | string[];
      mustChangePassword?: boolean;
    } | null;

    /**
     * Careful: `p.message` is the server's message, and the server still speaks
     * Bengali, so it reaches the screen in Bengali (see `<ErrorBox>`). It is not
     * translated here: a translation table would let new server messages slip
     * through untranslated without anyone noticing. The fallback below is our own
     * text, so it is in English.
     */
    const message = Array.isArray(p?.message)
      ? p.message.join(', ')
      : (p?.message ?? `Request failed (${res.status})`);

    if (res.status === 401 && !silent401) onUnauthorized();

    throw new ApiError(res.status, message, p?.mustChangePassword === true);
  }

  return payload as T;
}
