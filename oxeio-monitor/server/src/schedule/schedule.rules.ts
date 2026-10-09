/**
 * Schedule compliance — the pure rule.
 *
 * Input: the day's presence blocks (active stretches joined across short
 * pauses, summary.math `presenceSpans`) as minutes since local midnight, the
 * policy's schedule, and "now" in the same unit (1440 once the day is over).
 *
 * Tolerance works like a clock-in rule common in labour codes: up to
 * `toleranceMarkMin` off at each end is ignored, but if both ends together
 * exceed `toleranceDayMin`, both are reported. With 0 / 0 every minute counts.
 *
 * Nothing is reported before it can be known: a running day never shows an
 * early leave before the end time, nor a missing break before the break
 * window plus the break's length has passed.
 */

export type Breach =
  'late' | 'early_leave' | 'break_short' | 'break_missing' | 'no_show';

export interface SchedulePolicy {
  startMin: number;
  endMin: number;
  /** the shortest continuous break that counts */
  breakMin: number;
  /** the break must start between these two times */
  breakFromMin: number;
  breakToMin: number;
  toleranceMarkMin: number;
  toleranceDayMin: number;
}

export interface DayBlock {
  fromMin: number;
  toMin: number;
}

export interface ScheduleDay {
  arrivedMin: number | null;
  leftMin: number | null;
  breakStartMin: number | null;
  breakMin: number;
  lateMin: number;
  earlyLeaveMin: number;
  /** presence minus the scheduled time (end − start − break); + = extra, − = short */
  balanceMin: number;
  breaches: Breach[];
  /** false while the day is still running */
  final: boolean;
}

export const MINUTES_PER_DAY = 1440;

export function checkDay(input: {
  blocks: readonly DayBlock[];
  policy: SchedulePolicy;
  nowMin: number;
}): ScheduleDay {
  const { policy: p, nowMin } = input;
  const blocks = [...input.blocks]
    .filter((b) => b.toMin > b.fromMin)
    .sort((a, b) => a.fromMin - b.fromMin);
  const final = nowMin >= MINUTES_PER_DAY;
  const scheduledMin = p.endMin - p.startMin - p.breakMin;
  const presenceMin = blocks.reduce(
    (total, b) => total + (b.toMin - b.fromMin),
    0,
  );
  const afterEnd = nowMin > p.endMin;

  if (blocks.length === 0) {
    return {
      arrivedMin: null,
      leftMin: null,
      breakStartMin: null,
      breakMin: 0,
      lateMin: 0,
      earlyLeaveMin: 0,
      balanceMin: -scheduledMin,
      breaches: afterEnd ? ['no_show'] : [],
      final,
    };
  }

  const arrivedMin = blocks[0].fromMin;
  const leftMin = blocks[blocks.length - 1].toMin;

  const rawLate = Math.max(0, arrivedMin - p.startMin);
  const rawEarly = afterEnd ? Math.max(0, p.endMin - leftMin) : 0;
  const overDay = rawLate + rawEarly > p.toleranceDayMin;
  const isLate = rawLate > p.toleranceMarkMin || (overDay && rawLate > 0);
  const isEarly = rawEarly > p.toleranceMarkMin || (overDay && rawEarly > 0);

  // gaps between blocks, plus the pause going on right now (only during working hours)
  const gaps: { start: number; length: number }[] = [];
  for (let i = 1; i < blocks.length; i += 1) {
    gaps.push({
      start: blocks[i - 1].toMin,
      length: blocks[i].fromMin - blocks[i - 1].toMin,
    });
  }
  if (!final && nowMin <= p.endMin && leftMin < nowMin) {
    gaps.push({ start: leftMin, length: nowMin - leftMin });
  }
  const inWindow = gaps.filter(
    (g) => g.start >= p.breakFromMin && g.start <= p.breakToMin,
  );
  const best = inWindow.reduce<{ start: number; length: number } | null>(
    (top, g) => (top === null || g.length > top.length ? g : top),
    null,
  );
  const breakJudged = final || nowMin >= p.breakToMin + p.breakMin;

  const breaches: Breach[] = [];
  if (isLate) breaches.push('late');
  if (isEarly) breaches.push('early_leave');
  if (breakJudged && p.breakMin > 0) {
    if (best === null) breaches.push('break_missing');
    else if (best.length < p.breakMin) breaches.push('break_short');
  }

  return {
    arrivedMin,
    leftMin,
    breakStartMin: best?.start ?? null,
    breakMin: best?.length ?? 0,
    lateMin: isLate ? rawLate : 0,
    earlyLeaveMin: isEarly ? rawEarly : 0,
    balanceMin: presenceMin - scheduledMin,
    breaches,
    final,
  };
}

/**
 * A month's breaches by kind, and its balance. The running day is left out
 * of the balance: its minutes are still coming (its row says "in progress").
 */
export function monthTotals(
  days: readonly Pick<ScheduleDay, 'breaches' | 'balanceMin' | 'final'>[],
) {
  const count = (b: Breach) =>
    days.filter((d) => d.breaches.includes(b)).length;
  return {
    late: count('late'),
    earlyLeave: count('early_leave'),
    breakShort: count('break_short'),
    breakMissing: count('break_missing'),
    noShow: count('no_show'),
    balanceMin: days.reduce(
      (total, d) => (d.final ? total + d.balanceMin : total),
      0,
    ),
  };
}
