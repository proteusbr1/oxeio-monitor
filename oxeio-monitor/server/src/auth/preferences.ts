/**
 * A person's own choices, kept on their user row (`users.preferences`, JSON)
 * so they follow them from one computer to the next.
 *
 * Read with `preferencesOf()` and never trust the stored JSON's shape: an
 * unknown key or a bad value is dropped, not passed to the screen.
 */

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export interface UserPreferences {
  /** unset = the browser's own choice (the toggle in the top bar) */
  theme?: Theme;
}

export function preferencesOf(raw: unknown): UserPreferences {
  const out: UserPreferences = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const theme = (raw as Record<string, unknown>).theme;
    if (typeof theme === 'string' && (THEMES as readonly string[]).includes(theme)) {
      out.theme = theme as Theme;
    }
  }
  return out;
}

/** `patch` over `current`; a `null` value clears that choice */
export function mergePreferences(
  current: UserPreferences,
  patch: { [K in keyof UserPreferences]?: UserPreferences[K] | null },
): UserPreferences {
  const next: UserPreferences = { ...current };
  for (const key of Object.keys(patch) as (keyof UserPreferences)[]) {
    const value = patch[key];
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return preferencesOf(next);
}
