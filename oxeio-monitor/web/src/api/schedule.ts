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
