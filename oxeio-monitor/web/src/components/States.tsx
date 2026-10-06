import type { ReactNode } from 'react';

import { ApiError } from '../api/client';

/**
 * Every page has three states: loading, error, nothing to show.
 *
 * Careful: do not forget the empty state. On a new office's first day every page
 * will be empty, and a white screen would look like a broken system. The `hint`
 * of `<Empty>` should always say what to do next.
 *
 * Usage pattern:
 * ```tsx
 * if (loading && !data) return <Loading />;
 * if (error) return <ErrorBox error={error} retry={reload} />;
 * if (!data || data.rows.length === 0)
 *   return <Empty title="No activity on this day" hint="…" />;
 * ```
 */

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      className="grid place-items-center rounded-xl border border-line bg-surface px-6 py-14 text-sm text-ink-3"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2.5">
        {/* Thin brand-red ring: spinning means "work in progress", not an error */}
        <span
          aria-hidden
          className="size-4 animate-spin rounded-full border-2 border-line border-t-brand"
        />
        {label}
      </div>
    </div>
  );
}

/**
 * Error box.
 *
 * A 403 is shown separately: when a manager asks for owner-only data it should
 * say "You don't have access", not "server problem". The "Retry" button is not
 * shown then either: pressing it repeatedly will not grant permission, it would
 * only add confusion.
 *
 * Careful: a 403 should not come first: owner-only things must not be shown to a
 * manager at all (`useAuth().user.role`). This box is the last line of defense.
 *
 * Careful: `error.message` is the server's own message. For every error except
 * 403/404 it is shown on screen verbatim. Intentional: the message is not
 * composed here, only displayed, because the server knows best what went wrong.
 * The server's user-facing messages are now in English (translated together), so
 * the screen does not end up in mixed languages.
 *
 * Careful: do not add a translation table on the client. If a new message were
 * added on the server, it would silently come out untranslated and nobody would
 * notice. The server is the place to settle language, not here.
 */
export function ErrorBox({
  error,
  retry,
}: {
  error: Error | null;
  retry?: () => void;
}) {
  const status = error instanceof ApiError ? error.status : null;
  const forbidden = status === 403;
  const notFound = status === 404;

  const message = forbidden
    ? "You don't have access"
    : notFound
      ? "What you're looking for isn't here"
      : (error?.message ?? 'Something went wrong');

  return (
    <div
      role="alert"
      className="rounded-xl border border-brand/30 bg-brand-bg px-5 py-6 text-center"
    >
      <p className="text-sm font-medium text-brand-ink">{message}</p>

      {!forbidden && (
        <p className="mt-1 text-xs text-ink-3">
          If the server can't be reached, try again in a moment.
        </p>
      )}

      {retry && !forbidden && (
        <button
          type="button"
          onClick={retry}
          className="mt-3 rounded-md border border-brand/40 bg-surface px-3 py-1.5 text-[13px] font-medium text-brand-ink transition hover:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Nothing to show.
 *
 * Careful: `hint` is almost mandatory. Saying only "nothing here" leaves the user
 * unable to tell whether this is normal or broken. One sentence like "is the
 * agent installed?" makes the difference.
 */
export function Empty({
  title,
  hint,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  /** The next step, like "Add staff". */
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-md text-xs text-ink-3">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * A small warning, for showing the server's `caveat` field.
 *
 * Some responses carry a `caveat`: "When one person runs more than one device the
 * time is added up...". Careful: it must not be hidden: even if the ratio is
 * right, absolute seconds cannot be taken as hours worked, and without being told,
 * someone will make a wrong decision. Thin outline, not solid red: it is not an
 * error, only a condition.
 */
export function Caveat({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 rounded-md border border-line bg-paper px-3 py-2 text-xs text-ink-3">
      <span aria-hidden className="mr-1.5">
        ⚠
      </span>
      {children}
    </p>
  );
}
