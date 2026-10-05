import { describe, expect, it } from 'vitest';

import {
  changedFeatures,
  FEATURE_KEYS,
  isFeatureKey,
  resolveFeatures,
} from '../src/features/features.rules';

const ALL_ON = {
  payroll: true,
  deposits: true,
  designTargets: true,
  staffScreenshots: true,
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
      resolveFeatures({ payroll: 'no', deposits: 0, designTargets: null }),
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
