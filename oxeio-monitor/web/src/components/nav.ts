import type { Me, Role } from '../api/auth';
import type { FeatureKey, Features } from '../api/features';

/**
 * The sidebar's entries and who sees each — kept apart from `Layout` so the
 * filtering can be tested without rendering anything.
 */

/** What the filter reads from the signed-in user */
export type NavUser = Pick<Me, 'role' | 'canAddTargets' | 'canSeeScreenshots'>;

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  /** Which roles can see this tab. */
  roles: Role[];
  /**
   * An extra condition beyond the role.
   *
   * Careful: the Targets page is also seen by researchers, whose role is `employee`,
   * so putting `employee` in `roles` would show it to all staff. So the
   * server-computed answer (`canAddTargets`) is checked instead; the rule is not
   * rewritten on the web side, or one day the menu would show an entry whose page
   * returns 403.
   */
  when?: (user: NavUser) => boolean;
  /** Belongs to a module the owner can switch off (Settings → Modules) */
  feature?: FeatureKey;
  /**
   * Section label from mockup A; it sits immediately before this item.
   *
   * Careful: sidebar only (above `lg`). In a phone's horizontal row a section label
   * would be a piece of text between the tabs that cannot be pressed; on a narrow
   * screen it takes space and looks like a tab by mistake.
   */
  section?: string;
  /**
   * An item inside a section: shifted slightly right.
   *
   * With only a heading, "it is underneath" is not noticeable enough; with the
   * indent the eye sees at a glance which item belongs to which section.
   */
  child?: boolean;
  /**
   * A number beside the name (`Alerts 2` in the mockup).
   *
   * Careful: `undefined` and `0` are not the same: `0` means "counted, nothing
   * there" and no badge is shown; `undefined` means "not known yet". Treating them
   * alike would make the nav claim all is well before the number arrived.
   */
  badge?: number;
}

/**
 * Filtering happens in the nav, not from a 403. A screen the user may not enter
 * is not shown by name at all; otherwise a manager would read the word "Settings"
 * and learn what is out of reach, then press it, get "not allowed" and think
 * something broke. The pages' own 403 screens are the last line of defense, not the first.
 *
 * Careful: the `/staff` list tab was removed. The spec (section 5) has six
 * screens and "staff list" is not one of them; adding/editing staff lives in the
 * Settings Staff tab (owner-only). The `/staff/:id` route exists, but the way
 * there is a Live Board card. A bare `/staff` is not a screen, so keeping the tab
 * would have led to "not found".
 *
 * Careful: staff get only one tab, because the server opens no dashboard endpoint
 * to them except `/screenshots`. A one-tab row looks empty, but that beats getting
 * a 403 on three of four tabs.
 */
export const NAV: NavItem[] = [
  {
    to: '/',
    label: 'Live Board',
    end: true,
    roles: ['owner', 'manager'],
  },
  /**
   * Worklog: the cards, moved up from below the Live Board.
   *
   * Careful: placed right after the Live Board because the two questions sit
   * together: the board says "how is the team doing today", Worklog says "who is
   * working right now". Putting anything between would make the second hard to find.
   */
  {
    to: '/worklog',
    label: 'Worklog',
    roles: ['owner', 'manager'],
  },
  /**
   * Targets: the researcher's daily page.
   *
   * Careful: in the sidebar, not in Settings (the owner's decision). People come
   * here every day, while Settings is a place to set something once and forget.
   * Deposits is in the sidebar for exactly the same reason (09 section 3).
   *
   * The hack that used to be here, and why it is gone: it was `roles:
   * ['owner','manager','employee']` together with `when: (user) =>
   * user.canAddTargets`, with a comment admitting that `employee` is there only for
   * researchers and the real filter is `when`.
   *
   * Careful: that was forced, not chosen. The portal had three roles and
   * researchers came in as `employee`. Leaving `employee` out of the list dropped
   * them; putting it in showed this to all nine designers too. The owner later
   * split the role (researchers and designers do different work), so the list now
   * tells the truth and one place guards it instead of two.
   */
  /**
   * Two pages under one section, like `Oversight -> Alerts`. Careful: the section
   * label shows only in the sidebar (above `lg`), so the two item names must be
   * clear on their own: in a phone's horizontal row "Add targets"/"All targets"
   * must make sense standing alone.
   *
   * Careful: the names no longer contain "Design", because the section title says
   * it already, and "Targets -> Add Design Targets" says the same thing twice.
   */
  {
    to: '/targets',
    label: 'Add target design',
    roles: ['owner', 'manager', 'researcher'],
    section: 'Targets',
    child: true,
    feature: 'designTargets',
  },
  {
    to: '/targets/all',
    label: 'Design Pool',
    roles: ['owner', 'manager', 'researcher'],
    child: true,
    feature: 'designTargets',
  },
  /**
   * Review: right below Design Pool.
   *
   * Careful: no researchers. Why a designer skipped something is a team-management
   * question, which matches the server's `@Roles(owner, manager)`.
   */
  {
    to: '/targets/review',
    label: 'Review',
    roles: ['owner', 'manager'],
    child: true,
    feature: 'designTargets',
  },
  /**
   * J05: the staff member's own page. The name is exactly the same as the tray menu
   * item ("My data"); with two different names in two places staff would think they
   * were two different things.
   *
   * Careful: shown in the nav only for staff: the `users.employee_id` of an
   * owner/manager is usually null, so for them the page would return 403. (The
   * route is still open to everyone: someone who really is an employee can go there directly.)
   */
  /**
   * Careful: this heading is not just decoration, it closes the section above. A
   * section label marks only the start, not the end; without a heading after
   * "Targets", My data, Staff and Screenshots would all look as if they were inside
   * that section.
   */
  /**
   * Careful: `researcher` is here too. Researchers also have an agent and are also
   * measured (verified: both OX-04 and OX-05 have active devices). The personal page
   * is not tied to the kind of work.
   *
   * `manager` is here too, and without it the work of that day would be pointless.
   * The office manager now gets 30 designs every day (`DESIGN_WORK_STAFF_TYPES`),
   * but the list lives on this page. Without the menu link the 30 tasks would
   * arrive and they could not find them except by typing the URL.
   *
   * Careful: an older note said an owner/manager's `employee_id` is usually `null`,
   * so the page returned 403. That is no longer true: someone not linked to an
   * employee row gets a friendly empty box (`MyDataPage`), not an error. The owner
   * stays out, since they have no employee row.
   */
  {
    to: '/me',
    label: 'My data',
    roles: ['manager', 'researcher', 'employee'],
    section: 'Team',
  },
  /**
   * In mockup A's sidebar, right after the Live Board.
   *
   * Careful: this used to carry a note saying the tab was "removed", because there
   * was no `/staff` page and the tab led to "not found". The page now exists
   * (`StaffPage`), so the tab is back.
   * Careful: this is not a duplicate of Settings -> Staff: editing is there,
   * viewing is here.
   */
  /**
   * Careful: the owner's/manager's list has no `My data`, so the section heading is
   * needed here too; otherwise the "Targets" section would never close on their
   * screen. Only one of the two is ever visible, so the heading is not shown twice.
   */
  { to: '/staff', label: 'Staff', roles: ['owner', 'manager'], section: 'Team' },
  /**
   * Careful: researchers and designers see only their own here; the server applies the scope.
   *
   * `canSeeScreenshots` is the server's answer (module on, and staff only while
   * Settings → Privacy lets them see their own) — the same one the route uses.
   * `feature` is checked too so that switching the module off in Settings →
   * Modules takes the item away at once, before `/auth/me` is asked again.
   */
  {
    to: '/screenshots',
    label: 'Screenshots',
    roles: ['owner', 'manager', 'researcher', 'employee'],
    feature: 'screenshots',
    when: (user) => user.canSeeScreenshots,
  },
  /**
   * Careful: just "Monthly", not "Monthly progress". Every nav tab is one or two
   * words, and at 375px the long labels are the first to make the row scroll.
   */
  { to: '/monthly', label: 'Monthly', roles: ['owner', 'manager'] },
  { to: '/reports', label: 'Reports', roles: ['owner', 'manager'] },
  /**
   * Payroll — salaries, leave, deposits, the pay sheet and closing the
   * month, on one page (pages/payroll). Called "Leave & months" when the
   * payroll module is off: leave and closing still move the hours.
   */
  { to: '/payroll', label: 'Payroll', roles: ['owner'] },
  /**
   * Careful: owner-only. Alerts contain hostnames, employee names and device state
   * together (section 4.3). Managers are not even shown the badge.
   */
  { to: '/alerts', label: 'Alerts', roles: ['owner'], section: 'Oversight' },
  // Careful: owner-only; the route in `App.tsx` is also set up for the owner only.
  // Managers get in too: Staff, Categories, Policies & holidays are their three
  // tabs; `SettingsPage` itself hides the rest by looking at the role.
  /**
   * I06: every role, not owner-only. This is not a tracking screen but one's own
   * account: profile, password, 2FA, look, devices. Making it owner-only would mean a manager's
   * account, which holds everyone's data, would never get 2FA.
   *
   * Careful: deliberately last, even after Settings: it is not a daily screen, it is
   * a place opened once or twice a year.
   */
  {
    to: '/account',
    label: 'Account',
    roles: ['owner', 'manager', 'researcher', 'employee'],
  },
  { to: '/settings', label: 'Settings', roles: ['owner', 'manager'] },
];

/**
 * The entries this user sees: their role, the server-computed extras
 * (`when`) and the modules switched on. The Payroll entry is renamed while
 * the payroll module is off — leave and closing the month still live there.
 */
export function navFor(user: NavUser, features: Features): NavItem[] {
  return NAV.filter(
    (item) =>
      item.roles.includes(user.role) &&
      (item.when?.(user) ?? true) &&
      (item.feature === undefined || features[item.feature]),
  ).map((item) =>
    item.to === '/payroll' && !features.payroll
      ? { ...item, label: 'Leave & months' }
      : item,
  );
}
