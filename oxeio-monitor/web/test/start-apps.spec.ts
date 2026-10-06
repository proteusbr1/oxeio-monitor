import { describe, expect, it } from 'vitest';

import { addStartApp, sameApps, START_APPS_MAX } from '../src/pages/settings/startApps';

/**
 * **Settings → Tasks, the app list.** The server cleans the list again; these
 * rules keep the screen from accepting what the server would refuse or drop.
 */
describe('addStartApp', () => {
  it('adds a trimmed program name at the end', () => {
    expect(addStartApp(['EXCEL.EXE'], '  WINWORD.EXE ')).toEqual({
      apps: ['EXCEL.EXE', 'WINWORD.EXE'],
    });
  });

  /** Careful: Windows does not care about capitals, and neither does the server */
  it('the same app in other capitals is a repeat', () => {
    expect(addStartApp(['WINWORD.EXE'], 'winword.exe')).toEqual({
      error: 'winword.exe is already on the list.',
    });
  });

  it('a full path gets its own message', () => {
    const result = addStartApp([], 'C:\\Program Files\\Office\\WINWORD.EXE');
    expect('error' in result && result.error).toMatch(/without the folder/);
  });

  it('empty, odd characters and too many are refused', () => {
    expect('error' in addStartApp([], '   ')).toBe(true);
    expect('error' in addStartApp([], 'a"b.exe')).toBe(true);
    const full = Array.from({ length: START_APPS_MAX }, (_, i) => `app${i}.exe`);
    expect(addStartApp(full, 'one-more.exe')).toEqual({ error: `At most ${START_APPS_MAX} apps.` });
  });
});

describe('sameApps — anything to save?', () => {
  it('order and capitals both count', () => {
    expect(sameApps(['a.exe', 'b.exe'], ['a.exe', 'b.exe'])).toBe(true);
    expect(sameApps(['a.exe', 'b.exe'], ['b.exe', 'a.exe'])).toBe(false);
    expect(sameApps(['a.exe'], ['A.exe'])).toBe(false);
    expect(sameApps([], [])).toBe(true);
  });
});
