import { Component, type ErrorInfo, type ReactNode } from 'react';

import { sendCrash } from '../lib/crash-reports';

/**
 * The last safety net: stops the whole app from being wiped out when a page
 * throws during render.
 *
 * Why it is needed was verified by hand: if `/employees/:id` returns JSON of an
 * unexpected shape, a component inside throws while reading `undefined.length`,
 * and React then unmounts the whole tree. The result: header, nav, everything
 * gone, `document.body` completely empty. That is exactly the "white screen" that
 * makes it look as if the system has broken.
 *
 * Careful: this is not a replacement for `<ErrorBox>`. Network errors are caught
 * by `useApi`, and that is the normal path. This class is only for bugs inside
 * render, so seeing it means a real bug exists somewhere, which is why the
 * message is not "try again in a moment".
 *
 * Careful: it is a class component because React has no hook for building an
 * error boundary; `componentDidCatch`/`getDerivedStateFromError` are the only way.
 */
interface Props {
  children: ReactNode;
  /** Changes when the route changes; see below. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  /**
   * Careful: it is logged to the console on purpose. The office server has no
   * error-tracking service, so asking the user for a screenshot would be the only
   * other way. Swallowing it silently would mean the bug could never be found.
   */
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[oXeio] Error while rendering the page:', error, info.componentStack);
    // on to Sentry, when the owner turned it on (Settings → Error reporting)
    sendCrash(error, info.componentStack);
  }

  /**
   * It recovers on its own when the route changes. Otherwise, after one error on a
   * page, the user would see the same error message even after moving to another
   * tab and would think the whole dashboard was dead.
   */
  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="mx-auto max-w-xl rounded-xl border border-brand/30 bg-brand-bg px-5 py-6 text-center"
      >
        <p className="text-sm font-medium text-brand-ink">
          This page couldn't be displayed
        </p>
        <p className="mt-1.5 text-xs text-ink-3">
          The other tabs will still work. If it keeps happening, send a
          screenshot — this is a bug in the system, not something you did wrong.
        </p>
        {/* Careful: the technical message stays visible; it is the only clue to the bug */}
        <pre className="num mt-3 overflow-x-auto rounded-md border border-line bg-surface px-3 py-2 text-left text-[11px] whitespace-pre-wrap text-ink-2">
          {error.message}
        </pre>
      </div>
    );
  }
}
