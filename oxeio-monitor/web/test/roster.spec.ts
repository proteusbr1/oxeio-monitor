import { describe, expect, it } from 'vitest';

import type { LiveCard } from '../src/api/dashboard';
import {
  dayDuty,
  taskView,
  meterKind,
  restingStartsAt,
  rosterRows,
} from '../src/pages/live/roster';

/**
 * **Two rules of the roster**: the row order, and which truth the meter tells.
 *
 * Careful: the order test is not a mere formality. "Sort by hours" is a
 * one-line change, and it would turn the page into a daily leaderboard, which
 * this product deliberately does not do. With the rule pinned here, that one
 * line cannot slip in silently.
 */

function card(over: Partial<LiveCard> = {}): LiveCard {
  return {
    employeeId: 1,
    empCode: 'OX-01',
    fullName: 'Rakib Hasan',
    designation: 'Coordinator',
    // The task target: does not apply to someone who does not receive tasks
    receivesTasks: false,
    tasksStarted: 0,
    // "Done" is a separate field: started and finished are not the same
    tasksDone: 0,
    taskTargetPerDay: 25,
    status: 'active',
    todayWorkedSec: 3_600,
    dailyTargetSec: 28_800,
    // By default there is an hours target; the no-target policy has its own tests
    noTarget: false,
    todayIsWorkday: true,
    // G130: by default nobody is on leave; leave claims have their own describe
    onLeaveToday: false,
    monthWorkedSec: 72_000,
    monthTargetSec: 748_800,
    lastHeartbeatAt: '2026-08-18T04:11:00.000Z',
    agentPresence: 'installed',
    ...over,
  };
}

describe('meterKind — zero and unknown are not the same', () => {
  it('work counted → counted', () => {
    expect(meterKind(card({ todayWorkedSec: 3_600 }))).toBe('counted');
  });

  /** Measured and the result is zero: that is a **fact**, not an absence */
  it('agent present, responded, but zero today → zero', () => {
    expect(meterKind(card({ todayWorkedSec: 0 }))).toBe('zero');
  });

  /** Careful: the agent was never installed: calling that "zero work" would be a silent accusation */
  it('agent not installed → unknown, even though the seconds are 0', () => {
    expect(
      meterKind(
        card({
          todayWorkedSec: 0,
          agentPresence: 'never_installed',
          lastHeartbeatAt: null,
        }),
      ),
    ).toBe('unknown');
  });

  it('agent switched off → unknown', () => {
    expect(meterKind(card({ agentPresence: 'switched_off' }))).toBe('unknown');
  });

  it('never responded → unknown', () => {
    expect(meterKind(card({ lastHeartbeatAt: null }))).toBe('unknown');
  });
});

describe('rosterRows — the order is never by hours', () => {
  /** The main guard: someone who works more does not rise to the top */
  it('the server order (empCode) stays intact, whatever the hours', () => {
    const rows = rosterRows([
      card({ employeeId: 1, empCode: 'OX-01', todayWorkedSec: 60 }),
      card({ employeeId: 2, empCode: 'OX-02', todayWorkedSec: 30_000 }),
      card({ employeeId: 3, empCode: 'OX-03', todayWorkedSec: 3_600 }),
    ]);

    expect(rows.map((c) => c.empCode)).toEqual(['OX-01', 'OX-02', 'OX-03']);
  });

  it('those working come first, those not working after', () => {
    const rows = rosterRows([
      card({ employeeId: 1, empCode: 'OX-01', status: 'offline' }),
      card({ employeeId: 2, empCode: 'OX-02', status: 'active' }),
      card({ employeeId: 3, empCode: 'OX-03', status: 'idle' }),
      card({ employeeId: 4, empCode: 'OX-04', status: 'active' }),
    ]);

    expect(rows.map((c) => c.empCode)).toEqual([
      'OX-02',
      'OX-04',
      'OX-01',
      'OX-03',
    ]);
  });

  /** Careful: nobody may be dropped, nobody may appear twice (the lesson of G88) */
  it('everyone exactly once', () => {
    const input = [
      card({ employeeId: 1, status: 'active' }),
      card({ employeeId: 2, status: 'idle' }),
      card({ employeeId: 3, status: 'offline' }),
    ];
    const ids = rosterRows(input).map((c) => c.employeeId).sort();
    expect(ids).toEqual([1, 2, 3]);
  });

  it('an empty list gives an empty result', () => {
    expect(rosterRows([])).toEqual([]);
  });
});

describe('restingStartsAt — where the stragglers band goes', () => {
  it('the position of the first not-working row', () => {
    const rows = rosterRows([
      card({ employeeId: 1, status: 'active' }),
      card({ employeeId: 2, status: 'active' }),
      card({ employeeId: 3, status: 'offline' }),
    ]);
    expect(restingStartsAt(rows)).toBe(2);
  });

  /** Everyone is working: the band is not drawn at all */
  it('-1 when everyone works', () => {
    expect(
      restingStartsAt(rosterRows([card({ status: 'active' })])),
    ).toBe(-1);
  });

  /**
   * Careful: when nobody works, the band falls on the **first row**; the
   *    component then does not draw it (the `restingAt > 0` condition),
   *    otherwise a "Not working" band would sit at the very top of the table
   *    even though the whole list is exactly that.
   */
  it('0 when nobody works', () => {
    const rows = rosterRows([
      card({ employeeId: 1, status: 'offline' }),
      card({ employeeId: 2, status: 'idle' }),
    ]);
    expect(restingStartsAt(rows)).toBe(0);
  });
});

describe('taskView — the tasks of today', () => {
  /**
   * **Only "finished" counts.** A start (a window title with the task number)
   * only says something was opened, which cannot tell the one who does the
   * work from the one who looks at it.
   *
   * This block guards that decision: if someone silently switches to
   * `tasksStarted`, the tests below will break.
   */
  it('a start does not count, only Complete', () => {
    /**
     * Careful: someone who receives tasks with **no target** (0) was chosen on
     * purpose: with a target, `0 / 25` is right (they are under measurement),
     * so it would not be `null`.
     */
    expect(
      taskView(card({ receivesTasks: true, taskTargetPerDay: 0, tasksStarted: 100, tasksDone: 0 })),
    ).toBeNull();

    /** Not one started, but 3 marked finished: the number appears */
    expect(
      taskView(card({ receivesTasks: true, taskTargetPerDay: 0, tasksStarted: 0, tasksDone: 3 })),
    ).toEqual({ done: 3, target: null, met: false });

    /** Careful: someone with a target is shown even at zero: the measure applies */
    expect(
      taskView(card({ receivesTasks: true, tasksStarted: 100, tasksDone: 0 })),
    ).toEqual({ done: 0, target: 25, met: false });
  });

  /**
   * Someone who does not receive tasks may still finish one (the owner or a
   * manager marked it for them, or the switch was turned off later): the
   * number is real, so it shows — with no target.
   */
  it('finished work without a target: the number shows, with no target', () => {
    const view = taskView(card({ receivesTasks: false, tasksDone: 43 }));
    expect(view).toEqual({ done: 43, target: null, met: false });
  });

  /** Careful: nobody without a target is ever green, even at 999 > 25 */
  it('nobody without a target is ever green', () => {
    expect(taskView(card({ receivesTasks: false, tasksDone: 999 }))?.met).toBe(false);
    expect(
      taskView(card({ receivesTasks: true, taskTargetPerDay: 0, tasksDone: 999 }))?.met,
    ).toBe(false);
  });

  it('calculation with the task target', () => {
    expect(taskView(card({ receivesTasks: true, tasksDone: 25 }))).toEqual({
      done: 25,
      target: 25,
      met: true,
    });

    expect(taskView(card({ receivesTasks: true, tasksDone: 24 }))?.met).toBe(false);
  });

  /** Careful: nothing if no work: reading "0" feels like an accusation */
  it('shows nothing when no task was finished and there is no target', () => {
    expect(taskView(card({ receivesTasks: false, tasksDone: 0 }))).toBeNull();
    expect(taskView(card({ receivesTasks: false, tasksStarted: 5 }))).toBeNull();
  });
});

describe('G130 — what is expected today, and why not', () => {
  it('an ordinary working day: there is a target', () => {
    expect(dayDuty(card())).toBe('target');
  });

  /**
   * **This whole describe exists for this one test.**
   *
   * Careful: `todayIsWorkday` is the **office** calendar: Fridays and public
   * holidays. Personal leave is not in it, so the card of someone on leave
   * would show **"0h / 8h" and an empty meter**, looking exactly like a person
   * slacking. Yet the numbers (target, expectation, pace) had excused them
   * long ago; only **the picture did not**.
   */
  it('a working day, but on leave: no target, and the reason is "leave"', () => {
    expect(dayDuty(card({ todayIsWorkday: true, onLeaveToday: true }))).toBe(
      'leave',
    );
  });

  /**
   * Careful: **the order is deliberate.** If someone's leave is written on a
   * Friday, the card should still say "day off": on that day **nobody** has a
   * target, so singling one person out is meaningless, and reading "on leave"
   * someone would think the others are working.
   */
  it('leave written on a Friday: still "day off", not "on leave"', () => {
    expect(dayDuty(card({ todayIsWorkday: false, onLeaveToday: true }))).toBe(
      'off',
    );
  });

  it('public holiday / weekly day off: "off"', () => {
    expect(dayDuty(card({ todayIsWorkday: false }))).toBe('off');
  });

  /**
   * Careful: a target of 0 means nothing to do that day, like a day off. The
   *    condition is there because a prorated employee (joined later in the
   *    month) can have a daily target of 0, and showing "0h / 0h" then is meaningless.
   */
  it('"off" when the target is 0, even if leave is written', () => {
    expect(dayDuty(card({ dailyTargetSec: 0, onLeaveToday: true }))).toBe('off');
  });

  /**
   * **The inequality is the real guard.** On leave and on a weekly day off
   * neither shows a meter, i.e. `hasTarget` treats the two as **the same**.
   * Yet `dayDuty` keeps them apart, because the on-screen text differs. Merged,
   * a person on leave would see the card say "day off", i.e. the whole office
   * is closed: a new lie while fixing one.
   */
  it('leave and weekly day off: neither has a meter, yet the two messages differ', () => {
    const onLeave = dayDuty(card({ onLeaveToday: true }));
    const dayOff = dayDuty(card({ todayIsWorkday: false }));

    expect(onLeave).not.toBe('target');
    expect(dayOff).not.toBe('target');
    expect(onLeave).not.toBe(dayOff);
  });

  /**
   * Careful: the server sends a target of 0 for people whose policy has no hours
   * target. That 0 must not read as "day off": the screens show their hours
   * plainly instead.
   */
  describe('no hours target (freelancers)', () => {
    const none = { noTarget: true, dailyTargetSec: 0, monthTargetSec: 0 };

    it('a workday with no target is "none", not "off"', () => {
      expect(dayDuty(card(none))).toBe('none');
    });

    it('a real day off still wins: weekly off day or holiday', () => {
      expect(dayDuty(card({ ...none, todayIsWorkday: false }))).toBe('off');
    });

    it('approved leave still shows as leave', () => {
      expect(dayDuty(card({ ...none, onLeaveToday: true }))).toBe('leave');
    });

    it('leave on a day off stays "off", as for everyone else', () => {
      expect(
        dayDuty(card({ ...none, todayIsWorkday: false, onLeaveToday: true })),
      ).toBe('off');
    });
  });
});
