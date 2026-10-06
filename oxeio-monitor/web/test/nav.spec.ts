import { describe, expect, it } from 'vitest';

import { ALL_FEATURES_ON, type Features } from '../src/api/features';
import { navFor, type NavUser } from '../src/components/nav';

const user = (over: Partial<NavUser> = {}): NavUser => ({
  role: 'owner',
  canAddTargets: true,
  canSeeScreenshots: true,
  ...over,
});
const off = (patch: Partial<Features>): Features => ({ ...ALL_FEATURES_ON, ...patch });
const paths = (u: NavUser, f: Features = ALL_FEATURES_ON) => navFor(u, f).map((i) => i.to);

describe('navFor — the Screenshots entry', () => {
  it('follows the server’s canSeeScreenshots, for staff as for the owner', () => {
    expect(paths(user({ role: 'employee' }))).toContain('/screenshots');
    expect(paths(user({ role: 'employee', canSeeScreenshots: false }))).not.toContain('/screenshots');
    expect(paths(user({ role: 'researcher', canSeeScreenshots: false }))).not.toContain('/screenshots');
    expect(paths(user({ canSeeScreenshots: false }))).not.toContain('/screenshots');
  });

  it('goes at once when the module is switched off, before /auth/me is asked again', () => {
    expect(paths(user(), off({ screenshots: false }))).not.toContain('/screenshots');
    expect(paths(user({ role: 'manager' }), off({ screenshots: false }))).not.toContain('/screenshots');
  });
});

describe('navFor — other modules', () => {
  it('design targets hide their three entries', () => {
    const shown = paths(user(), off({ designTargets: false }));
    expect(shown).not.toContain('/targets');
    expect(shown).not.toContain('/targets/all');
    expect(shown).not.toContain('/targets/review');
  });

  it('Payroll is renamed, not removed, while payroll is off', () => {
    const item = navFor(user(), off({ payroll: false })).find((i) => i.to === '/payroll');
    expect(item?.label).toBe('Leave & months');
    expect(navFor(user(), ALL_FEATURES_ON).find((i) => i.to === '/payroll')?.label).toBe('Payroll');
  });

  it('roles still decide first', () => {
    const staff = paths(user({ role: 'employee' }));
    expect(staff).not.toContain('/settings');
    expect(staff).not.toContain('/payroll');
    expect(staff).toContain('/me');
  });
});
