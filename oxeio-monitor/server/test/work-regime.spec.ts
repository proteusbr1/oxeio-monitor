import { describe, expect, it } from 'vitest';

import { dailyTargetSecOf, hasTarget, targetSpreadOf } from '../src/calendar/work-regime';
import { regimeData } from '../src/calendar/work-policy.rules';
import { computePayroll, payTermsForMonth } from '../src/payroll/payroll.math';

const H = 3600;
const policy = (over: Record<string, unknown> = {}) => ({
  targetBasis: 'month' as const,
  monthlyTargetHours: 208,
  expectedWorkdays: 26,
  weeklyTargetHours: null,
  dailyTargetHours: null,
  weeklyOffDays: [6, 7],
  ...over,
});

describe('targetSpreadOf — every basis becomes hours per workday', () => {
  it('per month: the original 208 h over 26 days = 8 h', () => {
    expect(dailyTargetSecOf(policy())).toBe(8 * H);
  });
  it('per week: 40 h over the 5 working days = 8 h', () => {
    expect(dailyTargetSecOf(policy({ targetBasis: 'week', weeklyTargetHours: 40 }))).toBe(8 * H);
    // 30 h over a 6-day week (Sunday off) = 5 h
    expect(dailyTargetSecOf(policy({ targetBasis: 'week', weeklyTargetHours: 30, weeklyOffDays: [7] }))).toBe(5 * H);
  });
  it('per day: a fixed 9–18 schedule with a 1 h break = 8 h', () => {
    expect(dailyTargetSecOf(policy({ targetBasis: 'day', dailyTargetHours: 8 }))).toBe(8 * H);
  });
  it('none: no target', () => {
    expect(targetSpreadOf(policy({ targetBasis: 'none' }))).toEqual({ periodTargetSec: 0, periodWorkdays: 1 });
    expect(hasTarget(policy({ targetBasis: 'none' }))).toBe(false);
  });
  it('no policy: the original default', () => {
    expect(dailyTargetSecOf(null)).toBe(8 * H);
  });
});

describe('regimeData — a basis needs its hours', () => {
  it('refuses a weekly or daily target without hours', () => {
    expect(() => regimeData({ targetBasis: 'week' })).toThrow(/hours per week/);
    expect(() => regimeData({ targetBasis: 'day' })).toThrow(/hours per day/);
    expect(regimeData({ targetBasis: 'week', weeklyTargetHours: 40 })).toEqual({ targetBasis: 'week', weeklyTargetHours: 40 });
  });
  it('a partial update is checked against what is stored', () => {
    const before = { targetBasis: 'week', weeklyTargetHours: 40, dailyTargetHours: null };
    expect(regimeData({ overtimeMultiplier: 1.5 }, before)).toEqual({ overtimeMultiplier: 1.5 });
    expect(() => regimeData({ weeklyTargetHours: null }, before)).toThrow(/hours per week/);
  });
});

const month = {
  targetSec: 160 * H,
  observedTargetSec: 160 * H,
  workdays: 20,
  monthWorkdays: 20,
};

describe('computePayroll — monthly salary', () => {
  it('the original rule stays the default: missing hours deducted, overtime not paid', () => {
    const line = computePayroll({ ...month, monthlySalary: 3200, creditedSec: 150 * H });
    expect(line.payBasis).toBe('monthly');
    expect(line.deductionMinor).toBe(20_000); // 10 h × 20.00
    expect(line.payableMinor).toBe(300_000);
    expect(line.overtimePayMinor).toBe(0);
  });
  it('the policy can keep the salary whole', () => {
    const line = computePayroll({ ...month, monthlySalary: 3200, creditedSec: 150 * H, deductShortfall: false });
    expect(line.deductionMinor).toBe(0);
    expect(line.payableMinor).toBe(320_000);
    expect(line.shortfallSec).toBe(10 * H); // still reported
  });
  it('overtime paid at the policy multiple', () => {
    const line = computePayroll({ ...month, monthlySalary: 3200, creditedSec: 170 * H, overtimeMultiplier: 1.5 });
    expect(line.overtimePayMinor).toBe(30_000); // 10 h × 20.00 × 1.5
    expect(line.payableMinor).toBe(350_000);
    expect(line.overtimeNote).toMatch(/×1.5/);
  });
  it('no target: the salary is paid, nothing short, no overtime', () => {
    const line = computePayroll({ ...month, targetSec: 0, observedTargetSec: 0, monthlySalary: 3200, creditedSec: 50 * H, noTarget: true });
    expect(line).toMatchObject({ payableMinor: 320_000, deductionMinor: 0, overtimeSec: 0, shortfallSec: 0 });
  });
  it('a zero target that is not "no target" is still refused', () => {
    expect(() => computePayroll({ ...month, targetSec: 0, monthlySalary: 3200, creditedSec: 0 })).toThrow(/zero/);
  });
});

describe('computePayroll — hourly', () => {
  it('hours counted × rate, plus paid leave', () => {
    const line = computePayroll({ ...month, monthlySalary: 0, payBasis: 'hourly', hourlyRate: 25, creditedSec: 100 * H, paidLeaveSec: 16 * H });
    expect(line.payableMinor).toBe(290_000); // (100 + 16) × 25.00
    expect(line.deductionMinor).toBe(0);
  });
  it('without a multiplier, every hour is paid the same; with one, hours over the target get it', () => {
    const plain = computePayroll({ ...month, monthlySalary: 0, payBasis: 'hourly', hourlyRate: 20, creditedSec: 170 * H });
    expect(plain.payableMinor).toBe(340_000);
    const ot = computePayroll({ ...month, monthlySalary: 0, payBasis: 'hourly', hourlyRate: 20, creditedSec: 170 * H, overtimeMultiplier: 2 });
    expect(ot.overtimePayMinor).toBe(40_000); // 10 h × 20 × 2
    expect(ot.payableMinor).toBe(360_000); // 160 × 20 + 400
  });
  it('none: hours only, no money', () => {
    const line = computePayroll({ ...month, monthlySalary: 0, payBasis: 'none', creditedSec: 100 * H });
    expect(line).toMatchObject({ payBasis: 'none', payableMinor: 0 });
  });
});

describe('payTermsForMonth — a change does not rewrite past months', () => {
  const now = { payBasis: 'hourly' as const, monthlySalary: null, hourlyRate: '30.00' };
  const history = [{ throughMonth: '2026-09', payBasis: 'monthly' as const, monthlySalary: '5000.00', hourlyRate: null }];
  it('September keeps the old monthly salary; October uses the hourly rate', () => {
    expect(payTermsForMonth('2026-09', now, history)).toMatchObject({ payBasis: 'monthly', monthlySalary: '5000.00' });
    expect(payTermsForMonth('2026-10', now, history)).toEqual(now);
  });
});
