import { useCallback, useEffect, useState } from 'react';

/**
 * Light/dark switch.
 *
 * All colors live in `index.css` tokens, inside `light-dark()`. This file's only
 * job is to set `data-theme` on `<html>`; CSS does the rest.
 *
 * Two states, not three. There used to be a third, "nothing chosen", which
 * followed the OS. Now the default is dark (Midnight, the owner's choice), and
 * `prefers-color-scheme` is deliberately ignored so two people in the same office
 * see the same screen. The choice is kept in `localStorage`, so it is remembered
 * next time.
 *
 * Careful: to bring back OS-following, both `color-scheme` in `index.css` and the
 * default below must change. Changing only one would make JS think one thing and
 * CSS draw another, and the `dark:` classes would not match the tokens.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'oxeio.theme';

/** What applies when nothing is chosen: Midnight. */
const DEFAULT_THEME: Theme = 'dark';

/**
 * Careful: merely touching `localStorage` can throw (strict privacy settings, some
 * kiosk profiles). Being unable to read the theme is no reason to break the app;
 * run with the default then.
 * Careful: the value is validated: if someone hand-set `'banana'`, it would land
 * on `<html>` and `light-dark()` would silently fall back to the default, while
 * the button would show the opposite picture; two different stories.
 */
function readPreference(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

function writePreference(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Preference not saved: it works for this session, the default returns next time
  }
}

function stamp(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * Once, as soon as the module loads, before React renders.
 *
 * No script could be placed in `index.html` (the file is outside the scope of this
 * work), so the earliest reachable point is here: the moment the bundle starts,
 * when `<div id="root">` is still empty. So a user who chose light does not see a
 * flash of the dark screen.
 *
 * For a user on the default this stamp is not needed: `color-scheme: dark` in
 * `index.css` already draws the right color while the HTML is parsed, and the
 * `dark:` variant treats "not light" as dark. It is still applied so the DOM
 * always shows which theme is running.
 */
if (typeof document !== 'undefined') {
  stamp(readPreference() ?? DEFAULT_THEME);
}

export interface ThemeState {
  /** The theme currently in effect. */
  theme: Theme;
  toggle: () => void;
}

/**
 * Careful: at present the only user is `ThemeToggle` itself. If a second caller
 * appeared there would be two separate `useState`s and toggling one would not
 * inform the other; then this must move to context (the stamped DOM is the truth,
 * not state).
 */
export function useTheme(): ThemeState {
  const [theme, setTheme] = useState<Theme>(
    () => readPreference() ?? DEFAULT_THEME,
  );

  /**
   * Careful: when the theme changes in another tab, this tab changes too. Without
   * it two tabs would sit in two themes and, coming back, the switch would seem not
   * to work. (The `storage` event only arrives from other tabs, not from our own writes.)
   * Careful: `e.key === null` means someone cleared the whole `localStorage`; it is
   * read again then too, i.e. it returns to the default.
   */
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== null && e.key !== STORAGE_KEY) return;
      setTheme(readPreference() ?? DEFAULT_THEME);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    stamp(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      writePreference(next);
      return next;
    });
  }, []);

  return { theme, toggle };
}

/**
 * Header button.
 *
 * Careful: the header field is dark in both themes (`--color-chrome`), so the
 * colors here are not ink/paper tokens but white with opacity, like the logout
 * button. With tokens, near-white text in dark would fade into near-white.
 */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const goingLight = theme === 'dark';

  const label = goingLight ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="rounded-md border border-white/20 p-1.5 text-white/85 transition hover:border-brand hover:text-white focus:outline-none focus:ring-2 focus:ring-brand/40"
    >
      {goingLight ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/* The icons use `currentColor`, so they brighten with the button on hover */

function MoonIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" />
    </svg>
  );
}
