import {
  nextLocalMidnight,
  startOfWorkDate,
  workWallOf,
} from '../agent/util/work-time';
import { measureOf } from '../calendar/work-regime';
import { hhmmToMinutes } from '../calendar/work-policy.rules';
import { MINUTES_PER_DAY, type SchedulePolicy } from './schedule.rules';

/** The policy fields a query must select for schedulePolicyOf() */
export const SCHEDULE_SELECT = {
  scheduleEnforced: true,
  officeFrom: true,
  officeTo: true,
  breakMinutes: true,
  breakWindowFrom: true,
  breakWindowTo: true,
  toleranceMarkMin: true,
  toleranceDayMin: true,
} as const;

export interface ScheduleRow {
  scheduleEnforced: boolean;
  officeFrom: string | null;
  officeTo: string | null;
  breakMinutes: number | null;
  breakWindowFrom: string | null;
  breakWindowTo: string | null;
  toleranceMarkMin: number;
  toleranceDayMin: number;
}

/** The schedule to check, or null when this policy checks none */
export function schedulePolicyOf(
  row: ScheduleRow | null | undefined,
): SchedulePolicy | null {
  if (!row?.scheduleEnforced || !row.officeFrom || !row.officeTo) return null;
  const startMin = hhmmToMinutes(row.officeFrom);
  const endMin = hhmmToMinutes(row.officeTo);
  if (startMin === null || endMin === null || endMin <= startMin) return null;

  const from = row.breakWindowFrom ? hhmmToMinutes(row.breakWindowFrom) : null;
  const to = row.breakWindowTo ? hhmmToMinutes(row.breakWindowTo) : null;
  return {
    startMin,
    endMin,
    breakMin: row.breakMinutes ?? 0,
    breakFromMin: from ?? startMin,
    breakToMin: to ?? endMin,
    toleranceMarkMin: row.toleranceMarkMin,
    toleranceDayMin: row.toleranceDayMin,
  };
}

/**
 * Whether two policies check the same schedule (none and none count as the
 * same). The check reads presence blocks merged by the presence gap, so with a
 * schedule on both sides a different gap is a different check.
 */
export function sameSchedule(
  a: (ScheduleRow & { presenceGapMin?: number | null }) | null | undefined,
  b: (ScheduleRow & { presenceGapMin?: number | null }) | null | undefined,
): boolean {
  const x = schedulePolicyOf(a);
  const y = schedulePolicyOf(b);
  if (x === null || y === null) return x === y;
  if (measureOf(a).presenceGapSec !== measureOf(b).presenceGapSec) return false;
  return (Object.keys(x) as (keyof SchedulePolicy)[]).every(
    (k) => x[k] === y[k],
  );
}

/**
 * Minutes since the work zone's midnight on `workDate`, by the wall clock
 * (so 08:00 is 480 even on a daylight-saving day). The instant that ends the
 * day — the next local midnight — is 1440, not 0.
 */
export function minuteOfWorkDay(instant: Date, workDate: Date): number {
  const start = startOfWorkDate(workDate);
  if (instant <= start) return 0;
  if (instant >= nextLocalMidnight(start)) return MINUTES_PER_DAY;
  const wall = workWallOf(instant);
  return wall.getUTCHours() * 60 + wall.getUTCMinutes();
}
