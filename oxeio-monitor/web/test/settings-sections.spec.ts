import { describe, expect, it } from 'vitest';

import { ALL_FEATURES_ON, type Features } from '../src/api/features';
import { settingsSections } from '../src/pages/settings/sections';

const off = (patch: Partial<Features>): Features => ({ ...ALL_FEATURES_ON, ...patch });
const ids = (role: Parameters<typeof settingsSections>[0], f: Features = ALL_FEATURES_ON) =>
  settingsSections(role, f).flatMap((s) => s.tabs.map((t) => t.id));

describe('settingsSections', () => {
  it('Privacy sits in Company, right after Modules, for the owner', () => {
    const company = settingsSections('owner', ALL_FEATURES_ON).find((s) => s.title === 'Company');
    expect(company?.tabs.map((t) => t.id)).toEqual(['region', 'modules', 'privacy']);
  });

  it('Privacy is owner-only and goes while the screenshots module is off', () => {
    expect(ids('manager')).not.toContain('privacy');
    expect(ids('owner', off({ screenshots: false }))).not.toContain('privacy');
    // Modules itself never goes — it is where the module is turned back on
    expect(ids('owner', off({ screenshots: false, appTracking: false }))).toContain('modules');
  });

  it('Apps & sites goes while apps & websites are off — for managers too', () => {
    expect(ids('owner', off({ appTracking: false }))).not.toContain('categories');
    expect(ids('manager', off({ appTracking: false }))).toEqual(['policies']);
    expect(ids('manager')).toEqual(['categories', 'policies']);
  });

  it('Tasks sits in Work for the owner, only while the Tasks module is on', () => {
    const work = settingsSections('owner', ALL_FEATURES_ON).find((s) => s.title === 'Work');
    expect(work?.tabs.map((t) => t.id)).toEqual(['categories', 'policies', 'tasks']);
    expect(ids('owner', off({ tasks: false }))).not.toContain('tasks');
    // start detection rests without Apps & websites, but the tab stays: the list is kept
    expect(ids('owner', off({ appTracking: false }))).toContain('tasks');
  });

  it('Tasks is owner-only', () => {
    expect(ids('manager')).not.toContain('tasks');
  });

  it('managers keep their own labels and subtitles', () => {
    const tab = settingsSections('manager', ALL_FEATURES_ON)
      .flatMap((s) => s.tabs)
      .find((t) => t.id === 'policies');
    expect(tab?.label).toBe('Holidays');
    expect(tab?.subtitle).toBe('Days off — the hours target moves with them');
  });

  it('subtitles stop mentioning screenshots while the module is off', () => {
    const subtitles = settingsSections('owner', off({ screenshots: false }))
      .flatMap((s) => s.tabs)
      .map((t) => t.subtitle);
    expect(subtitles.some((s) => /screenshot/i.test(s))).toBe(false);
  });
});
