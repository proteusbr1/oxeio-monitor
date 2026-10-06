/**
 * The pure part of the work policy rules, mainly the **capture window**.
 *
 * Here one of the product's hard rules is enforced in code, not types:
 * screenshots only 07:00-23:00 ([ADR-011c](../../../docs/05-Options-Decisions.md)).
 * This is the only place where a person can change that window, so the guard
 * lives here too.
 */

/** 'HH:MM': the limits approved in ADR-011c */
export const CAPTURE_EARLIEST = '07:00';
export const CAPTURE_LATEST = '23:00';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' -> minutes since midnight. `null` if the format is wrong. */
export function hhmmToMinutes(value: string): number | null {
  const m = HHMM.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * `null` if fine, otherwise a string stating the reason.
 *
 * Careful: no exception is thrown, because then the pure function would be
 * tied to NestJS's `BadRequestException`, and tests would have to pull in the
 * HTTP layer. The reason is returned as a string and the service itself
 * decides which status it goes out with.
 */
export function captureWindowProblem(from: string, to: string): string | null {
  const start = hhmmToMinutes(from);
  const end = hhmmToMinutes(to);

  if (start === null) return `The capture window start must be in 'HH:MM' format — got "${from}"`;
  if (end === null) return `The capture window end must be in 'HH:MM' format — got "${to}"`;

  const earliest = hhmmToMinutes(CAPTURE_EARLIEST) as number;
  const latest = hhmmToMinutes(CAPTURE_LATEST) as number;

  if (start < earliest || end > latest) {
    return `Screenshot times cannot fall outside ${CAPTURE_EARLIEST}–${CAPTURE_LATEST} (ADR-011c)`;
  }

  // Careful: equal is rejected too. from == to is a zero-length window: the
  // agent would take no pictures at all while the dashboard looked fine.
  // "Someone turned screenshots off" and "screenshots are not working" could
  // not be told apart.
  if (start >= end) {
    return 'The capture window start must be before the end';
  }

  return null;
}

/**
 * `null` means "pictures 24 hours", as the schema comment says, and that is
 * what breaks ADR-011c. So `null` can never be set through this module; if no
 * window is given, the approved default is set.
 */
export const DEFAULT_CAPTURE_WINDOW = {
  screenshotFrom: CAPTURE_EARLIEST,
  screenshotTo: CAPTURE_LATEST,
} as const;

/** The regime fields a policy form sends (see work-regime.ts) */
export interface RegimeInput {
  targetBasis?: 'month' | 'week' | 'day' | 'none';
  weeklyTargetHours?: number | null;
  dailyTargetHours?: number | null;
  breakMinutes?: number | null;
  overtimeMultiplier?: number | null;
  deductShortfall?: boolean;
}

/**
 * The regime part of a policy save, checked: the basis needs its hours (a
 * weekly target without weekly hours would quietly mean "no target").
 * `before` is the stored policy on an update, so a partial save is checked
 * against what it will become.
 */
export function regimeData(
  input: RegimeInput,
  before?: {
    targetBasis: string;
    weeklyTargetHours: { toString(): string } | null;
    dailyTargetHours: { toString(): string } | null;
  },
): RegimeInput {
  const basis = input.targetBasis ?? (before?.targetBasis as RegimeInput['targetBasis']) ?? 'month';
  const weekly = input.weeklyTargetHours !== undefined ? input.weeklyTargetHours : before?.weeklyTargetHours ?? null;
  const daily = input.dailyTargetHours !== undefined ? input.dailyTargetHours : before?.dailyTargetHours ?? null;
  if (basis === 'week' && (weekly === null || Number(weekly.toString()) <= 0)) {
    throw new Error('A weekly target needs the hours per week (e.g. 40)');
  }
  if (basis === 'day' && (daily === null || Number(daily.toString()) <= 0)) {
    throw new Error('A daily target needs the hours per day (e.g. 8)');
  }
  const out: RegimeInput = {};
  for (const key of ['targetBasis', 'weeklyTargetHours', 'dailyTargetHours', 'breakMinutes', 'overtimeMultiplier', 'deductShortfall'] as const) {
    if (input[key] !== undefined) (out as Record<string, unknown>)[key] = input[key];
  }
  return out;
}
