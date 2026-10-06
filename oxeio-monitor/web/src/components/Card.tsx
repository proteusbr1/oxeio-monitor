import type { ReactNode } from 'react';

/**
 * White card: every separate section of a page sits inside one.
 *
 * Careful: when putting a table or chart inside, pass `padded={false}`; otherwise
 * the `<Table>`'s own scroll frame stacks a second padding on top, which wastes
 * space on mobile.
 */
export function Card({
  title,
  hint,
  actions,
  children,
  padded = true,
}: {
  title?: ReactNode;
  /** Short explanation under the title. */
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h3 className="text-[13.5px] font-semibold tracking-tight">
                {title}
              </h3>
            )}
            {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

/**
 * A number tile (the mockup's `.stat`).
 *
 * Color rule: `tone="counted"` = solid `ink` (counted work), `"muted"` = grey (not
 * counted), `"attention"` = red (shortfall, agent off). Careful: if every tile
 * is red, red loses its meaning; keep no more than one red tile on a screen.
 *
 * Careful: do not think of `ink` as "black"; in the Midnight theme it is almost
 * white (#e8ecf1). The difference is solid vs faded, not black vs grey, so
 * on-screen text says "Solid / grey" instead of naming colors.
 *
 * Careful: `value` always gets the `.num` class; otherwise hour figures would
 * jump on every refresh.
 */
export function Stat({
  label,
  value,
  unit,
  sub,
  tone = 'counted',
}: {
  label: ReactNode;
  value: ReactNode;
  /** `/15` or `%`; sits small beside the value. */
  unit?: ReactNode;
  /**
   * A one-line context under the number, as in mockup A's tiles ("1 workday
   * elapsed", "target 8h", "all heartbeats fresh").
   *
   * Careful: this is not decoration. A raw number can often be read two ways, and
   * people then assume the one they fear: "pace -6h" sounds alarming until you
   * know only one workday of the month has elapsed. So the rule: put here only the
   * sentence that keeps the number from being misread, and leave it empty
   * otherwise. Reassurance like "all good" is banned here.
   */
  sub?: ReactNode;
  /**
   * Careful: there is only one `attention` (red) per screen; otherwise red loses
   * its meaning. For things that are "not good but not urgent" (such as pace being
   * behind) use `behind`, which is yellow, just as `idle` elsewhere on the board
   * means "running, but not counted". If both were the same color the owner could
   * not tell which one needs attention right now.
   */
  tone?: 'counted' | 'muted' | 'attention' | 'behind';
}) {
  const color =
    tone === 'attention'
      ? 'text-brand-ink'
      : tone === 'behind'
        ? 'text-idle-ink'
        : tone === 'muted'
          ? 'text-ink-3'
          : 'text-ink';

  return (
    <div className="bg-surface px-3.5 py-2.5">
      {/* The mockup's `.kpi .lbl`: small, uppercase, letter-spaced */}
      <div className="text-[9px] tracking-[0.07em] text-ink-3 uppercase">
        {label}
      </div>
      <div className={`num mt-0.5 text-xl leading-tight font-semibold ${color}`}>
        {value}
        {unit && (
          <small className="ml-1 text-xs font-medium text-ink-3">{unit}</small>
        )}
      </div>
      {/*
        Careful: no `min-h`; a tile with no context does not reserve empty space.
           Grid rows already match the tallest tile's height anyway,
           so all the bottom edges line up.
      */}
      {sub && (
        <div className="mt-0.5 text-[11px] leading-snug text-ink-3">{sub}</div>
      )}
    </div>
  );
}

/**
 * Grid of `<Stat>`s: lines made with a one-pixel gap (the mockup's `.summary`).
 * E12: drops to fewer columns on its own on a phone.
 */
export function StatRow({ children }: { children: ReactNode }) {
  /*
   * The KPI row from mockup A: only vertical lines between the tiles, no boxes
   * around each.
   *
   * Careful: this row is the head of the page, not a card, so it must not compete
   * with the real cards below. It does have an outer border and rounding: the
   * mockup's CSS says `border: 1px solid var(--line); border-radius: 8px`. This
   * was settled by reading the CSS, not by eyeballing the mockup.
   *
   * `gap-px` plus the background color makes the dividing lines. Real borders
   * would double up when rows wrap on a phone and look thick.
   */
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(126px,1fr))] gap-px overflow-hidden rounded-lg border border-line bg-line">
      {children}
    </div>
  );
}
