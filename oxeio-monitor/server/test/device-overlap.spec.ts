import { describe, expect, it } from 'vitest';

import { OVERLAP_ALERT_SEC } from '../src/alerts/alerts.constants';
import { shouldFlagOverlap } from '../src/alerts/alerts.rules';
import { overlapSec, type DeviceSpans } from '../src/summary/summary.math';

/**
 * **G32** — two devices of the same staff member at the same time.
 *
 * This alert is raised against a person, not a device, so a wrong
 * calculation costs the most here. A false `device_overlap` questions
 * someone's honesty about their work, when they may have used a single
 * machine all day.
 */

const at = (hh: number, mm = 0): Date =>
  new Date(Date.UTC(2026, 7, 12, hh - 6, mm)); // Dhaka -> UTC

const span = (fromH: number, toH: number) => ({
  startedAt: at(fromH),
  endedAt: at(toH),
});

const device = (deviceId: number, ...spans: Array<{ startedAt: Date; endedAt: Date }>):
  DeviceSpans => ({ deviceId, spans });

describe('overlapSec — how many seconds two machines ran together', () => {
  it('zero when there is one device', () =>
    expect(overlapSec([device(1, span(9, 17))])).toBe(0));

  it('zero when there is nothing', () => expect(overlapSec([])).toBe(0));

  /**
   * Guards a mistake that nearly happened. Two devices, but their times do
   * not coincide — desktop in the morning, laptop in the afternoon. The wrong
   * calculation (`active_sec - worked_sec`) could produce a gap here too.
   */
  it('two devices but at different times — zero', () =>
    expect(overlapSec([device(1, span(9, 13)), device(2, span(14, 18))])).toBe(0));

  it('two hours together gives two hours', () =>
    expect(overlapSec([device(1, span(9, 13)), device(2, span(11, 15))])).toBe(
      2 * 3600,
    ));

  it('one device\'s time entirely inside another\'s', () =>
    expect(overlapSec([device(1, span(9, 18)), device(2, span(11, 12))])).toBe(3600));

  /**
   * Two touching segments of the same machine (retry, session reopened) must
   * not be counted as overlap — so each device's own UNION is taken, not the
   * raw sum. A raw sum would give 1 hour here, yet there is only one machine.
   */
  it('touching segments of the same machine are not overlap', () =>
    expect(overlapSec([device(1, span(9, 12), span(11, 13))])).toBe(0));

  it('three devices together — the sum over the pairs', () =>
    // 9-12, 9-12, 9-12 · 3 hours together -> sum 9 - 3 = 6
    expect(
      overlapSec([device(1, span(9, 12)), device(2, span(9, 12)), device(3, span(9, 12))]),
    ).toBe(6 * 3600));
});

describe('shouldFlagOverlap — whether the alert fires', () => {
  const input = (overlap: number, deviceCount = 2) => ({
    deviceCount,
    overlapSec: overlap,
    workedSec: 8 * 3600,
  });

  it('never when there is one device', () =>
    expect(shouldFlagOverlap(input(9999, 1))).toBe(false));

  /**
   * 14 minutes is an everyday event (taking a laptop to a meeting without
   * locking the desktop). With a lower threshold an alert would fire for
   * nearly everyone nearly every day, and the alert would mean nothing.
   */
  it('stays quiet for a small overlap', () =>
    expect(shouldFlagOverlap(input(14 * 60))).toBe(false));

  it('fires at exactly 15 minutes', () =>
    expect(shouldFlagOverlap(input(OVERLAP_ALERT_SEC))).toBe(true));

  it('definitely fires at half an hour', () =>
    expect(shouldFlagOverlap(input(30 * 60))).toBe(true));
});
