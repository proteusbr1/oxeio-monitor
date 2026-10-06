import { describe, expect, it } from 'vitest';

import { ALL_FEATURES_ON, type Features } from '../src/api/features';
import { navFor, type NavUser } from '../src/components/nav';

const user = (over: Partial<NavUser> = {}): NavUser => ({
  role: 'owner',
  canAddTasks: true,
  canSeeScreenshots: true,
  ...over,
});
const off = (patch: Partial<Features>): Features => ({ ...ALL_FEATURES_ON, ...patch });
const paths = (u: NavUser, f: Features = ALL_FEATURES_ON) => navFor(u, f).map((i) => i.to);

describe('navFor — the Screenshots entry', () => {
  it('follows the server’s canSeeScreenshots, for staff as for the owner', () => {
    expect(paths(user({ role: 'employee' }))).toContain('/screenshots');
    expect(paths(user({ role: 'employee', canSeeScreenshots: false }))).not.toContain('/screenshots');
    expect(paths(user({ role: 'coordinator', canSeeScreenshots: false }))).not.toContain('/screenshots');
    expect(paths(user({ canSeeScreenshots: false }))).not.toContain('/screenshots');
  });

  it('goes at once when the module is switched off, before /auth/me is asked again', () => {
    expect(paths(user(), off({ screenshots: false }))).not.toContain('/screenshots');
    expect(paths(user({ role: 'manager' }), off({ screenshots: false }))).not.toContain('/screenshots');
  });
});

describe('navFor — other modules', () => {
  it('the Tasks module hides its three entries', () => {
    const shown = paths(user(), off({ tasks: false }));
    expect(shown).not.toContain('/tasks');
    expect(shown).not.toContain('/tasks/all');
    expect(shown).not.toContain('/tasks/review');
  });

  it('Tasks no longer needs Apps & websites', () => {
    const shown = paths(user(), off({ appTracking: false }));
    expect(shown).toEqual(expect.arrayContaining(['/tasks', '/tasks/all', '/tasks/review']));
  });

  it('the Tasks section, in order, under its own heading', () => {
    const items = navFor(user(), ALL_FEATURES_ON).filter((i) => i.to.startsWith('/tasks'));
    expect(items.map((i) => [i.to, i.label])).toEqual([
      ['/tasks', 'Add tasks'],
      ['/tasks/all', 'Task pool'],
      ['/tasks/review', 'Review'],
    ]);
    expect(items[0].section).toBe('Tasks');
  });

  /** Review is team management: owner and manager, like the server's `@Roles` */
  it('a coordinator adds and sees the pool but not Review; plain staff see none', () => {
    const coordinator = paths(user({ role: 'coordinator' }));
    expect(coordinator).toContain('/tasks');
    expect(coordinator).toContain('/tasks/all');
    expect(coordinator).not.toContain('/tasks/review');
    expect(coordinator).toContain('/me');

    const staff = paths(user({ role: 'employee' }));
    expect(staff.some((p) => p.startsWith('/tasks'))).toBe(false);
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
