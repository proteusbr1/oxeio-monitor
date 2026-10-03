/**
 * The first work policy's numbers, from the environment.
 *
 * Defaults are exactly the ones the seed always wrote — 208 h a month, 26
 * workdays, Friday off — so a deployment that sets nothing gets the same
 * policy. Another country sets its own week before the first seed:
 *
 *   SEED_POLICY_MONTHLY_HOURS=176
 *   SEED_POLICY_WORKDAYS=22
 *   SEED_POLICY_WEEKLY_OFF=7          # ISO day, or "none"
 *
 * ⚠️ Read only when the policy is first created. The seed upserts with an
 *    empty `update`, so changing these later changes nothing — the owner
 *    edits the policy in Settings → Policies, where the change is audited.
 * ⚠️ A value that does not parse stops the seed. Falling back to the default
 *    would quietly create a Bangladesh week in a country that asked for
 *    another one.
 */

export interface SeedPolicy {
  monthlyTargetHours: number;
  expectedWorkdays: number;
  /** ISO day (Fri = 5), or null for no weekly day off */
  weeklyOffDay: number | null;
}

export const DEFAULT_SEED_POLICY: SeedPolicy = {
  monthlyTargetHours: 208,
  expectedWorkdays: 26,
  weeklyOffDay: 5,
};

function numberFrom(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `${name}="${raw}" must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`,
    );
  }
  return value;
}

export function seedPolicyFromEnv(
  env: Record<string, string | undefined>,
): SeedPolicy {
  const off = env.SEED_POLICY_WEEKLY_OFF?.trim() ?? '';

  return {
    // same bounds as the dashboard's policy form (server/src/admin/dto.ts)
    monthlyTargetHours: numberFrom(
      'SEED_POLICY_MONTHLY_HOURS',
      env.SEED_POLICY_MONTHLY_HOURS,
      DEFAULT_SEED_POLICY.monthlyTargetHours,
      1,
      744,
      false,
    ),
    expectedWorkdays: numberFrom(
      'SEED_POLICY_WORKDAYS',
      env.SEED_POLICY_WORKDAYS,
      DEFAULT_SEED_POLICY.expectedWorkdays,
      1,
      31,
      true,
    ),
    weeklyOffDay:
      off === ''
        ? DEFAULT_SEED_POLICY.weeklyOffDay
        : off.toLowerCase() === 'none'
          ? null
          : numberFrom('SEED_POLICY_WEEKLY_OFF', off, 5, 1, 7, true),
  };
}
