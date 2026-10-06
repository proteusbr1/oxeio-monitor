/**
 * Module switches — whole parts of the product a company may not use.
 *
 * A module is a feature area with its own screens, endpoints and data:
 * switching it off hides the screens and blocks the endpoints (and, for the
 * capture modules, tells the agents to stop collecting). No table is dropped
 * and nothing is deleted, so turning a module back on brings back everything
 * exactly as it was.
 *
 * ⚠️ Only whole modules belong here. A choice *inside* a module (who may see
 *    screenshots, how long they are kept, a capture window, an overtime
 *    rate) is a setting and lives with that module's settings — Privacy,
 *    Policies, and so on — not as a switch on this list.
 *
 * Every module is on unless the owner turned it off — an install that never
 * opens Settings → Modules behaves exactly as before.
 */

export const FEATURES_SETTING_KEY = 'features';

export const FEATURE_KEYS = [
  'payroll',
  'deposits',
  'screenshots',
  'appTracking',
  'tasks',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type Features = Record<FeatureKey, boolean>;

/**
 * A module that only works inside another one. Deposits are held back from
 * pay, so they need Payroll. While the parent is off the child is off too,
 * whatever its own switch says — and its own switch is kept, so turning the
 * parent back on restores it.
 *
 * Tasks has no parent: only its optional start detection reads window
 * titles, and that part simply goes inactive while Apps & websites is off
 * (see `tasks/tasks-settings.rules.ts`).
 */
export const FEATURE_PARENT: Partial<Record<FeatureKey, FeatureKey>> = {
  deposits: 'payroll',
};

/**
 * Keys a module was saved under before it was renamed: read when the new key
 * is absent from the saved row. The Tasks module was `designTargets`.
 */
const LEGACY_FEATURE_KEYS: Partial<Record<FeatureKey, string>> = {
  tasks: 'designTargets',
};

export function isFeatureKey(value: unknown): value is FeatureKey {
  return (
    typeof value === 'string' &&
    (FEATURE_KEYS as readonly string[]).includes(value)
  );
}

/**
 * The saved row → the owner's switches. Anything that is not an explicit
 * `false` counts as on: a missing row, a module added after the row was
 * saved, or a value someone mangled by hand. A module disappearing by
 * accident would be worse than one staying visible.
 */
export function resolveFeatures(saved: unknown): Features {
  const row =
    saved !== null && typeof saved === 'object' && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : {};

  const out = {} as Features;
  for (const key of FEATURE_KEYS) {
    const legacy = LEGACY_FEATURE_KEYS[key];
    const value = key in row || legacy === undefined ? row[key] : row[legacy];
    out[key] = value !== false;
  }
  return out;
}

/** The owner's switches → what is actually on (a child needs its parent) */
export function effectiveFeatures(switches: Features): Features {
  const out = { ...switches };
  for (const key of FEATURE_KEYS) {
    const parent = FEATURE_PARENT[key];
    if (parent && !switches[parent]) out[key] = false;
  }
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
