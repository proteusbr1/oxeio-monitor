import { api } from './client';

import type { UserPreferences } from './account';
import type { Role } from './staff';
export type { Role };

export interface Me {
  userId: number;
  email: string;
  fullName: string;
  role: Role;
  employeeId: number | null;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  twoFactorEnabled: boolean;
  /** Their own choices, saved on the account (Account page) */
  preferences: UserPreferences;
  /**
   * Whether the user may add tasks.
   *
   * Important: this is computed by the server, not derived from the role here.
   * Writing the rule ("owner, manager or coordinator") again in the web app
   * would eventually give two different answers, and someone would see a menu
   * entry that returns 403.
   */
  canAddTasks: boolean;
  /**
   * Whether the user may check finished tasks (Checked / Needs fix).
   *
   * Different from `canAddTasks`, though today the same people hold both;
   * kept apart so the server can narrow one without the other.
   */
  canCheckTasks: boolean;
  /**
   * Whether the Screenshots page is theirs to open: the module is on, and they
   * are owner or manager — or staff while Settings → Privacy lets staff see
   * their own. Decided by the server so the menu and the endpoint never disagree.
   */
  canSeeScreenshots: boolean;
}

export function login(
  email: string,
  password: string,
): Promise<{ mustChangePassword: boolean }> {
  return api('/auth/login', {
    method: 'POST',
    body: { email, password },
    // Wrong-password 401s must not trigger a global logout.
    silent401: true,
  });
}

export function me(): Promise<Me> {
  return api('/auth/me', { silent401: true });
}

export interface WorkTimeZone {
  /** IANA name, e.g. `Asia/Dhaka` */
  timeZone: string;
  /** Minutes east of UTC right now — a fallback; the zone name is what is used */
  utcOffsetMinutes: number;
}

/**
 * The work-day zone the server counts in. Public, like `session-policy`, so
 * the login page can show dates on the same day as everything else.
 */
export function fetchWorkTimeZone(signal?: AbortSignal): Promise<WorkTimeZone> {
  return api('/auth/time-zone', { silent401: true, signal });
}

export interface CurrencyInfo {
  /** ISO 4217, e.g. `BDT` */
  code: string;
  /** e.g. `৳`, `R$` */
  symbol: string;
}

/** The currency salaries and deposits are in. Public, like `session-policy`. */
export function fetchCurrency(signal?: AbortSignal): Promise<CurrencyInfo> {
  return api('/auth/currency', { silent401: true, signal });
}

/**
 * How dates and numbers are written (`DISPLAY_LOCALE`); `null` = the formats
 * the dashboard always had. Public, like `session-policy`.
 */
export function fetchDisplayLocale(
  signal?: AbortSignal,
): Promise<{ locale: string | null }> {
  return api('/auth/display-locale', { silent401: true, signal });
}

export function logout(): Promise<void> {
  return api('/auth/logout', { method: 'POST' });
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  return api('/auth/change-password', {
    method: 'POST',
    body: { currentPassword, newPassword },
    silent401: true,
  });
}

/**
 * Who may see the whole team's data: only owners and managers.
 *
 * Important: the condition is an allow-list, which is the whole reason this
 * function exists. Five screens used to check `role === 'employee'`, i.e. "not
 * staff means sees everything". When a fourth role was added, it turned
 * out every new role would fall on the "sees everything" side: everyone's
 * screenshots, everyone's reports, the search box. There was no compile error.
 *
 * The server is turned the same way (`resolveEmployeeScope`, `assertCanSee`).
 * The screen is not the only guard, it is the first one.
 */
export function seesEveryone(role: Role | undefined | null): boolean {
  return role === 'owner' || role === 'manager';
}

/**
 * Where each role lands after login, or after a "not found".
 *
 * Careful: a coordinator landing on `/me` would see hours tiles, none of them
 * about their work (adding and checking tasks). Someone who receives tasks
 * lands on `/me`, where their own list is — not on the pool, which is
 * everyone's work.
 */
export function homePathFor(
  role: Role | undefined | null,
  // the Tasks module switched off in Settings → Modules: no pool to land on
  tasks = true,
): string {
  if (seesEveryone(role)) return '/';
  return role === 'coordinator' && tasks ? '/tasks/all' : '/me';
}
