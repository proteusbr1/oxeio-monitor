import { describe, expect, it } from 'vitest';

import {
  changedFeatures,
  effectiveFeatures,
  FEATURE_KEYS,
  isFeatureKey,
  resolveFeatures,
} from '../src/features/features.rules';
import { DEFAULT_RETENTION_DAYS, resolvePrivacy } from '../src/privacy/privacy.rules';

const ALL_ON = {
  payroll: true,
  deposits: true,
  screenshots: true,
  appTracking: true,
  tasks: true,
};

describe('resolveFeatures', () => {
  it('no saved row → every module on, as before the switches existed', () => {
    expect(resolveFeatures(null)).toEqual(ALL_ON);
    expect(resolveFeatures(undefined)).toEqual(ALL_ON);
  });

  it('only an explicit false turns a module off', () => {
    expect(resolveFeatures({ deposits: false })).toEqual({
      ...ALL_ON,
      deposits: false,
    });
  });

  it('a mangled value keeps the module on', () => {
    expect(
      resolveFeatures({ payroll: 'no', deposits: 0, tasks: null }),
    ).toEqual(ALL_ON);
    expect(resolveFeatures(['payroll'])).toEqual(ALL_ON);
    expect(resolveFeatures('off')).toEqual(ALL_ON);
  });

  it('unknown keys are ignored', () => {
    expect(resolveFeatures({ salary: false, payroll: false })).toEqual({
      ...ALL_ON,
      payroll: false,
    });
  });
});

describe('resolveFeatures — the renamed tasks switch', () => {
  /** Rows saved before the rename say `designTargets` */
  it('reads the legacy key when `tasks` is absent', () => {
    expect(resolveFeatures({ designTargets: false }).tasks).toBe(false);
    expect(resolveFeatures({ designTargets: true }).tasks).toBe(true);
  });

  it('the new key wins when both are present', () => {
    expect(resolveFeatures({ designTargets: false, tasks: true }).tasks).toBe(true);
    expect(resolveFeatures({ designTargets: true, tasks: false }).tasks).toBe(false);
  });

  it('the legacy key is not a module of its own', () => {
    expect(Object.keys(resolveFeatures({ designTargets: false }))).not.toContain('designTargets');
  });
});

describe('changedFeatures', () => {
  it('lists only the switches that moved', () => {
    expect(
      changedFeatures(ALL_ON, { ...ALL_ON, payroll: false }),
    ).toEqual({ payroll: false });
    expect(changedFeatures(ALL_ON, ALL_ON)).toEqual({});
  });
});

describe('isFeatureKey', () => {
  it('knows every module and nothing else', () => {
    for (const key of FEATURE_KEYS) expect(isFeatureKey(key)).toBe(true);
    expect(isFeatureKey('salary')).toBe(false);
    expect(isFeatureKey(1)).toBe(false);
  });
});

describe('effectiveFeatures — a child module needs its parent', () => {
  it('deposits are off while payroll is, and come back with it', () => {
    const off = effectiveFeatures({ ...ALL_ON, payroll: false });
    expect(off.deposits).toBe(false);
    expect(effectiveFeatures(ALL_ON).deposits).toBe(true);
  });

  /** Only start detection needs window titles, and it goes inactive by itself */
  it('tasks stay on while apps & websites are off — tasks have no parent', () => {
    expect(effectiveFeatures({ ...ALL_ON, appTracking: false }).tasks).toBe(true);
  });

  it('the old "screenshots for staff" key is not a module any more', () => {
    expect(resolveFeatures({ staffScreenshots: false })).toEqual(ALL_ON);
  });
});

describe('resolvePrivacy', () => {
  it('defaults: staff see their own, kept 90 days', () => {
    expect(resolvePrivacy(null, null)).toEqual({ staffSeeOwnScreenshots: true, screenshotRetentionDays: DEFAULT_RETENTION_DAYS });
  });

  it('takes the old module switch until Privacy is saved', () => {
    expect(resolvePrivacy(null, { staffScreenshots: false }).staffSeeOwnScreenshots).toBe(false);
    expect(resolvePrivacy({ staffSeeOwnScreenshots: true }, { staffScreenshots: false }).staffSeeOwnScreenshots).toBe(true);
  });

  it('a retention outside 7–3650 days falls back to the default', () => {
    expect(resolvePrivacy({ screenshotRetentionDays: 30 }, null).screenshotRetentionDays).toBe(30);
    expect(resolvePrivacy({ screenshotRetentionDays: 2 }, null).screenshotRetentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolvePrivacy({ screenshotRetentionDays: 'x' }, null).screenshotRetentionDays).toBe(DEFAULT_RETENTION_DAYS);
  });
});
