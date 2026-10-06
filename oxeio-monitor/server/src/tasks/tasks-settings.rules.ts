/**
 * Settings → Tasks: choices *inside* the Tasks module. Owner only.
 *
 * `startDetection.apps`: the programs (process names, e.g. `Excel.exe`)
 * whose window titles are read for a leading task number. An empty list —
 * the default for a new install — means start detection is off: no title is
 * read, `tasksStarted` stays 0 and the "On screen" column is hidden.
 *
 * Detection also needs the Apps & websites module (that is where window
 * titles come from): while it is off, detection is simply inactive and the
 * apps list is kept for when it comes back.
 */

export const TASKS_SETTING_KEY = 'tasks';

/** More than this many apps is a mistake, not a configuration */
export const START_APPS_MAX = 20;

/** A process name: no path, no quotes, at most 100 characters */
export const START_APP_PATTERN = /^[^\\/:*?"<>|]{1,100}$/;

export interface TasksSettings {
  startDetection: { apps: string[] };
}

/** What `GET /settings/tasks` answers */
export interface TasksSettingsView extends TasksSettings {
  /** apps listed AND Apps & websites on: titles are really being read */
  active: boolean;
}

/**
 * The saved row → the settings. Anything malformed counts as "no apps":
 * reading titles must never switch itself on by accident.
 */
export function resolveTasksSettings(saved: unknown): TasksSettings {
  const row =
    saved !== null && typeof saved === 'object' && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : {};
  const detection =
    row.startDetection !== null &&
    typeof row.startDetection === 'object' &&
    !Array.isArray(row.startDetection)
      ? (row.startDetection as Record<string, unknown>)
      : {};
  const apps = Array.isArray(detection.apps) ? detection.apps : [];

  return { startDetection: { apps: cleanApps(apps) } };
}

/**
 * Trims, drops blanks and invalid names, and removes repeats
 * case-insensitively (the first spelling wins).
 */
export function cleanApps(apps: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const app of apps) {
    if (typeof app !== 'string') continue;
    const name = app.trim();
    if (!START_APP_PATTERN.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= START_APPS_MAX) break;
  }
  return out;
}
