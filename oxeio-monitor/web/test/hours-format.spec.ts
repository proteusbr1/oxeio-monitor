import { describe, expect, it } from 'vitest';

import type { PeriodSummary } from '../src/api/hoursStatement';
import {
  canResend,
  deliveryLine,
  hm,
  joinHm,
  lineStatus,
  periodLabel,
  pickPeriod,
  splitHm,
} from '../src/pages/hours/hours.format';

const period = (over: Partial<PeriodSummary> = {}): PeriodSummary => ({
  id: 1,
  start: '2026-08-26',
  end: '2026-09-25',
  open: false,
  snapshotAt: '2026-09-26T10:00:00Z',
  deliveryStatus: 'sent',
  sentAt: '2026-09-26T10:10:00Z',
  deliveryError: null,
  ...over,
});

describe('hours statement formatting', () => {
  it('whole hours and two-digit minutes, sign kept', () => {
    expect(hm(10_405)).toBe('173 h 25 min');
    expect(hm(0)).toBe('0 h 00 min');
    expect(hm(-50)).toBe('−0 h 50 min');
  });
  it('the status of a line', () => {
    expect(lineStatus({ id: null, postedAt: null, postedMin: null })).toBe(
      'live',
    );
    expect(lineStatus({ id: 1, postedAt: null, postedMin: null })).toBe(
      'to_post',
    );
    expect(
      lineStatus({ id: 1, postedAt: '2026-10-27T10:00:00Z', postedMin: null }),
    ).toBe('posted');
    expect(
      lineStatus({ id: 1, postedAt: '2026-10-27T10:00:00Z', postedMin: 590 }),
    ).toBe('posted_different');
  });
  it('a period reads as its first and last day', () => {
    expect(periodLabel('2026-09-26', '2026-10-25')).toContain('–');
    expect(periodLabel('2026-09-26', '2026-10-25')).not.toBe(
      periodLabel('2026-10-26', '2026-11-25'),
    );
  });

  it('opens on the asked period, else the newest frozen one, else the open one', () => {
    const open = period({
      id: 3,
      open: true,
      snapshotAt: null,
      deliveryStatus: null,
      sentAt: null,
    });
    const list = [open, period({ id: 2 }), period({ id: 1 })];
    expect(pickPeriod(list, 1)?.id).toBe(1);
    expect(pickPeriod(list, 99)?.id).toBe(2);
    expect(pickPeriod(list, null)?.id).toBe(2);
    expect(pickPeriod([open], null)?.id).toBe(3);
    expect(pickPeriod([], null)).toBeNull();
  });
  it('resend is offered once the email could not go, never on the open period', () => {
    expect(canResend(period({ deliveryStatus: 'failed' }))).toBe(true);
    expect(canResend(period({ deliveryStatus: 'no_recipients' }))).toBe(true);
    expect(canResend(period({ deliveryStatus: 'not_configured' }))).toBe(true);
    expect(canResend(period({ deliveryStatus: 'no_staff' }))).toBe(true);
    expect(canResend(period({ deliveryStatus: 'sent' }))).toBe(false);
    expect(canResend(period({ deliveryStatus: 'pending' }))).toBe(false);
    expect(canResend(period({ open: true, deliveryStatus: null }))).toBe(false);
  });
  it('the delivery line names the problem', () => {
    expect(deliveryLine(period({ open: true }))).toBeNull();
    expect(
      deliveryLine(
        period({ deliveryStatus: 'failed', deliveryError: 'timeout' }),
      ),
    ).toEqual({
      text: 'Failed: timeout',
      problem: true,
    });
    expect(
      deliveryLine(period({ deliveryStatus: 'not_configured' }))?.problem,
    ).toBe(true);
    expect(deliveryLine(period())?.problem).toBe(false);
  });
  it('the dialog splits and joins hours and minutes, sign on the hours', () => {
    expect(splitHm(10_405)).toEqual({ hours: '173', minutes: '25' });
    expect(splitHm(-50)).toEqual({ hours: '-0', minutes: '50' });
    expect(joinHm('173', '25')).toBe(10_405);
    expect(joinHm('-0', '50')).toBe(-50);
    expect(joinHm('−2', '05')).toBe(-125);
    expect(joinHm('3', '')).toBe(180);
    expect(joinHm('3', '60')).toBeNull();
    expect(joinHm('', '10')).toBeNull();
    expect(joinHm('1.5', '0')).toBeNull();
  });
});
