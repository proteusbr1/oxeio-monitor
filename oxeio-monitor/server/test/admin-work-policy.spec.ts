import { describe, expect, it } from 'vitest';

import {
  captureWindowProblem,
  DEFAULT_CAPTURE_WINDOW,
  hhmmToMinutes,
} from '../src/calendar/work-policy.rules';

describe('capture window', () => {
  it('no window at all = whenever the computer is in use, and that is the default', () => {
    expect(captureWindowProblem(null, null)).toBeNull();
    expect(DEFAULT_CAPTURE_WINDOW).toEqual({ screenshotFrom: null, screenshotTo: null });
  });

  it('accepts any window inside the day, early mornings and late nights included', () => {
    expect(captureWindowProblem('07:00', '23:00')).toBeNull();
    expect(captureWindowProblem('09:00', '18:00')).toBeNull();
    expect(captureWindowProblem('00:00', '23:59')).toBeNull();
    expect(captureWindowProblem('05:30', '23:30')).toBeNull();
  });

  it('half a window is refused — both ends, or neither', () => {
    expect(captureWindowProblem('09:00', null)).toContain('both');
    expect(captureWindowProblem(null, '18:00')).toContain('both');
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
