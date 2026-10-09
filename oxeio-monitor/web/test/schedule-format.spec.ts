import { afterEach, describe, expect, it } from 'vitest';

import i18n from '../src/i18n';
import {
  BREACH_LABEL,
  breachNotes,
  clockOf,
  minutesText,
  scheduleLine,
  signedDuration,
} from '../src/pages/schedule/schedule.format';

describe('schedule formatting', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('minutes since midnight as a clock', () => {
    expect(clockOf(500)).toBe('08:20');
    expect(clockOf(1440)).toBe('24:00');
    expect(clockOf(null)).toBe('—');
  });
  it('a signed balance, in the app-wide duration format', () => {
    expect(signedDuration(70)).toBe('+1h 10m');
    expect(signedDuration(-12)).toBe('−12m');
    expect(signedDuration(0)).toBe('0m');
    expect(signedDuration(-60)).toBe('−1h 0m');
  });
  it('a length in minutes, in the same format', () => {
    expect(minutesText(45)).toBe('45m');
    expect(minutesText(90)).toBe('1h 30m');
  });
  it('every breach has a label', () => {
    expect(Object.keys(BREACH_LABEL).sort()).toEqual([
      'break_missing',
      'break_short',
      'early_leave',
      'late',
      'no_show',
    ]);
  });
  it('the notes say how late and how early', async () => {
    const day = {
      breaches: ['late', 'early_leave', 'break_short'] as const,
      lateMin: 12,
      earlyLeaveMin: 25,
    };
    expect(breachNotes({ ...day, breaches: [...day.breaches] })).toBe(
      'Late 12m · Left early 25m · Short break',
    );
    await i18n.changeLanguage('pt-BR');
    expect(breachNotes({ ...day, breaches: [...day.breaches] })).toBe(
      'Atraso de 12m · Saída antecipada de 25m · Intervalo curto',
    );
    await i18n.changeLanguage('es');
    expect(breachNotes({ ...day, breaches: ['late'] })).toBe('Retraso de 12m');
  });
  it('the scheduled day for the header', async () => {
    expect(
      scheduleLine({
        officeFrom: '08:00',
        officeTo: '17:00',
        requiredBreakMin: 60,
      }),
    ).toBe('Scheduled 08:00–17:00, with a 1h 0m break');
    expect(
      scheduleLine({
        officeFrom: '08:00',
        officeTo: '17:00',
        requiredBreakMin: 0,
      }),
    ).toBe('Scheduled 08:00–17:00');
    expect(
      scheduleLine({
        officeFrom: null,
        officeTo: null,
        requiredBreakMin: null,
      }),
    ).toBeNull();
    await i18n.changeLanguage('pt-BR');
    expect(
      scheduleLine({
        officeFrom: '08:00',
        officeTo: '17:00',
        requiredBreakMin: 60,
      }),
    ).toBe('Jornada prevista 08:00–17:00, com intervalo de 1h 0m');
  });
});
