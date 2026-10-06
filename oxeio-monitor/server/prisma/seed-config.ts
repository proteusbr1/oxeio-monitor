/**
 * The first work policy's numbers, from the environment.
 *
 * Defaults are the setup wizard's starting point when no country is given
 * (`defaultWorkRules(null)` in src/setup/setup.rules.ts) — 176 h a month, 22
 * workdays, Saturday and Sunday off. Any other week is set before the first
 * seed:
 *
 *   SEED_POLICY_MONTHLY_HOURS=208
 *   SEED_POLICY_WORKDAYS=26
 *   SEED_POLICY_WEEKLY_OFF=5          # ISO days, comma-separated, or "none"
 *
 * ⚠️ Read only when the policy is first created. The seed upserts with an
 *    empty `update`, so changing these later changes nothing — the owner
 *    edits the policy in Settings → Policies, where the change is audited.
 * ⚠️ A value that does not parse stops the seed. Falling back to the default
 *    would quietly create the default week in a company that asked for
 *    another one.
 */

export interface SeedPolicy {
  monthlyTargetHours: number;
  expectedWorkdays: number;
  /** ISO days (Mon = 1 … Sun = 7); empty for no weekly day off */
  weeklyOffDays: number[];
}

export const DEFAULT_SEED_POLICY: SeedPolicy = {
  monthlyTargetHours: 176,
  expectedWorkdays: 22,
  weeklyOffDays: [6, 7],
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
    weeklyOffDays:
      off === ''
        ? DEFAULT_SEED_POLICY.weeklyOffDays
        : off.toLowerCase() === 'none'
          ? []
          : [
              ...new Set(
                off
                  .split(',')
                  .map((d) =>
                    // an empty piece ("6,") is an error, not a default day
                    numberFrom('SEED_POLICY_WEEKLY_OFF', d.trim() || '?', 0, 1, 7, true),
                  ),
              ),
            ].sort((a, b) => a - b),
  };
}

/**
 * Which country's public holidays the seed writes — `SEED_COUNTRY`, an ISO
 * 3166-1 alpha-2 code — or `null` for none.
 *
 * - unset, empty or `none` → no holidays (add them later on Settings →
 *   Policies & holidays, or import a file with `prisma/import-holidays.ts`);
 * - `SEED_HOLIDAYS=false` → none as well;
 * - a two-letter code → that country's nationwide public holidays, from the
 *   same public calendar the setup wizard uses (src/calendar/public-holidays.ts);
 * - anything else → an error, not a silent "no holidays".
 *
 * ⚠️ There is no default country on purpose: every holiday takes a workday
 *    out of the month, so a guessed country would start a company on targets,
 *    pace and prorated salary computed on holidays it does not have.
 * ⚠️ `SEED_HOLIDAYS` is matched against exactly `'false'`, the same way the
 *    seed matches `SEED_HOLIDAYS_PAST` against exactly `'true'`.
 */
export function seedHolidayCountry(env: {
  SEED_COUNTRY?: string;
  SEED_HOLIDAYS?: string;
}): string | null {
  if (env.SEED_HOLIDAYS === 'false') return null;
  const code = (env.SEED_COUNTRY ?? '').trim().toUpperCase();
  if (code === '' || code === 'NONE') return null;
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new Error(
      `SEED_COUNTRY="${env.SEED_COUNTRY}" must be a two-letter country code (e.g. BR, PT, IN) or "none".`,
    );
  }
  return code;
}
