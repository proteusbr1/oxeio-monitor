import { api } from './client';

/**
 * Settings → Privacy: the choices *inside* the Screenshots module. Owner only;
 * the server answers 404 while the Screenshots module is off, so the tab is
 * not shown then. Every change is written to the audit log by the server.
 */

/** the server's `RETENTION_MIN_DAYS` / `RETENTION_MAX_DAYS` */
export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 3650;

export interface PrivacySettings {
  /** staff and coordinator logins can open the pictures of their own screen */
  staffSeeOwnScreenshots: boolean;
  /** screenshots older than this are deleted by the nightly cleanup */
  screenshotRetentionDays: number;
}

export interface PrivacyView {
  settings: PrivacySettings;
  /** active staff and coordinator logins — who the first setting affects */
  staffLogins: number;
}

export function getPrivacy(signal?: AbortSignal): Promise<PrivacyView> {
  return api<PrivacyView>('/settings/privacy', { signal });
}

export function savePrivacy(
  changes: Partial<PrivacySettings>,
): Promise<PrivacyView> {
  return api<PrivacyView>('/settings/privacy', {
    method: 'PATCH',
    body: changes,
  });
}
