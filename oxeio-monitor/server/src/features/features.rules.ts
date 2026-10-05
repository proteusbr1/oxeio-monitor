/**
 * Module switches — parts of the dashboard a company may not use.
 *
 * Payroll, security deposits and design targets were built for one studio;
 * another company may pay salaries elsewhere, hold no deposits and have no
 * designers. A switch only hides the screens and blocks the endpoints: no
 * table is dropped and nothing is deleted, so turning a module back on brings
 * back everything exactly as it was.
 *
 * Every module is on unless the owner turned it off — an install that never
 * opens Settings → Modules behaves exactly as before.
 */

export const FEATURES_SETTING_KEY = 'features';

export const FEATURE_KEYS = [
  'payroll',
  'deposits',
  'designTargets',
  // staff and researcher logins see the screenshots of their own screen
  'staffScreenshots',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type Features = Record<FeatureKey, boolean>;

export function isFeatureKey(value: unknown): value is FeatureKey {
  return (
    typeof value === 'string' &&
    (FEATURE_KEYS as readonly string[]).includes(value)
  );
}

/**
 * The saved row → the switches. Anything that is not an explicit `false`
 * counts as on: a missing row, a module added after the row was saved, or a
 * value someone mangled by hand. A module disappearing by accident would be
 * worse than one staying visible.
 */
export function resolveFeatures(saved: unknown): Features {
  const row =
    saved !== null && typeof saved === 'object' && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : {};

  const out = {} as Features;
  for (const key of FEATURE_KEYS) out[key] = row[key] !== false;
  return out;
}

/** The switches that differ between two states — for the audit log */
export function changedFeatures(
  before: Features,
  after: Features,
): Partial<Features> {
  const out: Partial<Features> = {};
  for (const key of FEATURE_KEYS) {
    if (before[key] !== after[key]) out[key] = after[key];
  }
  return out;
}
