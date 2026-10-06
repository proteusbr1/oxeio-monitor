import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
} from 'react';

import { isAbortError } from './client';

/**
 * Two data-fetching hooks: `useApi` (once) and `usePolling` (repeatedly).
 *
 * In all six pages, do not write `useEffect` + `fetch` by hand. Avoiding the
 * three traps below separately in every page is nearly impossible:
 *   - `setState` after unmount
 *   - a race: an old request returns late and overwrites newer data
 *   - polling all night in a hidden tab
 */

export interface ApiResult<T> {
  /** The last successful response; `null` if none has arrived. */
  data: T | null;
  /** On failure; for an `ApiError`, check `.status` to tell a 403 apart. */
  error: Error | null;
  /** Whether a request is in flight right now. */
  loading: boolean;
  /** When the last successful response arrived; for showing "Last updated 22:10". */
  updatedAt: Date | null;
  /** Fetch again; can be passed straight to `<ErrorBox retry={reload}>`. */
  reload: () => void;
}

export interface PollingResult<T> extends ApiResult<T> {
  /** Polling is paused because the tab is hidden; a page can say so if it wants. */
  paused: boolean;
}

/**
 * Careful: the fetcher receives a `signal`. Pass it on to `api()` so a cancelled
 * request is also dropped from the network:
 *
 * `useApi((signal) => getLiveBoard(signal), [])`
 */
export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

interface State<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  updatedAt: Date | null;
}

const INITIAL: State<never> = {
  data: null,
  error: null,
  loading: true,
  updatedAt: null,
};

/**
 * One round of fetching. Fetches again when `deps` change.
 *
 * ```tsx
 * const { data, error, loading, reload } = useApi(
 *   (signal) => getTimeline(employeeId, date, signal),
 *   [employeeId, date],
 * );
 * if (loading && !data) return <Loading />;
 * if (error) return <ErrorBox error={error} retry={reload} />;
 * if (!data || data.segments.length === 0) return <Empty title="…" />;
 * ```
 *
 * Careful: when `deps` change, `data` is cleared, so the previous employee's hours
 * are never shown, even for a moment, under another employee's name.
 */
export function useApi<T>(
  fetcher: Fetcher<T>,
  deps: DependencyList = [],
): ApiResult<T> {
  const runner = useRunner(fetcher, true);
  const { run, invalidate, tick } = runner;

  useEffect(() => {
    const controller = run();
    return () => {
      // Both are needed: `abort()` stops the network, `invalidate()` makes a late
      // response useless. Relying on abort alone is not enough: the response may have
      // already arrived and be waiting in the `.then` queue.
      invalidate();
      controller.abort();
    };
    // Careful: `deps` is deliberately spread: the calling page knows which values
    // should trigger a refetch, not this hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, invalidate, tick, ...deps]);

  return { ...runner.state, reload: runner.reload };
}

/**
 * Refetch every `intervalMs` milliseconds: the live board's 30 seconds (E01).
 *
 * The old `data` is not cleared: a board that went blank every 30 seconds could
 * not be read. While a refresh runs `loading` is true and the data stays the
 * previous data.
 *
 * Careful: the timer stops while the tab is hidden (`document.hidden`). Otherwise
 * someone leaving a dashboard open and going home would hit the server every 30
 * seconds all night: 21,600 requests overnight from fifteen tabs. On returning to
 * the tab it fetches once immediately, otherwise the user would look at a stale
 * board for 30 seconds without knowing.
 */
export function usePolling<T>(
  fetcher: Fetcher<T>,
  intervalMs: number,
  deps: DependencyList = [],
): PollingResult<T> {
  const runner = useRunner(fetcher, false);
  const { run, invalidate, tick } = runner;
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let controller: AbortController | null = null;
    let timer: number | undefined;

    const fetchNow = (): void => {
      controller?.abort();
      controller = run();
    };

    const startTimer = (): void => {
      window.clearInterval(timer);
      timer = window.setInterval(fetchNow, intervalMs);
    };

    const stopTimer = (): void => {
      window.clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = (): void => {
      if (document.hidden) {
        setPaused(true);
        stopTimer();
        return;
      }
      setPaused(false);
      fetchNow();
      startTimer();
    };

    // Careful: the first fetch always happens, even when the tab is hidden;
    // otherwise returning to a tab opened in the background would show an empty
    // screen for 30 seconds.
    fetchNow();
    setPaused(document.hidden);
    if (!document.hidden) startTimer();

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopTimer();
      invalidate();
      controller?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, invalidate, tick, intervalMs, ...deps]);

  return { ...runner.state, reload: runner.reload, paused };
}

// ── Internals ───────────────────────────────────────────────────────────────

interface Runner<T> {
  state: State<T>;
  /** Starts a request and returns its controller. */
  run: () => AbortController;
  /** Results of in-flight requests will no longer be used. */
  invalidate: () => void;
  reload: () => void;
  /**
   * Careful: `reload()` increments this, and because it is in the effect's deps the
   * effect runs again. If it were left out of the deps, the reload button would
   * silently do nothing: no error, just a dead button.
   */
  tick: number;
}

/**
 * Machinery shared by both hooks.
 *
 * The generation counter is the real point here. `AbortController` alone is not
 * enough: if a new request starts after the response has already arrived but
 * before `.then` has run, abort can no longer stop anything and the old result
 * would land on top of the new one. For example, if the date is changed twice
 * quickly, the 10th's data could end up on the 9th's screen.
 */
function useRunner<T>(fetcher: Fetcher<T>, clearOnStart: boolean): Runner<T> {
  const [state, setState] = useState<State<T>>(INITIAL as State<T>);

  // Careful: the fetcher's identity changes on every render (arrow function), so
  // it cannot go in the deps, which would cause an infinite loop. It is kept in a
  // ref so the latest one is always called. Careful: it is assigned in an
  // effect, not during render.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const genRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    // Careful: in StrictMode the effect runs twice (mount, cleanup, mount), so
    // `true` must be set every time. Otherwise the second mount would never set any
    // data, and since this only happens in dev it would not even be noticed.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const invalidate = useCallback(() => {
    genRef.current += 1;
  }, []);

  const run = useCallback((): AbortController => {
    genRef.current += 1;
    const gen = genRef.current;
    const controller = new AbortController();

    setState((prev) =>
      clearOnStart
        ? { data: null, error: null, loading: true, updatedAt: null }
        : { ...prev, loading: true, error: null },
    );

    void fetcherRef.current(controller.signal).then(
      (data) => {
        if (gen !== genRef.current || !aliveRef.current) return;
        setState({ data, error: null, loading: false, updatedAt: new Date() });
      },
      (err: unknown) => {
        // A cancelled request is not a failure. Showing it as an error would put a red
        // message on screen even for harmless actions like changing the date.
        if (isAbortError(err)) return;
        if (gen !== genRef.current || !aliveRef.current) return;

        setState((prev) => ({
          // When polling, the old data is kept: after one network hiccup, stale numbers
          // plus an error message beat the whole board disappearing.
          data: clearOnStart ? null : prev.data,
          error: err instanceof Error ? err : new Error(String(err)),
          loading: false,
          updatedAt: prev.updatedAt,
        }));
      },
    );

    return controller;
  }, [clearOnStart]);

  // `reload` does not call `run()` directly. It bumps a tick, which makes the
  // effect run again. That keeps the abort and cleanup rules in one place; a
  // direct call would leave that request uncancelled on unmount.
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { state, run, invalidate, reload, tick };
}
