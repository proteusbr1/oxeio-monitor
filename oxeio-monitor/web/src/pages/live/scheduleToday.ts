import type { LiveCard } from '../../api/dashboard';
import type { ScheduleToday, TodayPerson } from '../../api/schedule';
import { translate } from '../../i18n';
import { workDateOf, workWallOf } from '../../lib/format';
import { clockOf, minutesText } from '../schedule/schedule.format';
import { isWorking } from './onTheClock';

export type BreakState = 'done' | 'ongoing' | 'pending' | 'missed' | 'none';

export interface TodayStatus {
  arrival: string;
  breakState: BreakState;
  /** null when there is nothing to say about the break */
  breakText: string | null;
  leaving: string | null;
  /** `attention` = something to look at; `off` = no schedule today */
  tone: 'ok' | 'attention' | 'off';
}

/** What the live board (refreshed every 15 s) knows about the person right now */
export type LiveSignal = Pick<LiveCard, 'status' | 'todayWorkedSec'>;

/**
 * One person's day so far, in three short lines for the Live Board. What
 * counts as a breach is the server's call (schedule.rules › checkDay); this
 * only words it.
 *
 * Careful: the schedule row comes from the roll-up, up to 15 minutes old.
 * The live card is fresher, so it decides "not in yet" (no time today at all)
 * and "left" (not working right now); without it, nobody is called missing
 * just because the row has not caught up.
 */
export function todayStatus(
  p: TodayPerson,
  nowMin: number,
  live?: LiveSignal | null,
): TodayStatus {
  if (!p.checkedToday) {
    return {
      arrival: translate('Not scheduled today'),
      breakState: 'none',
      breakText: null,
      leaving: null,
      tone: 'off',
    };
  }
  const attention = p.breaches.length > 0 || p.lateMin > 0;
  const workingNow = live != null && isWorking(live.status);
  const timeToday = workingNow || (live?.todayWorkedSec ?? 0) > 0;

  if (p.arrivedMin === null && !timeToday) {
    const missing = nowMin > p.startMin + p.toleranceMarkMin;
    return {
      arrival: missing
        ? translate('Not in yet')
        : translate('Expected at {{time}}', { time: clockOf(p.startMin) }),
      breakState: p.requiredBreakMin > 0 ? 'pending' : 'none',
      breakText: null,
      leaving: null,
      tone: missing || attention ? 'attention' : 'ok',
    };
  }

  const arrival =
    p.arrivedMin === null
      ? translate('At work')
      : p.lateMin > 0
        ? translate('Arrived {{time}} · {{duration}} late', {
            time: clockOf(p.arrivedMin),
            duration: minutesText(p.lateMin),
          })
        : translate('Arrived {{time}}', { time: clockOf(p.arrivedMin) });

  const { breakState, breakText } = breakOf(p, nowMin);

  const pastEnd = p.final || nowMin > p.endMin;
  const end = clockOf(p.endMin);
  let leaving: string;
  if (pastEnd && workingNow && !p.final) {
    leaving = translate('Working past {{time}}', { time: end });
  } else if (pastEnd && p.leftMin !== null) {
    leaving =
      p.earlyLeaveMin > 0
        ? translate('Left {{time}} · {{duration}} early', {
            time: clockOf(p.leftMin),
            duration: minutesText(p.earlyLeaveMin),
          })
        : translate('Left {{time}}', { time: clockOf(p.leftMin) });
  } else {
    leaving = translate('Leaves at {{time}}', { time: end });
  }

  return {
    arrival,
    breakState,
    breakText,
    leaving,
    tone: attention ? 'attention' : 'ok',
  };
}

function breakOf(
  p: TodayPerson,
  nowMin: number,
): Pick<TodayStatus, 'breakState' | 'breakText'> {
  if (p.requiredBreakMin <= 0) return { breakState: 'none', breakText: null };
  const taken =
    p.breakStartMin === null
      ? null
      : translate('Break {{time}} · {{duration}}', {
          time: clockOf(p.breakStartMin),
          duration: minutesText(p.breakMin),
        });
  if (
    p.breaches.includes('break_short') ||
    p.breaches.includes('break_missing')
  ) {
    return {
      breakState: 'missed',
      breakText: taken ?? translate('No break taken'),
    };
  }
  if (p.breakMin >= p.requiredBreakMin) {
    return { breakState: 'done', breakText: taken };
  }
  // The server counts the pause going on right now as a gap that starts where
  // the last stretch ended; an earlier, shorter pause is not the break yet.
  if (
    p.breakStartMin !== null &&
    p.breakMin > 0 &&
    p.breakStartMin === p.leftMin &&
    !p.final
  ) {
    return {
      breakState: 'ongoing',
      breakText: translate('On break since {{time}}', {
        time: clockOf(p.breakStartMin),
      }),
    };
  }
  return {
    breakState: 'pending',
    // past the window the server has yet to judge it (window end + the break)
    breakText:
      nowMin > p.breakToMin
        ? translate('Break pending')
        : translate('Break pending · window until {{time}}', {
            time: clockOf(p.breakToMin),
          }),
  };
}

/** How many people have at least one breach today */
export function breachCount(people: readonly Pick<TodayPerson, 'breaches'>[]) {
  return people.filter((p) => p.breaches.length > 0).length;
}

/**
 * Minutes since the work zone's midnight right now, for the schedule's day:
 * fresher than the `nowMin` of the last poll. Once that day is over, 1440.
 */
export function liveNowMin(
  today: Pick<ScheduleToday, 'workDate' | 'nowMin'>,
  now: Date = new Date(),
): number {
  const date = workDateOf(now);
  if (date > today.workDate) return 1440;
  if (date < today.workDate) return today.nowMin;
  const wall = workWallOf(now);
  return wall.getUTCHours() * 60 + wall.getUTCMinutes();
}
