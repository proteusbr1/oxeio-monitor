/**
 * A row of tabs inside a page: reports (3-4) and settings (5) both use this.
 *
 * Two agents had separately written almost identical markup, and that was the
 * real risk: tabs are not routes, so if they did not look the same, users would
 * think they were two different things. With one place, the weight of the thin
 * red line, the spacing and the focus ring change together.
 *
 * Careful: a thin brand-red bottom line, not solid red. A selected tab is not an
 * error, just a choice; with solid red every tab would feel like a "problem".
 *
 * Careful: E12: the row itself scrolls horizontally (`overflow-x-auto`), not the
 * whole page. At 375px the five Settings tabs do not fit together.
 *
 * Careful: `overflow-y-hidden` goes with it, and it must not be dropped.
 *
 * Tailwind's `overflow-x-auto` sets `auto` on both axes. The inner buttons
 * (padding + the 2px line under the selected tab) end up exactly one pixel taller
 * than the container, and that is enough for the browser to draw a vertical
 * scrollbar, which takes 15px of width (`clientWidth 1280 -> 1265`).
 *
 * It does not show on a Mac, where scrollbars float and are nearly invisible. On
 * Windows it is a thick bar with arrows, and on the owner's screen it appeared as
 * a strange empty box above "Add staff" (reported by the owner). A flaw invisible
 * on one developer's OS is obvious on another's, so "it looks fine here" is never proof.
 *
 * Careful: `<button>`, not `<Link>`; the tabs are not separate routes. The
 * navigation tabs (in the header above) are in `Layout.tsx`, using `NavLink`;
 * do not confuse the two.
 */
export interface TabItem<T extends string> {
  id: T;
  label: string;
}

export function Tabs<T extends string>({
  items,
  active,
  onChange,
  label,
}: {
  items: readonly TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  /** For screen readers: "part of Settings", "type of report". */
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line"
    >
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onChange(item.id)}
            // Careful: `tap`: 44px on a phone (`index.css`). Tabs were about 38px, and
            // since the row scrolls sideways the finger is already moving anyway.
            className={`tap -mb-px border-b-2 px-3 py-2.5 text-[13px] whitespace-nowrap transition focus:outline-none focus:ring-2 focus:ring-brand/30 ${
              selected
                ? 'border-brand font-semibold text-brand-ink'
                : 'border-transparent text-ink-2 hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
