import { api } from './client';

/**
 * Module switches — whole parts of the product a company may not use. Off
 * hides the screens; the server blocks the endpoints (and tells the agents to
 * stop capturing) and deletes nothing.
 *
 * ⚠️ Only whole modules belong here. A choice *inside* a module (who sees
 *    screenshots, how long they are kept) is a setting on that module's own
 *    page — Settings → Privacy — never a switch on this list.
 */
export interface Features {
  payroll: boolean;
  /** needs `payroll` — off while payroll is off */
  deposits: boolean;
  /** pictures of the screen, for everyone */
  screenshots: boolean;
  /** which apps and websites are used — hours do not depend on it */
  appTracking: boolean;
  /**
   * a pool of tasks handed out each day. No parent: start detection inside it
   * reads window titles from `appTracking`, but the tasks work without it.
   */
  tasks: boolean;
  /** the pay-period hours statement for finance. No parent: finance must not need salaries. */
  hoursStatement: boolean;
}

export type FeatureKey = keyof Features;

/** Every module on — what an install that never touched the switches gets */
export const ALL_FEATURES_ON: Features = {
  payroll: true,
  deposits: true,
  screenshots: true,
  appTracking: true,
  tasks: true,
  hoursStatement: true,
};

/**
 * A module that only works inside another one (the server's `FEATURE_PARENT`).
 * While the parent is off the child is off too; its own switch is kept.
 */
export const FEATURE_PARENT: Partial<Record<FeatureKey, FeatureKey>> = {
  deposits: 'payroll',
};

/** What each module already holds, so a switch never hides data by surprise */
export interface FeatureUsage {
  /** active people with pay terms set (a salary or an hourly rate) */
  paidStaff: number;
  /** monthly deposit rows ever held, settled or not */
  depositMonths: number;
  /** whether any screenshot is stored */
  hasScreenshots: boolean;
  /** whether any app or website usage is stored */
  hasAppUsage: boolean;
  /** tasks ever added */
  tasks: number;
  /** active people who receive tasks */
  taskReceivers: number;
}

export interface FeatureSettingsView {
  /** the owner's switches, as saved */
  features: Features;
  /** what is actually on — what `GET /features` answers */
  effective: Features;
  usage: FeatureUsage;
}

/** What is actually on (a child module is off while its parent is) */
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
