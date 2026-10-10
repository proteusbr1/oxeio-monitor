import type { TodayPerson } from '../../api/schedule';
import { translate } from '../../i18n';
import { clockOf, minutesText } from '../schedule/schedule.format';

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

/**
 * One person's day so far, in three short lines for the Live Board. What
 * counts as a breach is the server's call (schedule.rules › checkDay); this
 * only words it, plus "not in yet" once the start time has passed.
 */
export function todayStatus(p: TodayPerson, nowMin: number): TodayStatus {
  if (!p.checkedToday) {
    return {
      arrival: translate('Not scheduled today'),
      breakState: 'none',
      breakText: null,
      leaving: null,
      tone: 'off',
    };
  }
  const attention = p.breaches.length > 0;
  if (p.arrivedMin === null) {
    const due = nowMin > p.startMin;
    return {
      arrival: due
        ? translate('Not in yet')
        : translate('Expected at {{time}}', { time: clockOf(p.startMin) }),
      breakState: p.requiredBreakMin > 0 ? 'pending' : 'none',
      breakText: null,
      leaving: null,
      tone: due || attention ? 'attention' : 'ok',
    };
  }

  const arrival =
    p.lateMin > 0
      ? translate('Arrived {{time}} · {{duration}} late', {
          time: clockOf(p.arrivedMin),
          duration: minutesText(p.lateMin),
        })
      : translate('Arrived {{time}}', { time: clockOf(p.arrivedMin) });

  const { breakState, breakText } = breakOf(p);

  const gone = p.leftMin !== null && (p.final || nowMin > p.endMin);
  const leaving = !gone
    ? translate('Leaves at {{time}}', { time: clockOf(p.endMin) })
    : p.earlyLeaveMin > 0
      ? translate('Left {{time}} · {{duration}} early', {
          time: clockOf(p.leftMin),
          duration: minutesText(p.earlyLeaveMin),
        })
      : translate('Left {{time}}', { time: clockOf(p.leftMin) });

  return {
    arrival,
    breakState,
    breakText,
    leaving,
    tone: attention || p.lateMin > 0 ? 'attention' : 'ok',
  };
}

function breakOf(
  p: TodayPerson,
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
    breakText: translate('Break pending · window until {{time}}', {
      time: clockOf(p.breakToMin),
    }),
  };
}

/** How many people have at least one breach today */
export function breachCount(people: readonly Pick<TodayPerson, 'breaches'>[]) {
  return people.filter((p) => p.breaches.length > 0).length;
}
