import { describe, expect, it } from 'vitest';

import {
  checkDay,
  monthTotals,
  type DayBlock,
  type SchedulePolicy,
} from '../src/schedule/schedule.rules';

const m = (hhmm: string) => {
  const [h, mm] = hhmm.split(':').map(Number);
  return h * 60 + mm;
};
const block = (from: string, to: string): DayBlock => ({
  fromMin: m(from),
  toMin: m(to),
});

/** 08:00–17:00, 60-minute break starting between 11:00 and 14:00 */
const policy: SchedulePolicy = {
  startMin: m('08:00'),
  endMin: m('17:00'),
  breakMin: 60,
  breakFromMin: m('11:00'),
  breakToMin: m('14:00'),
  toleranceMarkMin: 5,
  toleranceDayMin: 10,
};
const DAY_OVER = 1440;

describe('checkDay — a full day', () => {
  it('kept the schedule: no breaches, balance 0', () => {
    const day = checkDay({
      blocks: [block('08:00', '12:00'), block('13:00', '17:00')],
      policy,
      nowMin: DAY_OVER,
    });
    expect(day).toEqual({
      arrivedMin: m('08:00'),
      leftMin: m('17:00'),
      breakStartMin: m('12:00'),
      breakMin: 60,
      lateMin: 0,
      earlyLeaveMin: 0,
      balanceMin: 0,
      breaches: [],
      final: true,
    });
  });

  it('within the per-mark tolerance on both ends and under the daily one: nothing', () => {
    const day = checkDay({
      blocks: [block('08:04', '12:00'), block('13:00', '16:56')],
      policy,
      nowMin: DAY_OVER,
    });
    expect(day.breaches).toEqual([]);
  });

  // with two marks a day, the daily limit only bites when it is below twice the per-mark one
  it('each within the per-mark tolerance but together over the daily one: both reported', () => {
    const day = checkDay({
      blocks: [block('08:04', '12:00'), block('13:00', '16:53')],
      policy: { ...policy, toleranceMarkMin: 8 },
      nowMin: DAY_OVER,
    });
    expect(day.breaches).toEqual(['late', 'early_leave']);
    expect(day.lateMin).toBe(4);
    expect(day.earlyLeaveMin).toBe(7);
  });

  it('late beyond the per-mark tolerance', () => {
    const day = checkDay({
      blocks: [block('08:12', '12:00'), block('13:00', '17:00')],
      policy,
      nowMin: DAY_OVER,
    });
    expect(day.breaches).toEqual(['late']);
    expect(day.lateMin).toBe(12);
    expect(day.balanceMin).toBe(-12);
  });

  it('a break split in two pieces is short, not taken', () => {
    const day = checkDay({
      blocks: [
        block('08:00', '11:30'),
        block('12:10', '12:20'),
        block('12:45', '17:00'),
      ],
      policy,
      nowMin: DAY_OVER,
    });
    expect(day.breakMin).toBe(40);
    expect(day.breakStartMin).toBe(m('11:30'));
    expect(day.breaches).toEqual(['break_short']);
  });

  it('a pause that starts before the window does not count as the break', () => {
    const day = checkDay({
      blocks: [block('08:00', '10:30'), block('11:40', '17:00')],
      policy,
      nowMin: DAY_OVER,
    });
    expect(day.breaches).toEqual(['break_missing']);
  });

  it('worked straight through: no break', () => {
    const day = checkDay({
      blocks: [block('08:00', '17:00')],
      policy,
      nowMin: DAY_OVER,
    });
    expect(day.breaches).toEqual(['break_missing']);
    expect(day.balanceMin).toBe(60);
  });

  it('no activity on a checked day: no-show', () => {
    const day = checkDay({ blocks: [], policy, nowMin: DAY_OVER });
    expect(day.breaches).toEqual(['no_show']);
    expect(day.arrivedMin).toBeNull();
    expect(day.balanceMin).toBe(-480);
  });

  it('arriving early and staying late is a positive balance, not a breach', () => {
    const day = checkDay({
      blocks: [block('07:30', '12:00'), block('13:00', '17:40')],
      policy,
      nowMin: DAY_OVER,
    });
    expect(day.breaches).toEqual([]);
    expect(day.balanceMin).toBe(70);
  });
});

describe('checkDay — while the day is running', () => {
  it('at 10:00, on time so far: nothing to report, not final', () => {
    const day = checkDay({
      blocks: [block('08:00', '10:00')],
      policy,
      nowMin: m('10:00'),
    });
    expect(day.breaches).toEqual([]);
    expect(day.final).toBe(false);
  });

  it('late is reported as soon as the person arrives', () => {
    expect(
      checkDay({
        blocks: [block('08:20', '09:00')],
        policy,
        nowMin: m('09:00'),
      }).breaches,
    ).toEqual(['late']);
  });

  it('nobody yet at 09:00: no no-show until the end time', () => {
    expect(
      checkDay({ blocks: [], policy, nowMin: m('09:00') }).breaches,
    ).toEqual([]);
    expect(
      checkDay({ blocks: [], policy, nowMin: m('17:01') }).breaches,
    ).toEqual(['no_show']);
  });

  it('an ongoing pause inside the window counts toward the break', () => {
    const day = checkDay({
      blocks: [block('08:00', '12:00')],
      policy,
      nowMin: m('12:30'),
    });
    expect(day.breakStartMin).toBe(m('12:00'));
    expect(day.breakMin).toBe(30);
    expect(day.breaches).toEqual([]);
  });

  it('the break is judged once the window plus its length has passed', () => {
    const blocks = [block('08:00', '15:30')];
    expect(checkDay({ blocks, policy, nowMin: m('14:30') }).breaches).toEqual(
      [],
    );
    expect(checkDay({ blocks, policy, nowMin: m('15:00') }).breaches).toEqual([
      'break_missing',
    ]);
  });

  it('early leave only after the end time', () => {
    const blocks = [block('08:00', '12:00'), block('13:00', '16:00')];
    expect(checkDay({ blocks, policy, nowMin: m('16:30') }).breaches).toEqual(
      [],
    );
    expect(checkDay({ blocks, policy, nowMin: m('17:30') }).breaches).toEqual([
      'early_leave',
    ]);
  });
});

describe('monthTotals', () => {
  it('counts breaches by kind and adds the balance', () => {
    const days = [
      checkDay({
        blocks: [block('08:12', '12:00'), block('13:00', '17:00')],
        policy,
        nowMin: DAY_OVER,
      }),
      checkDay({ blocks: [block('08:00', '17:00')], policy, nowMin: DAY_OVER }),
      checkDay({ blocks: [], policy, nowMin: DAY_OVER }),
    ];
    expect(monthTotals(days)).toEqual({
      late: 1,
      earlyLeave: 0,
      breakShort: 0,
      breakMissing: 1,
      noShow: 1,
      balanceMin: -12 + 60 - 480,
    });
  });

  it('the running day stays out of the balance (its row says "in progress")', () => {
    const done = checkDay({
      blocks: [block('08:00', '17:00')],
      policy,
      nowMin: DAY_OVER,
    });
    const running = checkDay({
      blocks: [block('08:20', '10:00')],
      policy,
      nowMin: m('10:00'),
    });
    expect(running.final).toBe(false);
    expect(running.balanceMin).toBeLessThan(0);
    expect(monthTotals([done, running])).toMatchObject({
      late: 1,
      balanceMin: 60,
    });
  });
});
