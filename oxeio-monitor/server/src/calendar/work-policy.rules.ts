/**
 * The pure part of the work policy rules, mainly the **capture window**.
 *
 * A policy either takes screenshots whenever the computer is in use (no
 * window: `screenshotFrom`/`screenshotTo` both null) or only between two
 * times of day. "In use" is the agent's own rule and is not relaxed here:
 * a picture is only ever taken while someone is active at the keyboard or
 * mouse — never while the PC is idle, locked or asleep.
 *
 * History: the original product fixed the window to 07:00–23:00 for
 * everyone (ADR-011c, docs/history/05-Options-Decisions.md) so personal use
 * late at night was never pictured. For company computers that are only on
 * during work, the owner may now choose — the choice is the policy's, shown
 * to staff on My data, and belongs in the monitoring policy they sign.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' -> minutes since midnight. `null` if the format is wrong. */
export function hhmmToMinutes(value: string): number | null {
  const m = HHMM.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * `null` if fine, otherwise a string stating the reason. Both ends `null` =
 * whenever the computer is in use.
 *
 * Careful: no exception is thrown, because then the pure function would be
 * tied to NestJS's `BadRequestException`, and tests would have to pull in the
 * HTTP layer. The reason is returned as a string and the service itself
 * decides which status it goes out with.
 */
export function captureWindowProblem(from: string | null, to: string | null): string | null {
  if (from === null && to === null) return null;
  if (from === null || to === null) {
    return 'Give both the start and the end of the capture window, or neither (whenever the computer is in use)';
  }

  const start = hhmmToMinutes(from);
  const end = hhmmToMinutes(to);

  if (start === null) return `The capture window start must be in 'HH:MM' format — got "${from}"`;
  if (end === null) return `The capture window end must be in 'HH:MM' format — got "${to}"`;

  // Careful: equal is rejected too. from == to is a zero-length window: the
  // agent would take no pictures at all while the dashboard looked fine.
  // "Someone turned screenshots off" and "screenshots are not working" could
  // not be told apart (switching screenshots off is its own setting).
  if (start >= end) {
    return 'The capture window start must be before the end';
  }

  return null;
}

/** A new policy takes screenshots whenever the computer is in use */
export const DEFAULT_CAPTURE_WINDOW = {
  screenshotFrom: null,
  screenshotTo: null,
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

/** The schedule fields of a policy, as they will be stored */
export interface ScheduleInput {
  scheduleEnforced: boolean;
  officeFrom: string | null;
  officeTo: string | null;
  breakMinutes: number | null;
  breakWindowFrom: string | null;
  breakWindowTo: string | null;
  toleranceMarkMin: number;
  toleranceDayMin: number;
}

/** `null` if the schedule can be saved, otherwise why not (checked as it will be stored) */
export function scheduleProblem(s: ScheduleInput): string | null {
  for (const v of [s.toleranceMarkMin, s.toleranceDayMin]) {
    if (!Number.isInteger(v) || v < 0 || v > 60) return 'Tolerances must be whole minutes between 0 and 60';
  }
  if (!s.scheduleEnforced) return null;

  const start = s.officeFrom ? hhmmToMinutes(s.officeFrom) : null;
  const end = s.officeTo ? hhmmToMinutes(s.officeTo) : null;
  if (start === null || end === null) return 'A checked schedule needs the working hours (from and until)';
  if (start >= end) return 'The working hours must start before they end';
  if ((s.breakMinutes ?? 0) >= end - start) return 'The break must be shorter than the working day';

  if ((s.breakWindowFrom === null) !== (s.breakWindowTo === null)) {
    return 'Give both ends of the break window, or neither';
  }
  if (s.breakWindowFrom !== null && s.breakWindowTo !== null) {
    const from = hhmmToMinutes(s.breakWindowFrom);
    const to = hhmmToMinutes(s.breakWindowTo);
    if (from === null || to === null) return "The break window must be in 'HH:MM' format";
    if (from >= to) return 'The break window must start before it ends';
    if (from < start || to > end) return 'The break window must be inside the working hours';
  }
  return null;
}
