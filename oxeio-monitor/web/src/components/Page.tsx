import type { ReactNode } from 'react';

/**
 * Page title + action bar.
 *
 * Starting all six pages with this means title size, spacing and mobile wrapping
 * are fixed in one place.
 *
 * Careful: E12: on a phone `actions` drops below the title (`flex-wrap`). Forcing
 * them onto one row would squeeze the date picker and buttons until unreadable.
 */
export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  /**
   * Optional: the Live Board works without a title (mockup A has none; the page name
   * lights up in the sidebar and the date-time is in the top bar).
   *
   * Careful: with no title, the blank space is not rendered either; otherwise 70px
   * would stay empty at the top of the screen for an invisible title, exactly where
   * the mockup's KPI row belongs.
   */
  title?: ReactNode;
  /** One-line explanation: what is shown, for which date. */
  subtitle?: ReactNode;
  /** Date picker, download, refresh: on the right. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-7xl">
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {title && (
              <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            )}
            {subtitle && (
              <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>
            )}
          </div>
          {actions && (
            <div className="flex flex-wrap items-end gap-2">{actions}</div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Heading for a section inside a page.
 * A small explanation on the right (`hint`), e.g. "Ring = today's target".
 */
export function SectionHead({
  title,
  hint,
  actions,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Normal button: thin outline, brand red on hover.
 *
 * Careful: do not make solid red buttons. Solid red means "needs attention"
 * (error, agent off). Use `tone="danger"` for dangerous actions and the default
 * everywhere else. Use `tone="primary"` for the main action (solid `ink`, not
 * red; and `ink` is not "black": in the Midnight theme it is almost white).
 */
export function Button({
  children,
  onClick,
  type = 'button',
  tone = 'default',
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  title?: string;
}) {
  /**
   * Careful: all three colors come from tokens, using the paired `text-on-ink` /
   * `text-on-brand` tokens, not `text-white`. In the dark theme `bg-ink` becomes
   * almost white, and white text on it would make the button invisible (see the
   * bridge section in index.css).
   */
  const style =
    tone === 'primary'
      ? 'bg-ink text-on-ink border-ink hover:bg-ink-strong'
      : tone === 'danger'
        ? 'bg-attention text-on-brand border-attention hover:bg-brand-ink'
        : 'bg-surface text-ink-2 border-line hover:border-brand hover:text-ink';

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      // Careful: `tap`: a 44px touch target on phones (reason in `index.css`)
      className={`tap rounded-md border px-3 py-1.5 text-[13px] font-medium transition focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50 ${style}`}
    >
      {children}
    </button>
  );
}
