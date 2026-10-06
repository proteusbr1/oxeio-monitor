import { api } from './client';
import type { Role } from './staff';

/** The signed-in person's own account — server `auth/account.controller.ts` */

export type Theme = 'light' | 'dark';

export interface UserPreferences {
  /** unset = this browser's own choice */
  theme?: Theme;
  /** unset = the company's default language */
  language?: 'en' | 'pt-BR' | 'es';
}

export interface AccountView {
  email: string;
  fullName: string;
  role: Role;
  /** staff accounts take their name from Staff → Directory */
  nameFromStaffRecord: boolean;
  staff: { empCode: string; designation: string | null } | null;
  createdAt: string;
  lastLoginAt: string | null;
  pwChangedAt: string | null;
  twoFactorEnabled: boolean;
  preferences: UserPreferences;
}

export interface AccountEvent {
  at: string;
  action: string;
  ip: string | null;
  /** the owner did it to this account */
  byOther: boolean;
}

export function getAccount(signal?: AbortSignal): Promise<AccountView> {
  return api<AccountView>('/account', { signal });
}

export function updateAccount(body: {
  fullName?: string;
  theme?: Theme | null;
  language?: 'en' | 'pt-BR' | 'es' | null;
}): Promise<AccountView> {
  return api<AccountView>('/account', { method: 'PATCH', body });
}

export function getAccountActivity(signal?: AbortSignal): Promise<AccountEvent[]> {
  return api<AccountEvent[]>('/account/activity', { signal });
}

export function signOutOtherDevices(): Promise<void> {
  return api('/account/sign-out-others', { method: 'POST' });
}
