import { api } from './client';

/**
 * Module switches — parts of the dashboard a company may not use. Off hides
 * the screens; the server blocks the endpoints and deletes nothing.
 */
export interface Features {
  payroll: boolean;
  deposits: boolean;
  designTargets: boolean;
}

export type FeatureKey = keyof Features;

/** Every module on — what an install that never touched the switches gets */
export const ALL_FEATURES_ON: Features = {
  payroll: true,
  deposits: true,
  designTargets: true,
};

/** What each module already holds, so a switch never hides data by surprise */
export interface FeatureUsage {
  salariedStaff: number;
  depositMonths: number;
  designTargets: number;
  designers: number;
}

export interface FeatureSettingsView {
  features: Features;
  usage: FeatureUsage;
}

export function getFeatures(signal?: AbortSignal): Promise<Features> {
  return api<Features>('/features', { signal });
}

export function getFeatureSettings(
  signal?: AbortSignal,
): Promise<FeatureSettingsView> {
  return api<FeatureSettingsView>('/settings/features', { signal });
}

export function saveFeatures(
  changes: Partial<Features>,
): Promise<FeatureSettingsView> {
  return api<FeatureSettingsView>('/settings/features', {
    method: 'PATCH',
    body: changes,
  });
}
