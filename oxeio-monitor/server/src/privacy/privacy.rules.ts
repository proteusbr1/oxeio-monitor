/**
 * Privacy settings — choices *inside* the screenshot module (who sees the
 * pictures, how long they are kept). Not module switches: those are in
 * `features/`, and switching Screenshots off there stops the pictures
 * altogether.
 */

export const PRIVACY_SETTING_KEY = 'privacy';

export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 3650;
/** what every install had before this was a setting */
export const DEFAULT_RETENTION_DAYS = 90;

export interface PrivacySettings {
  /** staff and researcher logins can open the pictures of their own screen */
  staffSeeOwnScreenshots: boolean;
  /** screenshots older than this are deleted by the nightly retention job */
  screenshotRetentionDays: number;
}

/**
 * The saved row → the settings. `legacyFeatures` is the old module-switch
 * row: "Screenshots for staff" used to be a switch there, and until this
 * row is saved its value is what applies.
 */
export function resolvePrivacy(saved: unknown, legacyFeatures: unknown): PrivacySettings {
  const row = asObject(saved);
  const legacy = asObject(legacyFeatures);

  const staff =
    typeof row.staffSeeOwnScreenshots === 'boolean'
      ? row.staffSeeOwnScreenshots
      : legacy.staffScreenshots !== false;

  const days = row.screenshotRetentionDays;
  const retention =
    typeof days === 'number' && Number.isInteger(days) && days >= RETENTION_MIN_DAYS && days <= RETENTION_MAX_DAYS
      ? days
      : DEFAULT_RETENTION_DAYS;

  return { staffSeeOwnScreenshots: staff, screenshotRetentionDays: retention };
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
