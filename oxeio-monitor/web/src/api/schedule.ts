import { api } from './client';
import { qs } from './query';

/** Schedule compliance — server `schedule/schedule.controller.ts` (owner, manager) */
export type Breach =
  'late' | 'early_leave' | 'break_short' | 'break_missing' | 'no_show';

export interface ScheduleDayView {
  date: string;
  arrivedMin: number | null;
  leftMin: number | null;
  breakStartMin: number | null;
  breakMin: number;
  lateMin: number;
  earlyLeaveMin: number;
  balanceMin: number;
  breaches: Breach[];
  /** `false` while the day is still going: the numbers can change */
  final: boolean;
}

export interface ScheduleMonthView {
  employee: { id: number; fullName: string };
  days: ScheduleDayView[];
  totals: {
    late: number;
    earlyLeave: number;
    breakShort: number;
    breakMissing: number;
    noShow: number;
    balanceMin: number;
  };
  /** the checked schedule as it stands now; null when none is checked */
  requiredBreakMin: number | null;
  /** 'HH:MM' */
  officeFrom: string | null;
  officeTo: string | null;
}

/** People whose policy checks a schedule */
export function scheduledPeople(
  signal?: AbortSignal,
): Promise<{ id: number; fullName: string }[]> {
  return api('/schedule/people', { signal });
}

export function scheduleMonth(
  employeeId: number,
  month: string,
  signal?: AbortSignal,
): Promise<ScheduleMonthView> {
  return api<ScheduleMonthView>(`/schedule${qs({ employeeId, month })}`, {
    signal,
  });
}

/** One person on the Live Board's schedule card; minutes since local midnight */
export interface TodayPerson {
  employeeId: number;
  fullName: string;
  startMin: number;
  endMin: number;
  requiredBreakMin: number;
  breakFromMin: number;
  breakToMin: number;
  /** minutes off at either end that do not count as late / early */
  toleranceMarkMin: number;
  /** false on a day off, a holiday, leave or outside employment */
  checkedToday: boolean;
  /** today's check as the last roll-up left it; empty before the first one */
  arrivedMin: number | null;
  leftMin: number | null;
  breakStartMin: number | null;
  breakMin: number;
  lateMin: number;
  earlyLeaveMin: number;
  breaches: Breach[];
  final: boolean;
}

export interface ScheduleToday {
  workDate: string;
  /** minutes since the work zone's midnight, now */
  nowMin: number;
  people: TodayPerson[];
}

/** Everyone on a checked schedule, today (owner, manager) */
export function scheduleToday(signal?: AbortSignal): Promise<ScheduleToday> {
  return api<ScheduleToday>('/schedule/today', { signal });
}
