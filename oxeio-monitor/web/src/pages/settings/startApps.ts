/**
 * The app list of Settings → Tasks (start detection) — pure, so it can be
 * tested. The server cleans the list again (`cleanApps`); these rules only
 * keep the screen from offering what it would refuse or silently drop.
 */

import { translate } from '../../i18n';

/** The server's `START_APPS_MAX`: more than this is a mistake, not a setting */
export const START_APPS_MAX = 20;

/** The server's `START_APP_PATTERN`: a program name, no path, no quotes */
const START_APP_PATTERN = /^[^\\/:*?"<>|]{1,100}$/;

export type AddAppResult =
  | { apps: string[] }
  | { error: string };

/**
 * Add one process name to the list.
 *
 * Careful: repeats are compared **case-insensitively** — Windows does not care
 * whether it is `excel.exe` or `EXCEL.EXE`, and neither does the server, so
 * writing it in other capitals would only look like a second app.
 *
 * Careful: a pasted full path (`C:\Program Files\…\WINWORD.EXE`) is the most
 * likely mistake, so it gets its own message instead of "not valid".
 */
export function addStartApp(apps: readonly string[], raw: string): AddAppResult {
  const name = raw.trim();
  if (name === '') return { error: translate('Type the program name first.') };
  if (/[\\/]/.test(name)) {
    return { error: translate('Just the program name, without the folder — e.g. WINWORD.EXE.') };
  }
  if (!START_APP_PATTERN.test(name)) {
    return { error: translate('A program name such as WINWORD.EXE — no quotes or special characters.') };
  }
  const key = name.toLowerCase();
  if (apps.some((app) => app.toLowerCase() === key)) {
    return { error: translate('{{name}} is already on the list.', { name }) };
  }
  if (apps.length >= START_APPS_MAX) {
    return { error: translate('At most {{count}} apps.', { count: START_APPS_MAX }) };
  }
  return { apps: [...apps, name] };
}

/** Same apps, same order? — decides whether there is anything to save. */
export function sameApps(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((app, i) => app === b[i]);
}
