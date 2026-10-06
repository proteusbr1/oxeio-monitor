import { describe, expect, it } from 'vitest';

import {
  CAPTURE_EARLIEST,
  CAPTURE_LATEST,
  captureWindowProblem,
  DEFAULT_CAPTURE_WINDOW,
  hhmmToMinutes,
} from '../src/calendar/work-policy.rules';

describe('capture window: the ADR-011c limits', () => {
  it('accepts 07:00-23:00', () => {
    expect(captureWindowProblem('07:00', '23:00')).toBeNull();
    expect(captureWindowProblem('09:00', '18:00')).toBeNull();
  });

  /**
   * A hard product rule: no screenshots of personal activity on a laptop at
   * 2 am. This is the only place where a person can change that limit.
   */
  it('rejects starting one minute early', () => {
    expect(captureWindowProblem('06:59', '23:00')).toContain('ADR-011c');
  });

  it('rejects ending one minute late', () => {
    expect(captureWindowProblem('07:00', '23:01')).toContain('ADR-011c');
  });

  it('rejects an attempt at 24 hours', () => {
    expect(captureWindowProblem('00:00', '23:59')).not.toBeNull();
  });

  /**
   * Start = end means a zero-length window: the agent would take no
   * screenshots, yet the dashboard would look fine. "Someone switched it off"
   * could not be told apart from "not working".
   */
  it('rejects start equal to end', () => {
    expect(captureWindowProblem('09:00', '09:00')).toContain('must be before');
  });

  it('rejects an inverted window', () => {
    expect(captureWindowProblem('18:00', '09:00')).toContain('must be before');
  });

  it('on a bad format it also says which one is wrong', () => {
    expect(captureWindowProblem('7:00', '23:00')).toContain('window start');
    expect(captureWindowProblem('07:00', '２３:００')).toContain('window end');
    expect(captureWindowProblem('07:00', '25:00')).toContain('window end');
  });

  /**
   * If the default itself became invalid, then omitting the capture window
   * would silently install a rule-breaking config, and no test would catch it.
   */
  it('the default window is itself valid', () => {
    expect(
      captureWindowProblem(
        DEFAULT_CAPTURE_WINDOW.screenshotFrom,
        DEFAULT_CAPTURE_WINDOW.screenshotTo,
      ),
    ).toBeNull();
    expect(DEFAULT_CAPTURE_WINDOW.screenshotFrom).toBe(CAPTURE_EARLIEST);
    expect(DEFAULT_CAPTURE_WINDOW.screenshotTo).toBe(CAPTURE_LATEST);
  });
});

describe('hhmmToMinutes', () => {
  it('counts minutes from midnight', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('07:00')).toBe(420);
    expect(hhmmToMinutes('23:59')).toBe(1439);
  });

  it('returns null on a bad format, not zero', () => {
    // Returning zero would make '00:00' and garbage the same, and garbage
    // would be taken as midnight, silently opening the window
    expect(hhmmToMinutes('abc')).toBeNull();
    expect(hhmmToMinutes('24:00')).toBeNull();
    expect(hhmmToMinutes('07:60')).toBeNull();
    expect(hhmmToMinutes('')).toBeNull();
  });
});
