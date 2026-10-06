import { describe, expect, it } from 'vitest';

import {
  agentPresence,
  decideLiveStatus,
  formatWorkDate,
  HOURS_PER_DAY,
  latestHeartbeat,
  monthStartOf,
  OFFLINE_AFTER_SEC,
  parseWorkDate,
  previousWorkDate,
  rankLaggards,
  spreadIntoHourBuckets,
  type DeviceReport,
  type LiveStatus,
} from '../src/dashboard/dashboard.math';

/** 10 August 2026 in Dhaka — a work day is always a UTC-midnight Date */
const WORK_DATE = new Date(Date.UTC(2026, 7, 10));

/** `HH:MM` on that Dhaka day as a UTC instant (Dhaka = UTC+6, no DST) */
function dhaka(hh: number, mm = 0, ss = 0): Date {
  return new Date(Date.UTC(2026, 7, 10, hh - 6, mm, ss));
}

const NOW = new Date('2026-08-10T09:00:00.000Z');
const secondsAgo = (sec: number): Date => new Date(NOW.getTime() - sec * 1000);

/** A healthy device that just reported `active` in a heartbeat; override anything via `over` */
function device(over: Partial<DeviceReport> = {}): DeviceReport {
  return {
    // Careful: the default is `active`. Most tests are about the heartbeat, not
    // about whether the device was revoked; the revoked-device tests say so.
    status: 'active',
    lastSeenAt: secondsAgo(5),
    lastState: 'active',
    lastStateAt: secondsAgo(5),
    ...over,
  };
}

function statusOf(
  devices: readonly DeviceReport[],
  fallbackState: DeviceReport['lastState'] = null,
): LiveStatus {
  return decideLiveStatus({ devices, fallbackState, now: NOW });
}

describe('decideLiveStatus — card colour', () => {
  it('a fresh heartbeat shows the state the agent reported', () => {
    expect(statusOf([device()])).toBe('active');
    expect(statusOf([device({ lastState: 'idle' })])).toBe('idle');
  });

  it('locked gets no colour of its own — it merges into idle', () => {
    expect(statusOf([device({ lastState: 'locked' })])).toBe('idle');
  });

  /**
   * This describe failed in the field twice, for the same reason: the board
   * tried to answer a question it cannot know the answer to.
   *
   * First attempt was clock-based: `> 600 s` silent -> red. On the evening of
   * 15 August the board showed `Agent down 12 · Offline 0` — all twelve staff,
   * although the office had simply closed.
   *
   * Second attempt was last-word-based: last reported `active` then silent ->
   * red. That broke too: when someone presses Shut down mid-work, shutdown
   * finishes in under a minute, no further heartbeat is sent, and the last
   * word stays `active`. A staff member who went home showed red, the owner
   * assumed the new agent was broken, and a whole release was halted.
   *
   * So the question was dropped. Silent means silent: the board now shows
   * grey, nothing more. "Dead or switched off?" is answered by
   * `AgentDownCheck`, which has the goodbye events, and that answer goes to
   * the alert, not to the card colour.
   */
  describe('a silent agent — always offline', () => {
    it('silent after reporting idle is offline — someone left and shut the PC', () => {
      expect(
        statusOf([device({ lastSeenAt: secondsAgo(120), lastState: 'idle' })]),
      ).toBe('offline');
      expect(
        statusOf([
          device({ lastSeenAt: secondsAgo(3 * 3600), lastState: 'idle' }),
        ]),
      ).toBe('offline');
    });

    it('silent after reporting locked is offline too — left after Win+L', () => {
      expect(
        statusOf([
          device({ lastSeenAt: secondsAgo(3 * 3600), lastState: 'locked' }),
        ]),
      ).toBe('offline');
    });

    /**
     * This is the 17 August mistake. Treating "silent after active" as "stopped
     * mid-work" was a false assumption.
     */
    it('silent after reporting active is offline too — a PC can be shut down mid-work', () => {
      expect(
        statusOf([
          device({ lastSeenAt: secondsAgo(120), lastState: 'active' }),
        ]),
      ).toBe('offline');
    });

    /**
     * An agent that was installed but never started is also grey now. The fact
     * is not lost: the card's `agentPresence` text ("Never checked in") shows
     * it and the alert fires. It is just not conveyed by colour alone, because
     * a colour cannot carry an explanation.
     */
    it('offline even when the last word is unknown', () => {
      expect(
        statusOf([
          device({ lastSeenAt: secondsAgo(3 * 3600), lastState: null }),
        ]),
      ).toBe('offline');
    });

    /**
     * One person with two PCs: the desktop shut down in the morning after
     * reporting `active`, the laptop in the evening after reporting `idle`.
     * The last word is the laptop's, so offline. Going by the oldest one
     * would wrongly show them red every evening.
     */
    it('same with several devices — all silent means offline', () => {
      expect(
        statusOf([
          device({ lastSeenAt: secondsAgo(9 * 3600), lastState: 'active' }),
          device({ lastSeenAt: secondsAgo(2 * 3600), lastState: 'idle' }),
        ]),
      ).toBe('offline');
    });
  });

  it('just above the limit — "more than" means strictly more', () => {
    expect(
      statusOf([device({ lastSeenAt: secondsAgo(OFFLINE_AFTER_SEC) })]),
    ).toBe('active');
    // Past the limit it is offline, whatever the last word was
    expect(
      statusOf([device({ lastSeenAt: secondsAgo(OFFLINE_AFTER_SEC + 1) })]),
    ).toBe('offline');
    expect(
      statusOf([
        device({ lastSeenAt: secondsAgo(OFFLINE_AFTER_SEC), lastState: 'idle' }),
      ]),
    ).toBe('idle');
    expect(
      statusOf([
        device({
          lastSeenAt: secondsAgo(OFFLINE_AFTER_SEC + 1),
          lastState: 'idle',
        }),
      ]),
    ).toBe('offline');
  });

  it('no devices at all is offline — not a red alarm', () => {
    expect(statusOf([])).toBe('offline');
  });

  it('a device exists but never responded — offline', () => {
    expect(
      statusOf([
        device({ lastSeenAt: null, lastState: null, lastStateAt: null }),
      ]),
    ).toBe('offline');
  });

  it('agent alive but nobody reported anything — unknown is not treated as active', () => {
    expect(statusOf([device({ lastState: null, lastStateAt: null })])).toBe(
      'idle',
    );
  });

  it('a device clock running ahead (future time) still counts as fresh', () => {
    expect(
      statusOf([
        device({ lastSeenAt: secondsAgo(-30), lastStateAt: secondsAgo(-30) }),
      ]),
    ).toBe('active');
  });
});

describe('decideLiveStatus — agent report vs segment guess', () => {
  /**
   * The reason for the whole feature. Segments arrive in batches, so the last
   * row can be a few minutes old: the worker has left, the agent said `idle`
   * 5 seconds ago, but the segment still says `active`. Letting the guess win
   * would show non-work time as green, minute after minute.
   */
  it('with a fresh report, the segment guess is ignored', () => {
    expect(statusOf([device({ lastState: 'idle' })], 'active')).toBe('idle');
    expect(statusOf([device({ lastState: 'active' })], 'idle')).toBe('active');
  });

  /**
   * The `last_state` column is new: after the migration every row is null and
   * stays null until a heartbeat arrives. Without the fallback every healthy
   * worker would show grey during that gap, so switching the feature on would
   * itself cause a brief blackout.
   */
  it('when the agent sends no state, it falls back to the old guess', () => {
    const old = device({ lastState: null, lastStateAt: null });

    expect(statusOf([old], 'active')).toBe('active');
    expect(statusOf([old], 'locked')).toBe('idle');
    expect(statusOf([old], null)).toBe('idle');
  });

  /**
   * Without this test the worst bug would survive silently. Just before dying,
   * the agent reported `active`, and that value stays in the column. If expiry
   * were not checked, a switched-off PC's card would stay green forever —
   * worse than showing offline, because it would claim work during non-work
   * time.
   */
  it('a stale report is not trusted — falls back to the segment', () => {
    // The agent is alive (sending segments) but the heartbeat is stuck
    const stuck = device({
      lastSeenAt: secondsAgo(10),
      lastState: 'active',
      lastStateAt: secondsAgo(OFFLINE_AFTER_SEC + 1),
    });

    expect(statusOf([stuck], 'idle')).toBe('idle');
    expect(statusOf([stuck], null)).toBe('idle');
    // Just above the limit the report is still fresh
    expect(
      statusOf(
        [device({ lastStateAt: secondsAgo(OFFLINE_AFTER_SEC) })],
        'idle',
      ),
    ).toBe('active');
  });
});

describe('decideLiveStatus — several devices per person (section 2.1-c)', () => {
  /**
   * Judging per device would show a worker on the laptop as red whenever the
   * desktop was off, and IT would be called out for a problem that does not
   * exist.
   */
  it('one dead device does not matter — the other one\'s fresh heartbeat counts', () => {
    expect(
      statusOf([
        device({
          lastSeenAt: secondsAgo(6 * 3600),
          lastStateAt: null,
          lastState: null,
        }),
        device(),
      ]),
    ).toBe('active');
  });

  /**
   * "Take the most recent report" would break this: both devices send a
   * heartbeat every 30 seconds, so which one is "most recent" is effectively
   * random. The card would flip green/grey on every refresh while the worker
   * kept working without a break.
   */
  it('working on any one PC is active — whatever the order', () => {
    const working = device({
      lastState: 'active',
      lastStateAt: secondsAgo(20),
    });
    const locked = device({ lastState: 'locked', lastStateAt: secondsAgo(2) });

    expect(statusOf([locked, working])).toBe('active');
    expect(statusOf([working, locked])).toBe('active');
  });

  it('if none says active, the most recent report wins', () => {
    expect(
      statusOf([
        device({ lastState: 'locked', lastStateAt: secondsAgo(60) }),
        device({ lastState: 'idle', lastStateAt: secondsAgo(3) }),
      ]),
    ).toBe('idle');
  });

  /** A stale `active` must not override a fresh report from another device */
  it('the old active of a switched-off desktop does not beat the laptop\'s fresh idle', () => {
    expect(
      statusOf([
        device({
          lastSeenAt: secondsAgo(4 * 3600),
          lastState: 'active',
          lastStateAt: secondsAgo(4 * 3600),
        }),
        device({ lastState: 'idle' }),
      ]),
    ).toBe('idle');
  });
});

describe('latestHeartbeat — the card\'s "last seen"', () => {
  it('the most recent across all devices', () => {
    expect(
      latestHeartbeat([
        device({ lastSeenAt: secondsAgo(900) }),
        device({ lastSeenAt: secondsAgo(5) }),
        device({ lastSeenAt: null }),
      ]),
    ).toEqual(secondsAgo(5));
  });

  it('null when none ever responded — not zero or the epoch', () => {
    expect(latestHeartbeat([])).toBeNull();
    expect(latestHeartbeat([device({ lastSeenAt: null })])).toBeNull();
  });
});

describe('spreadIntoHourBuckets — hour buckets', () => {
  it('a segment inside one hour goes entirely into that hour', () => {
    const buckets = spreadIntoHourBuckets(
      [{ startedAt: dhaka(10, 10), endedAt: dhaka(10, 40), durationSec: 1800 }],
      WORK_DATE,
    );

    expect(buckets).toHaveLength(HOURS_PER_DAY);
    expect(buckets[10]).toBe(1800);
    expect(sum(buckets)).toBe(1800);
  });

  /**
   * The main trap of this feature. 10:45-12:15 is 90 minutes. Dropping all of
   * it into the starting hour would make the chart say "90 minutes of work at
   * 10" — an hour-wide slot holding an hour and a half, and nothing in the 11
   * slot. The mistake would go unnoticed because the total would still be
   * right.
   */
  it('a segment spread over three hours is split proportionally', () => {
    const buckets = spreadIntoHourBuckets(
      [{ startedAt: dhaka(10, 45), endedAt: dhaka(12, 15), durationSec: 5400 }],
      WORK_DATE,
    );

    expect(buckets[10]).toBe(15 * 60);
    expect(buckets[11]).toBe(60 * 60);
    expect(buckets[12]).toBe(15 * 60);
    expect(sum(buckets)).toBe(5400);
  });

  it('ending exactly on an hour boundary puts nothing in the next bucket', () => {
    const buckets = spreadIntoHourBuckets(
      [{ startedAt: dhaka(9, 0), endedAt: dhaka(10, 0), durationSec: 3600 }],
      WORK_DATE,
    );

    expect(buckets[9]).toBe(3600);
    expect(buckets[10]).toBe(0);
  });

  /**
   * Rounding each hour separately with Math.round would accumulate 24 rounding
   * errors, so the bucket sum could exceed or fall short of durationSec. The
   * chart total and the timeline total would then differ, with no way to tell
   * which is right.
   */
  it('even when time does not divide evenly, buckets sum to exactly durationSec', () => {
    const buckets = spreadIntoHourBuckets(
      [
        {
          startedAt: dhaka(8, 17, 13),
          endedAt: dhaka(13, 42, 47),
          durationSec: 19_534,
        },
      ],
      WORK_DATE,
    );

    expect(sum(buckets)).toBe(19_534);
    expect(buckets.every((b) => Number.isInteger(b))).toBe(true);
  });

  /**
   * durationSec comes from a monotonic clock while hour boundaries come from
   * the wall clock; it is safest to assume they will not match (sleep or
   * suspend widens the gap). durationSec is what gets split; the proportions
   * come from the wall clock.
   */
  it('when durationSec differs from the wall-clock span, the total is still durationSec', () => {
    const buckets = spreadIntoHourBuckets(
      [{ startedAt: dhaka(10, 0), endedAt: dhaka(12, 0), durationSec: 3600 }],
      WORK_DATE,
    );

    expect(sum(buckets)).toBe(3600);
    expect(buckets[10]).toBe(1800);
    expect(buckets[11]).toBe(1800);
  });

  it('several segments add up in the same bucket', () => {
    const buckets = spreadIntoHourBuckets(
      [
        { startedAt: dhaka(14, 0), endedAt: dhaka(14, 20), durationSec: 1200 },
        { startedAt: dhaka(14, 30), endedAt: dhaka(14, 45), durationSec: 900 },
      ],
      WORK_DATE,
    );

    expect(buckets[14]).toBe(2100);
    expect(sum(buckets)).toBe(2100);
  });

  it('the first and last hours of the day land in the right place', () => {
    const buckets = spreadIntoHourBuckets(
      [
        { startedAt: dhaka(0, 0), endedAt: dhaka(0, 30), durationSec: 1800 },
        { startedAt: dhaka(23, 30), endedAt: dhaka(24, 0), durationSec: 1800 },
      ],
      WORK_DATE,
    );

    expect(buckets[0]).toBe(1800);
    expect(buckets[23]).toBe(1800);
  });

  it('if the wall clock goes backwards, everything lands in the start hour and no time is lost', () => {
    const buckets = spreadIntoHourBuckets(
      [{ startedAt: dhaka(15, 10), endedAt: dhaka(15, 5), durationSec: 300 }],
      WORK_DATE,
    );

    expect(buckets[15]).toBe(300);
    expect(sum(buckets)).toBe(300);
  });

  it('a segment from another day, if it arrives by mistake, enters no bucket', () => {
    const buckets = spreadIntoHourBuckets(
      [
        {
          startedAt: new Date(Date.UTC(2026, 7, 8, 4)),
          endedAt: new Date(Date.UTC(2026, 7, 8, 5)),
          durationSec: 3600,
        },
      ],
      WORK_DATE,
    );

    expect(sum(buckets)).toBe(0);
  });

  it('when durationSec is zero the buckets stay untouched', () => {
    const buckets = spreadIntoHourBuckets(
      [{ startedAt: dhaka(11, 0), endedAt: dhaka(11, 0), durationSec: 0 }],
      WORK_DATE,
    );

    expect(sum(buckets)).toBe(0);
  });
});

describe('dates — parse and format', () => {
  it('a valid date becomes a UTC-midnight Date', () => {
    expect(parseWorkDate('2026-08-10')?.toISOString()).toBe(
      '2026-08-10T00:00:00.000Z',
    );
  });

  /**
   * `new Date('2026-02-31')` silently becomes 3 March. Without validation a
   * user would ask for one date and get another date's data, with no error.
   */
  it('a non-existent date returns null instead of rolling into the next month', () => {
    expect(parseWorkDate('2026-02-31')).toBeNull();
    expect(parseWorkDate('2026-13-01')).toBeNull();
    expect(parseWorkDate('2026-00-10')).toBeNull();
  });

  it('recognises leap years correctly', () => {
    expect(parseWorkDate('2028-02-29')?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
    expect(parseWorkDate('2026-02-29')).toBeNull();
  });

  it('null when the format does not match', () => {
    expect(parseWorkDate('10-08-2026')).toBeNull();
    expect(parseWorkDate('2026-8-10')).toBeNull();
    expect(parseWorkDate('2026-08-10T00:00:00Z')).toBeNull();
    expect(parseWorkDate('')).toBeNull();
  });

  it('format returns the date itself, with no timezone shift', () => {
    expect(formatWorkDate(WORK_DATE)).toBe('2026-08-10');
    expect(formatWorkDate(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01');
  });

  it('month start and previous day', () => {
    expect(formatWorkDate(monthStartOf(WORK_DATE))).toBe('2026-08-01');
    expect(formatWorkDate(previousWorkDate(WORK_DATE))).toBe('2026-08-09');
    // across a month boundary
    const augFirst = new Date(Date.UTC(2026, 7, 1));
    expect(formatWorkDate(previousWorkDate(augFirst))).toBe('2026-07-31');
  });
});

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * The agent's presence — an explanation, not a colour.
 *
 * These tests came from a self-contradicting card: a 16:50 screenshot on top
 * and *"Never checked in"* below. The staff member had been deactivated once,
 * so their device was revoked, and the query filtered out revoked devices —
 * which made "never sat down" and "switched off" look the same.
 */
describe('agentPresence', () => {
  it('never_installed when there are no devices at all', () => {
    expect(agentPresence([])).toBe('never_installed');
  });

  it('installed when there is an active device', () => {
    expect(agentPresence([device()])).toBe('installed');
  });

  /** The key test added to this file */
  it('switched_off when all devices are revoked', () => {
    expect(agentPresence([device({ status: 'revoked' })])).toBe('switched_off');
  });

  /** One active device is enough — desktop off, laptop on */
  it('installed when mixed', () => {
    expect(agentPresence([device({ status: 'revoked' }), device()])).toBe('installed');
  });
});

describe('revoked devices are left out of the calculation', () => {
  /**
   * If a revoked device's old heartbeat counted, a switched-off machine would
   * show the worker as green, although it will never respond again.
   */
  it('a revoked device\'s response does not count', () => {
    expect(latestHeartbeat([device({ status: 'revoked' })])).toBeNull();
  });

  it('when all devices are revoked the card is offline, not agent_down', () => {
    expect(statusOf([device({ status: 'revoked' })])).toBe('offline');
  });

  it('an active device beside a revoked one is the one that counts', () => {
    expect(
      statusOf([device({ status: 'revoked', lastSeenAt: secondsAgo(99_999) }), device()]),
    ).toBe('active');
  });
});
/**
 * Staff with the fewest hours *(30 August 2026)* — the card in the board's
 * right-hand column.
 *
 * The most important claim here is the first test: someone who did not come
 * in at all does not vanish from the list. Sorting by the rows of a sum would
 * leave out exactly that person, who is the whole point of the question.
 */
describe('rankLaggards — fewest hours', () => {
  const names = new Map([
    [1, 'Ayesha'],
    [2, 'Belal'],
    [3, 'Chowdhury'],
  ]);

  it('a worker with zero days worked is also listed, and at the top', () => {
    const worked = new Map([
      [1, { creditedSec: 3600, daysCounted: 1 }],
      [2, { creditedSec: 7200, daysCounted: 2 }],
      // Staff 3 has no row at all — nothing was counted in seven days
    ]);

    const out = rankLaggards(names, worked);

    expect(out.map((r) => r.fullName)).toEqual(['Chowdhury', 'Ayesha', 'Belal']);
    expect(out[0]).toMatchObject({ creditedSec: 0, daysCounted: 0 });
  });

  it('fewer hours first, more hours later', () => {
    const worked = new Map([
      [1, { creditedSec: 9000, daysCounted: 3 }],
      [2, { creditedSec: 1800, daysCounted: 1 }],
      [3, { creditedSec: 5400, daysCounted: 2 }],
    ]);

    expect(rankLaggards(names, worked).map((r) => r.fullName)).toEqual([
      'Belal',
      'Chowdhury',
      'Ayesha',
    ]);
  });

  /**
   * Otherwise the order of several zero-hour people would change on every
   * refresh and the screen would look restless although nothing changed.
   */
  it('equal hours are ordered by name, so the order is stable', () => {
    const worked = new Map<number, { creditedSec: number; daysCounted: number }>();

    expect(rankLaggards(names, worked).map((r) => r.fullName)).toEqual([
      'Ayesha',
      'Belal',
      'Chowdhury',
    ]);
  });

  /**
   * Total, not average — and the decision is pinned here.
   *
   * Sorting by average would put someone who did 7 hours in one day above
   * someone who did 8 hours a day for seven days, although over the week they
   * worked fewer hours. The question was "least work", not "lowest average".
   */
  it('ranks by total hours, not by daily average', () => {
    const worked = new Map([
      [1, { creditedSec: 7 * 3600, daysCounted: 1 }],
      [2, { creditedSec: 8 * 3600, daysCounted: 7 }],
      [3, { creditedSec: 9 * 3600, daysCounted: 4 }],
    ]);

    expect(rankLaggards(names, worked).map((r) => r.fullName)).toEqual([
      'Ayesha',
      'Belal',
      'Chowdhury',
    ]);
  });

  it('honours the limit on how many are shown', () => {
    const many = new Map(
      Array.from({ length: 9 }, (_, i) => [i + 1, `Staff ${i + 1}`] as const),
    );

    expect(rankLaggards(many, new Map())).toHaveLength(5);
    expect(rankLaggards(many, new Map(), 3)).toHaveLength(3);
  });

  it('an empty list when there is nobody', () => {
    expect(rankLaggards(new Map(), new Map())).toEqual([]);
  });
});
