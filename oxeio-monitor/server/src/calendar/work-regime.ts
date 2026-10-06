import type { TargetBasis } from '@prisma/client';

/**
 * A work policy's hours target, whatever way it is stated.
 *
 * The rest of the system thinks in "hours per workday": a month's target is
 * that times the workdays in it, minus leave (summary/proration.ts), and the
 * daily, weekly and pace figures follow from it. This module turns each basis
 * into the pair the calculations take — a period's target and the workdays it
 * is spread over — so per-month, per-week, per-day and no-target policies all
 * go through the same formulas:
 *
 *   month  monthlyTargetHours over expectedWorkdays     (the original model)
 *   week   weeklyTargetHours over the working days in a week (7 − days off)
 *   day    dailyTargetHours over 1 day                  (e.g. a fixed schedule)
 *   none   0 — hours are recorded and shown, nobody is ahead or behind
 */
export interface RegimePolicy {
  targetBasis?: TargetBasis | null;
  monthlyTargetHours: number | { toString(): string };
  expectedWorkdays: number;
  weeklyTargetHours?: number | { toString(): string } | null;
  dailyTargetHours?: number | { toString(): string } | null;
  weeklyOffDays?: number[] | null;
}

export interface TargetSpread {
  /** the period's target in seconds (0 = no target) */
  periodTargetSec: number;
  /** the workdays it is spread over (always ≥ 1) */
  periodWorkdays: number;
}

const HOUR = 3600;
const num = (v: number | { toString(): string } | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v.toString());

/** Defaults when a person has no policy: 176 h over 22 days (8-hour days, Mon–Fri) */
export const DEFAULT_SPREAD: TargetSpread = { periodTargetSec: 176 * HOUR, periodWorkdays: 22 };

export function targetSpreadOf(policy: RegimePolicy | null | undefined): TargetSpread {
  if (!policy) return DEFAULT_SPREAD;
  switch (policy.targetBasis ?? 'month') {
    case 'none':
      return { periodTargetSec: 0, periodWorkdays: 1 };
    case 'day':
      return { periodTargetSec: Math.max(0, num(policy.dailyTargetHours)) * HOUR, periodWorkdays: 1 };
    case 'week': {
      const workdays = Math.max(1, 7 - new Set(policy.weeklyOffDays ?? []).size);
      return { periodTargetSec: Math.max(0, num(policy.weeklyTargetHours)) * HOUR, periodWorkdays: workdays };
    }
    default:
      return {
        periodTargetSec: Math.max(0, num(policy.monthlyTargetHours)) * HOUR,
        periodWorkdays: Math.max(1, policy.expectedWorkdays),
      };
  }
}

/** Seconds expected on one workday (0 = no target) */
export function dailyTargetSecOf(policy: RegimePolicy | null | undefined): number {
  const { periodTargetSec, periodWorkdays } = targetSpreadOf(policy);
  return periodTargetSec / periodWorkdays;
}

export function hasTarget(policy: RegimePolicy | null | undefined): boolean {
  return dailyTargetSecOf(policy) > 0;
}

/** The fields a query must select for targetSpreadOf() */
export const REGIME_SELECT = {
  targetBasis: true,
  monthlyTargetHours: true,
  expectedWorkdays: true,
  weeklyTargetHours: true,
  dailyTargetHours: true,
  weeklyOffDays: true,
} as const;
