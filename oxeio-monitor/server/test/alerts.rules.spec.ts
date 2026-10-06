import { describe, expect, it } from 'vitest';

import {
  AGENT_SILENCE_MIN,
  DISK_CRITICAL_PCT,
  DISK_WARN_PCT,
  THROTTLE_HOURS,
} from '../src/alerts/alerts.constants';
import {
  agentDownCandidates,
  dedupeKey,
  workHourOf,
  workIsoWeekday,
  diskUsedPct,
  diskVerdict,
  humanBytes,
  isExpectedSilence,
  isAgentWatchOpen,
  isNoActivityWindow,
  isOfficeOpen,
  isTamperStop,
  isThrottled,
  isThrottledFor,
  alertFloor,
  DAY_SCOPED_TYPES,
  isWithinStartupGrace,
  nextAllowedAt,
  recoveredAlertIds,
  shouldFlagNoActivity,
  silentMinutes,
  suppressFlood,
  tamperSeverity,
  throttleFloor,
  type AlertKey,
  type DeviceSilence,
  type NoActivityInput,
  type OpenAgentDownAlert,
  type StopEvent,
} from '../src/alerts/alerts.rules';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Builds a specific instant in the test work zone: UTC+6, no DST */
function work(iso: string): Date {
  return new Date(`${iso}+06:00`);
}

// ════════════════════════════════════════════════════════════════════════════
// Flood prevention: this block is the most important
// ════════════════════════════════════════════════════════════════════════════

describe('throttle: one per device per cause in 6 hours', () => {
  const now = new Date('2026-08-11T10:00:00Z');

  it('a different device gives a different key, and so does a different type', () => {
    expect(dedupeKey({ type: 'agent_down', deviceId: 1 })).not.toBe(
      dedupeKey({ type: 'agent_down', deviceId: 2 }),
    );
    expect(dedupeKey({ type: 'agent_down', deviceId: 1 })).not.toBe(
      dedupeKey({ type: 'agent_killed', deviceId: 1 }),
    );
  });

  it('deviceId null and deviceId absent give the same key', () => {
    expect(dedupeKey({ type: 'disk_warning', deviceId: null })).toBe(
      dedupeKey({ type: 'disk_warning' }),
    );
  });

  it('one from 5 hours 59 minutes ago still blocks, one from 6 hours 1 minute ago does not', () => {
    const almost = new Date(now.getTime() - (THROTTLE_HOURS * HOUR - MIN));
    const past = new Date(now.getTime() - (THROTTLE_HOURS * HOUR + MIN));

    expect(isThrottled(almost, now)).toBe(true);
    expect(isThrottled(past, now)).toBe(false);
  });

  it('nothing blocks when there was nothing before', () => {
    expect(isThrottled(null, now)).toBe(false);
    expect(isThrottled(undefined, now)).toBe(false);
  });

  /**
   * If the server clock goes backwards, `lastRaisedAt` ends up in the future.
   * Then the mistake should lean towards staying quiet; otherwise an alert
   * would fire on every tick until the clock is fixed.
   */
  it('stays quiet even with a future time', () => {
    expect(isThrottled(new Date(now.getTime() + HOUR), now)).toBe(true);
  });

  it('throttleFloor and nextAllowedAt sit exactly 6 hours either side', () => {
    expect(now.getTime() - throttleFloor(now).getTime()).toBe(
      THROTTLE_HOURS * HOUR,
    );
    expect(nextAllowedAt(now).getTime() - now.getTime()).toBe(
      THROTTLE_HOURS * HOUR,
    );
  });
});

/**
 * Day-scoped alerts: one per day (G166).
 *
 * The bug this block guards: `device_overlap` and `synthetic_input` both
 * speak about the whole work day, both run every hour, and both re-read the
 * whole day's segments each time. Once the condition is true it stays true
 * on every later tick that day, yet the throttle window is only 6 hours and
 * the key has no day in it. Result: 3-4 identical alerts a day for one
 * event, each a separate email.
 *
 * Field evidence on `agent_down`, which runs the same way: on 22 August,
 * each of 13 (device, employee) pairs got exactly 4, six hours apart.
 */
describe('G166: day-scoped alerts fire only once a day', () => {
  /** 2 pm in the work zone (UTC+6) = 08:00 UTC */
  const noon = new Date('2026-09-07T08:00:00Z');
  /** Start of that work-zone day = 18:00 UTC the day before */
  const dayStart = new Date('2026-09-06T18:00:00Z');

  it('the types are exactly these two', () => {
    expect([...DAY_SCOPED_TYPES].sort()).toEqual([
      'device_overlap',
      'synthetic_input',
    ]);
  });

  /**
   * This guards the mistake made most often in this project. `workDateOf()`
   * is a label, i.e. UTC midnight. Treating it as an instant would put the
   * boundary at 06:00 work-zone time, and a repeat of an alert raised between
   * midnight and 06:00 would slip out just as before.
   */
  it('the floor is work-zone midnight, not 06:00', () => {
    expect(alertFloor('device_overlap', noon).toISOString()).toBe(
      dayStart.toISOString(),
    );
  });

  it('an alert from 19 hours ago still blocks if it is the same day', () => {
    // 01:00 in the work zone: far outside the 6-hour window, yet the same day
    const earlier = new Date('2026-09-06T19:00:00Z');

    expect(isThrottled(earlier, noon)).toBe(false);
    expect(isThrottledFor('device_overlap', earlier, noon)).toBe(true);
    expect(isThrottledFor('synthetic_input', earlier, noon)).toBe(true);
  });

  /** Not silent forever: a new work day means a new event */
  it('yesterday\'s alert does not block today\'s', () => {
    // Last night at 11 pm in the work zone
    const lastNight = new Date('2026-09-06T17:00:00Z');

    expect(isThrottledFor('device_overlap', lastNight, noon)).toBe(false);
  });

  /**
   * Right after midnight the window does not shrink. The day start is then
   * only a few minutes back, so using it alone would let a repeat of an
   * 11:59 pm alert slip out at 12:01. The floor is always the earlier of the
   * two.
   */
  it('the 6-hour window survives right after midnight', () => {
    // 00:10 in the work zone
    const justAfter = new Date('2026-09-06T18:10:00Z');
    // 23:50 the night before in the work zone
    const justBefore = new Date('2026-09-06T17:50:00Z');

    expect(alertFloor('device_overlap', justAfter).getTime()).toBe(
      throttleFloor(justAfter).getTime(),
    );
    expect(isThrottledFor('device_overlap', justBefore, justAfter)).toBe(true);
  });

  /**
   * `agent_down` is deliberately left out. It does not speak about the day;
   * it says "this PC is silent right now". A reminder every day for a PC
   * that is off for three days is what is wanted. Here noise is better than
   * silence.
   */
  it('the agent_down window is 6 hours as before', () => {
    const earlier = new Date('2026-09-06T19:00:00Z');

    expect(alertFloor('agent_down', noon).getTime()).toBe(
      throttleFloor(noon).getTime(),
    );
    expect(isThrottledFor('agent_down', earlier, noon)).toBe(false);
  });
});

describe('suppressFlood: filtering one round\'s candidates', () => {
  const now = new Date('2026-08-11T10:00:00Z');

  const candidate = (deviceId: number): AlertKey => ({
    type: 'agent_down',
    deviceId,
  });

  it('if the DB has a fresh alert, that device\'s is dropped', () => {
    const last = new Map([
      [dedupeKey(candidate(1)), new Date(now.getTime() - HOUR)],
    ]);

    const kept = suppressFlood([candidate(1), candidate(2)], last, now);

    expect(kept.map((k) => k.deviceId)).toEqual([2]);
  });

  /**
   * The most important test. If three agent_stop events for the same PC
   * fall in a 15-minute window, nothing is in the DB yet, so the DB-based
   * throttle would let all three through, and three alerts would be written
   * in the same second.
   */
  it('the same key coming repeatedly within one round leaves only one', () => {
    const kept = suppressFlood(
      [candidate(7), candidate(7), candidate(7)],
      new Map(),
      now,
    );

    expect(kept).toHaveLength(1);
  });

  it('an empty list gives an empty result', () => {
    expect(suppressFlood([], new Map(), now)).toEqual([]);
  });

  it('one employee\'s two devices are counted separately', () => {
    const kept = suppressFlood(
      [
        { type: 'agent_down', deviceId: 1, employeeId: 3 },
        { type: 'agent_down', deviceId: 2, employeeId: 3 },
      ],
      new Map(),
      now,
    );

    expect(kept).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// work-zone time
// ════════════════════════════════════════════════════════════════════════════

describe('work-zone time', () => {
  it('local hour, not UTC', () => {
    // 20:30 in the work zone (UTC+6) = 14:30 UTC
    expect(workHourOf(new Date('2026-08-11T14:30:00Z'))).toBe(20);
  });

  it('the hour right after midnight is 0', () => {
    expect(workHourOf(work('2026-08-11T00:05:00'))).toBe(0);
  });

  /**
   * 2026-08-11 is a Tuesday, ISO 2. In `weekly_off_day` Friday = 5, but
   * `getUTCDay()` also says 5 for Friday yet 0 for Sunday: the mistake would
   * show only on Sunday, so both are checked.
   */
  it('ISO day: Monday 1 ... Sunday 7', () => {
    expect(workIsoWeekday(work('2026-08-11T12:00:00'))).toBe(2); // Tuesday
    expect(workIsoWeekday(work('2026-08-14T12:00:00'))).toBe(5); // Friday
    expect(workIsoWeekday(work('2026-08-16T12:00:00'))).toBe(7); // Sunday
  });

  it('the work-zone day is counted even when UTC is on the previous day', () => {
    // 05:00 Friday in the work zone = 23:00 Thursday in UTC
    expect(workIsoWeekday(new Date('2026-08-13T23:00:00Z'))).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G01: agent silent
// ════════════════════════════════════════════════════════════════════════════

/**
 * Whether the office is open: when `agent_down` stays quiet (22 August 2026).
 *
 * 2026-08-24 is a Monday (ISO 1), 2026-08-28 a Friday (ISO 5).
 */
describe('agent_down is quiet outside office hours', () => {
  const OFFICE = { officeFrom: '09:00', officeTo: '18:00' };
  const open = (iso: string, extra = {}) =>
    isOfficeOpen({
      now: work(iso),
      ...OFFICE,
      weeklyOffDays: [5],
      isHoliday: false,
      ...extra,
    });

  it('open during office hours', () => {
    expect(open('2026-08-24T09:00:00')).toBe(true);
    expect(open('2026-08-24T13:30:00')).toBe(true);
    expect(open('2026-08-24T17:59:00')).toBe(true);
  });

  /** Exactly 6 pm is closed: the window is `[from, to)`, or an alert would leak at 18:00 */
  it('closed at the exact last moment', () => {
    expect(open('2026-08-24T18:00:00')).toBe(false);
  });

  it('closed before 9 am and after the evening', () => {
    expect(open('2026-08-24T08:59:00')).toBe(false);
    expect(open('2026-08-24T18:01:00')).toBe(false);
    expect(open('2026-08-24T23:30:00')).toBe(false);
    expect(open('2026-08-24T03:00:00')).toBe(false);
  });

  /** The three clusters measured in the field (18:00, 00:00, 06:00) are all closed */
  it('the three clusters measured in the field are now quiet', () => {
    expect(open('2026-08-24T18:00:00')).toBe(false);
    expect(open('2026-08-25T00:00:00')).toBe(false);
    expect(open('2026-08-25T06:00:00')).toBe(false);
  });

  it('closed all day on the weekly day off', () => {
    expect(open('2026-08-28T11:00:00')).toBe(false);
  });

  it('closed on a calendar holiday too', () => {
    expect(open('2026-08-24T11:00:00', { isHoliday: true })).toBe(false);
  });

  /**
   * These three all say the same thing: when the time is unknown, treat it
   * as open. Both directions of error are bad, but not equally: extra alerts
   * are annoying, a watch that silently turns off is dangerous.
   */
  it('open all day when no time is set', () => {
    expect(open('2026-08-24T23:00:00', { officeFrom: null, officeTo: null }))
      .toBe(true);
    expect(open('2026-08-24T23:00:00', { officeFrom: '09:00', officeTo: null }))
      .toBe(true);
  });

  it('a badly written time is treated as open too', () => {
    expect(open('2026-08-24T23:00:00', { officeFrom: '9am', officeTo: '6pm' }))
      .toBe(true);
    expect(open('2026-08-24T23:00:00', { officeFrom: '25:00', officeTo: '18:00' }))
      .toBe(true);
  });

  /** An inverted window (end <= start) is open, not closed */
  it('an inverted window is treated as open', () => {
    expect(open('2026-08-24T03:00:00', { officeFrom: '18:00', officeTo: '09:00' }))
      .toBe(true);
    expect(open('2026-08-24T03:00:00', { officeFrom: '09:00', officeTo: '09:00' }))
      .toBe(true);
  });

  /** With no weekly day off (null), Friday is a working day too */
  it('with the weekly day off null, Friday is open too', () => {
    expect(open('2026-08-28T11:00:00', { weeklyOffDays: [] })).toBe(true);
  });
});

/**
 * A 15-minute grace after the office opens (23 August 2026).
 *
 * Measured in the field: today everyone started work between 08:48 and
 * 09:03, yet at exactly 9:00 six alerts were raised, and all six came back
 * by 9:09. Not one was real.
 */
describe('grace after opening: the time when everyone is present', () => {
  const OFFICE = { officeFrom: '09:00', officeTo: '18:00' };
  const watch = (iso: string, extra = {}) =>
    isAgentWatchOpen({
      now: work(iso),
      ...OFFICE,
      weeklyOffDays: [5],
      isHoliday: false,
      ...extra,
    });

  /** Exactly 9:00: the office is open, but nobody is expected to be present yet */
  it('at 9:00 the office is open, yet the watch does not start', () => {
    expect(isOfficeOpen({ now: work('2026-08-24T09:00:00'), ...OFFICE,
      weeklyOffDays: [5], isHoliday: false })).toBe(true);
    expect(watch('2026-08-24T09:00:00')).toBe(false);
  });

  it('not even after 14 minutes, yes at 15 minutes', () => {
    expect(watch('2026-08-24T09:14:00')).toBe(false);
    expect(watch('2026-08-24T09:15:00')).toBe(true);
  });

  /**
   * The grace is only at the start, not at the end: a PC suddenly switching
   * off in the afternoon is real news, and should not be suppressed before
   * closing time.
   */
  it('the afternoon watch is at full strength, up to the last moment', () => {
    expect(watch('2026-08-24T13:00:00')).toBe(true);
    expect(watch('2026-08-24T17:59:00')).toBe(true);
    expect(watch('2026-08-24T18:00:00')).toBe(false);
  });

  it('when the office is closed, the question of grace does not arise', () => {
    expect(watch('2026-08-24T22:00:00')).toBe(false);
    expect(watch('2026-08-28T10:00:00')).toBe(false); // Friday
    expect(watch('2026-08-24T10:00:00', { isHoliday: true })).toBe(false);
  });

  /** With no time set there is no "after opening" moment, so no grace either */
  it('with no office hours, the watch is all day', () => {
    expect(watch('2026-08-24T03:00:00', { officeFrom: null, officeTo: null }))
      .toBe(true);
  });

  /** The grace can be changed: giving 0 in a test makes behaviour equal to `isOfficeOpen` */
  it('with grace 0, the watch starts the moment the office opens', () => {
    expect(
      isAgentWatchOpen(
        { now: work('2026-08-24T09:00:00'), ...OFFICE, weeklyOffDays: [5], isHoliday: false },
        0,
      ),
    ).toBe(true);
  });
});

describe('G01: whether the silence has an explanation', () => {
  const now = new Date('2026-08-11T14:00:00Z');
  const silentSince = new Date(now.getTime() - 30 * MIN);

  const device = (over: Partial<DeviceSilence> = {}): DeviceSilence => ({
    deviceId: 1,
    lastSeenAt: silentSince,
    lastCleanStopAt: null,
    ...over,
  });

  it('30 minutes of silence with no goodbye event = an alert', () => {
    expect(agentDownCandidates([device()], now)).toHaveLength(1);
  });

  /**
   * Without this, every evening the moment everyone's PC shut down, twelve
   * alerts would go out: the check would always be telling the truth and
   * still be useless.
   */
  it('if the last news is a logoff, the silence is normal', () => {
    const d = device({ lastCleanStopAt: silentSince });
    expect(isExpectedSilence(d)).toBe(true);
    expect(agentDownCandidates([d], now)).toHaveLength(0);
  });

  it('an alert is raised if the agent returns after a logoff and goes silent again', () => {
    // Logoff at noon, data again in the afternoon, then silence
    const d = device({
      lastCleanStopAt: new Date(now.getTime() - 5 * HOUR),
      lastSeenAt: silentSince,
    });
    expect(isExpectedSilence(d)).toBe(false);
    expect(agentDownCandidates([d], now)).toHaveLength(1);
  });

  it('nothing happens with less than 10 minutes of silence', () => {
    const d = device({ lastSeenAt: new Date(now.getTime() - 9 * MIN) });
    expect(agentDownCandidates([d], now)).toHaveLength(0);
  });

  /**
   * A device that never sent anything is an enrollment problem, not "agent
   * down". Alerting would make every device never installed complain forever.
   */
  it('a device with no lastSeenAt is left out', () => {
    expect(agentDownCandidates([device({ lastSeenAt: null })], now)).toEqual([]);
  });

  it('silentMinutes counts minutes, and null if there is no lastSeenAt', () => {
    expect(silentMinutes(silentSince, now)).toBe(30);
    expect(silentMinutes(null, now)).toBeNull();
  });

  it('right after the server boots the check is not done at all', () => {
    const booted = new Date(now.getTime() - 5 * MIN);
    expect(isWithinStartupGrace(booted, now)).toBe(true);
    expect(
      isWithinStartupGrace(new Date(now.getTime() - 20 * MIN), now),
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G01 (return): when it comes back, the alert closes itself
// ════════════════════════════════════════════════════════════════════════════

describe('recoveredAlertIds: an open alert of a returned agent can be closed', () => {
  const now = new Date('2026-08-11T14:00:00Z');
  const cameBack = new Date(now.getTime() - 2 * MIN); // under 10 minutes: it came back
  const stillSilent = new Date(now.getTime() - 30 * MIN);

  const open = (
    over: Partial<OpenAgentDownAlert> = {},
  ): OpenAgentDownAlert => ({
    alertId: 1n,
    deviceActive: true,
    lastSeenAt: cameBack,
    ...over,
  });

  it('the alert of an active device talking again can be closed', () => {
    expect(recoveredAlertIds([open()], now)).toEqual([1n]);
  });

  /** The exact mirror of agentDownCandidates(): not closed while still silent */
  it('is not closed while still silent', () => {
    expect(recoveredAlertIds([open({ lastSeenAt: stillSilent })], now)).toEqual(
      [],
    );
  });

  /** A revoked device is meant to be silent: not closed even if recent */
  it('a revoked device is left out', () => {
    expect(recoveredAlertIds([open({ deviceActive: false })], now)).toEqual([]);
  });

  it('nothing without lastSeenAt is closed', () => {
    expect(recoveredAlertIds([open({ lastSeenAt: null })], now)).toEqual([]);
  });

  /** The boundary is exactly at the silence floor: raise and resolve must not hit the same line */
  it('even exactly at the silence floor it counts as returned', () => {
    const atFloor = new Date(now.getTime() - AGENT_SILENCE_MIN * MIN);
    expect(recoveredAlertIds([open({ lastSeenAt: atFloor })], now)).toEqual([
      1n,
    ]);
  });

  it('in a mixed list only the ids of those that came back are returned', () => {
    const ids = recoveredAlertIds(
      [
        open({ alertId: 10n, lastSeenAt: cameBack }),
        open({ alertId: 11n, lastSeenAt: stillSilent }),
        open({ alertId: 12n, deviceActive: false }),
        open({ alertId: 13n, lastSeenAt: cameBack }),
      ],
      now,
    );
    expect(ids).toEqual([10n, 13n]);
  });

  it('an empty list gives an empty result', () => {
    expect(recoveredAlertIds([], now)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G02: tampering
// ════════════════════════════════════════════════════════════════════════════

describe('G02: whether agent_stop is normal or tampering', () => {
  const at = new Date('2026-08-11T12:00:00Z');

  const stop = (over: Partial<StopEvent> = {}): StopEvent => ({
    deviceId: 1,
    type: 'agent_stop',
    occurredAt: at,
    ...over,
  });

  it('normal when a logoff is alongside', () => {
    const context = [
      stop({ type: 'logoff', occurredAt: new Date(at.getTime() + 30_000) }),
    ];
    expect(isTamperStop(stop(), context)).toBe(false);
  });

  it('tampering when nothing is nearby', () => {
    expect(isTamperStop(stop(), [])).toBe(true);
  });

  /** Another PC's shutdown cannot explain this PC's agent_stop */
  it('another device\'s shutdown gives no exemption', () => {
    const context = [stop({ deviceId: 2, type: 'shutdown' })];
    expect(isTamperStop(stop(), context)).toBe(true);
  });

  it('a shutdown 10 minutes earlier is outside the window', () => {
    const context = [
      stop({ type: 'shutdown', occurredAt: new Date(at.getTime() - 10 * MIN) }),
    ];
    expect(isTamperStop(stop(), context)).toBe(true);
  });

  it('uninstall is never normal, even with a shutdown alongside', () => {
    const context = [stop({ type: 'shutdown' })];
    expect(isTamperStop(stop({ type: 'uninstall' }), context)).toBe(true);
    expect(isTamperStop(stop({ type: 'agent_uninstall' }), context)).toBe(true);
  });

  it('uninstall is critical, merely stopping is a warning', () => {
    expect(tamperSeverity('uninstall')).toBe('critical');
    expect(tamperSeverity('agent_stop')).toBe('warning');
  });

  /**
   * The agent installing its own update is also a normal stop (5 September 2026).
   *
   * Careful: until now this was a silent false alert. During an MSI update,
   * Windows' Restart Manager makes the agent close (`ENDSESSION_CLOSEAPP`).
   * The `agent_stop` did go out, but with no `logoff`/`shutdown` alongside,
   * because the PC was not shutting down. So every update raised an
   * `agent_killed` warning, i.e. whoever installed an update was marked as
   * tampering.
   *
   * Updating one or two PCs by hand, nobody noticed. But once the rollout
   * began to advance by itself, 12 false alerts came at once, and after that
   * nobody read alerts, so G02 would have become useless in practice.
   */
  it('normal when agent_update is alongside: an update is not tampering', () => {
    const context = [
      stop({ type: 'agent_update', occurredAt: new Date(at.getTime() + 5_000) }),
    ];
    expect(isTamperStop(stop(), context)).toBe(false);
  });

  /**
   * Careful: the exemption is narrow, and that is the design. `agent_update`
   * is sent only when Windows itself makes us close. If someone kills the
   * process from Task Manager it is not sent, so real tampering is caught as
   * before.
   *
   * This test shows how much the exemption covers: one name was added, and
   * the guard was not loosened.
   */
  it('a stop without an update is still tampering', () => {
    expect(isTamperStop(stop(), [])).toBe(true);
  });

  /** Another PC's update does not explain this PC's agent_stop */
  it('another device\'s agent_update gives no exemption', () => {
    const context = [stop({ deviceId: 2, type: 'agent_update' })];
    expect(isTamperStop(stop(), context)).toBe(true);
  });

  /** Uninstall has no exemption, even with an update alongside */
  it('uninstall next to an update is still tampering', () => {
    const context = [stop({ type: 'agent_update' })];
    expect(isTamperStop(stop({ type: 'agent_uninstall' }), context)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G03: disk
// ════════════════════════════════════════════════════════════════════════════

describe('G03: disk percentage and level', () => {
  /**
   * The denominator is `used + bavail`, not total blocks. Of 1000 blocks, 50
   * are reserved for root, 800 used, 150 free for ordinary users: `df` says
   * 84.2%, while dividing by the total gives 80%. Going with the second, our
   * figure would not pass 95% even after the disk was really full.
   */
  it('calculates leaving out the blocks reserved for root', () => {
    const pct = diskUsedPct({ blocks: 1000, bfree: 200, bavail: 150, bsize: 4096 });
    expect(pct).toBeCloseTo(84.2, 1);

    const naive = ((1000 - 200) / 1000) * 100;
    expect(naive).toBe(80); // what it would have been
  });

  it('completely empty and completely full', () => {
    expect(diskUsedPct({ blocks: 100, bfree: 100, bavail: 100, bsize: 512 })).toBe(0);
    expect(diskUsedPct({ blocks: 100, bfree: 0, bavail: 0, bsize: 512 })).toBe(100);
  });

  it('dividing by a zero-size volume does not give NaN', () => {
    expect(diskUsedPct({ blocks: 0, bfree: 0, bavail: 0, bsize: 4096 })).toBe(0);
  });

  it('level boundaries: exactly 80 and exactly 95 are caught', () => {
    expect(diskVerdict(DISK_WARN_PCT - 0.1)).toBeNull();
    expect(diskVerdict(DISK_WARN_PCT)?.type).toBe('disk_warning');
    expect(diskVerdict(94.9)?.type).toBe('disk_warning');
    expect(diskVerdict(DISK_CRITICAL_PCT)?.type).toBe('disk_critical');
    expect(diskVerdict(99.9)?.severity).toBe('critical');
  });

  /**
   * Because 80% and 95% have different types, their throttle keys differ, so
   * the serious news is not suppressed for 6 hours in the shadow of the
   * earlier warning.
   */
  it('warning and critical get different throttle keys', () => {
    expect(dedupeKey({ type: 'disk_warning' })).not.toBe(
      dedupeKey({ type: 'disk_critical' }),
    );
  });

  it('bytes come out human-readable', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(1024)).toBe('1.0 KB');
    expect(humanBytes(1024 ** 3 * 1.5)).toBe('1.5 GB');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G06: no activity all day
// ════════════════════════════════════════════════════════════════════════════

describe('G06: when "nobody worked today" is declared', () => {
  /**
   * No alert on an approved leave day (6 September 2026, G157).
   *
   * The note at the top of this file used to say "there is no leave system
   * in this system", and that had been stale for a month. The leave register
   * arrived in R2/G130, but no alert test ever read the `leaves` table.
   *
   * Measured in the field: on just 3 leave days, 11 false alerts.
   */
  it('no alert on an approved leave day', () => {
    expect(shouldFlagNoActivity(input({ onLeave: true }))).toBe(false);
  });

  /**
   * The second test is the real guard: on its own, the first could stay green
   * even by always returning `false`.
   */
  it('without leave the alert is raised as before', () => {
    expect(shouldFlagNoActivity(input({ onLeave: false }))).toBe(true);
  });

  const evening = work('2026-08-11T19:00:00'); // Tuesday 7 pm

  const input = (over: Partial<NoActivityInput> = {}): NoActivityInput => ({
    workedSegments: 0,
    weeklyOffDays: [5],
    isHoliday: false,
    onLeave: false,
    joinedOn: null,
    leftOn: null,
    now: evening,
    ...over,
  });

  it('evening, working day, no work: an alert', () => {
    expect(shouldFlagNoActivity(input())).toBe(true);
  });

  it('no alert even with a single segment', () => {
    expect(shouldFlagNoActivity(input({ workedSegments: 1 }))).toBe(false);
  });

  /**
   * Without excluding the weekly day off, there would be twelve false alerts
   * on every weekly off day (Friday in this fixture), four times a month. That habit is how people stop reading
   * alerts.
   */
  it('quiet on the weekly day off', () => {
    const friday = work('2026-08-14T19:00:00');
    expect(shouldFlagNoActivity(input({ now: friday }))).toBe(false);
  });

  it('an alert on Friday too if the policy has no weekly day off', () => {
    const friday = work('2026-08-14T19:00:00');
    expect(
      shouldFlagNoActivity(input({ now: friday, weeklyOffDays: [] })),
    ).toBe(true);
  });

  it('quiet on a calendar holiday', () => {
    expect(shouldFlagNoActivity(input({ isHoliday: true }))).toBe(false);
  });

  /**
   * Without the window, right after midnight everyone would be found "not
   * working" in the new day's count, i.e. twelve alerts every night.
   */
  it('in the morning or at midnight the question is not even asked', () => {
    expect(shouldFlagNoActivity(input({ now: work('2026-08-11T09:00:00') }))).toBe(false);
    expect(shouldFlagNoActivity(input({ now: work('2026-08-11T00:30:00') }))).toBe(false);
    expect(shouldFlagNoActivity(input({ now: work('2026-08-11T22:30:00') }))).toBe(false);
  });

  it('window boundaries: 18:00 inside, 22:00 outside', () => {
    expect(isNoActivityWindow(work('2026-08-11T18:00:00'))).toBe(true);
    expect(isNoActivityWindow(work('2026-08-11T21:59:00'))).toBe(true);
    expect(isNoActivityWindow(work('2026-08-11T22:00:00'))).toBe(false);
  });

  /**
   * The window (4 hours) is shorter than the throttle (6 hours), so more than
   * one alert a day for one person is mathematically impossible.
   */
  it('the window is shorter than the throttle window', () => {
    const windowHours = 22 - 18;
    expect(windowHours).toBeLessThan(THROTTLE_HOURS);
  });

  it('no alert for an employee who joins tomorrow', () => {
    expect(
      shouldFlagNoActivity(input({ joinedOn: new Date('2026-08-20T00:00:00Z') })),
    ).toBe(false);
  });

  it('no alert for an employee who left yesterday, but there is on the last day', () => {
    expect(
      shouldFlagNoActivity(input({ leftOn: new Date('2026-08-10T00:00:00Z') })),
    ).toBe(false);
    expect(
      shouldFlagNoActivity(input({ leftOn: new Date('2026-08-11T00:00:00Z') })),
    ).toBe(true);
  });
});
