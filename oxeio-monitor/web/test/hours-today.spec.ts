import { afterEach, describe, expect, it } from 'vitest';

import i18n from '../src/i18n';
import { cutoffHint, daysToCutoff } from '../src/pages/live/hoursToday';

describe('the open pay period on the Live Board', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('days left to the cutoff', () => {
    expect(daysToCutoff('2026-10-09', '2026-10-25')).toBe(16);
    expect(daysToCutoff('2026-10-25', '2026-10-25')).toBe(0);
    // across a month and a year end
    expect(daysToCutoff('2026-12-30', '2027-01-02')).toBe(3);
    // the period ought to have frozen already: never negative
    expect(daysToCutoff('2026-10-27', '2026-10-25')).toBe(0);
  });

  it('the card hint', async () => {
    const open = { start: '2026-09-26', end: '2026-10-25' };
    expect(cutoffHint(open, '2026-10-09')).toMatch(/ · cutoff in 16 days$/);
    expect(cutoffHint(open, '2026-10-24')).toMatch(/ · cutoff in 1 day$/);
    expect(cutoffHint(open, '2026-10-25')).toMatch(/ · cutoff today$/);
    await i18n.changeLanguage('pt-BR');
    expect(cutoffHint(open, '2026-10-09')).toMatch(/ · corte em 16 dias$/);
    expect(cutoffHint(open, '2026-10-25')).toMatch(/ · corte hoje$/);
    await i18n.changeLanguage('es');
    expect(cutoffHint(open, '2026-10-09')).toMatch(/ · corte en 16 días$/);
  });
});
