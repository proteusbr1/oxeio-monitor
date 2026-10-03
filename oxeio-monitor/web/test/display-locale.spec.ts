import { afterEach, describe, expect, it } from 'vitest';

import {
  formatBytes,
  formatCount,
  formatDate,
  formatDateMedium,
  formatDateShort,
  formatDuration,
  formatHours,
  formatMonth,
  formatPct,
  formatTaka,
  setDisplayLocale,
  weekdayOf,
} from '../src/lib/format';

/**
 * DISPLAY_LOCALE — dates and numbers in the order a country reads them,
 * without translating a word. format.spec.ts covers the default (no locale),
 * which must stay exactly as it was.
 */
afterEach(() => setDisplayLocale(null));

describe('no locale — the formats as they always were', () => {
  it('dates, months and numbers', () => {
    expect(formatDate('2026-08-10')).toBe('10 August 2026');
    expect(formatDateShort('2026-08-10')).toBe('10 Aug');
    expect(formatMonth('2026-08')).toBe('August 2026');
    expect(formatTaka('13000.50')).toBe('৳ 13,000.50');
    expect(formatCount(12345)).toBe('12,345');
    expect(formatHours(27_000)).toBe('7.5');
  });
});

describe('pt-BR', () => {
  it('dates are numeric, day first — no Portuguese month names', () => {
    setDisplayLocale('pt-BR');
    expect(formatDate('2026-08-10')).toBe('10/08/2026');
    expect(formatDateShort('2026-08-10')).toBe('10/08');
    expect(formatMonth('2026-08')).toBe('08/2026');
  });

  it('numbers use . for thousands and , for decimals', () => {
    setDisplayLocale('pt-BR');
    expect(formatTaka('13000.50')).toBe('৳ 13.000,50');
    expect(formatTaka('-250.05')).toBe('৳ -250,05');
    expect(formatCount(12345)).toBe('12.345');
    expect(formatHours(27_000)).toBe('7,5');
    expect(formatPct(12.5, 1)).toBe('12,5%');
    expect(formatBytes(1536)).toBe('1,5 KB');
  });

  it('words stay English — this is formatting, not translation', () => {
    setDisplayLocale('pt-BR');
    expect(weekdayOf('2026-08-10')).toBe('Mon');
    expect(formatDuration(27_120)).toBe('7h 32m');
  });

  it('money is never turned into a number on the way', () => {
    setDisplayLocale('pt-BR');
    // 13000.10 as a float would print 13000.0999…
    expect(formatTaka('13000.10')).toBe('৳ 13.000,10');
  });
});

describe('en-US — month first', () => {
  it('dates', () => {
    setDisplayLocale('en-US');
    expect(formatDate('2026-08-10')).toBe('08/10/2026');
    expect(formatTaka('13000.50')).toBe('৳ 13,000.50');
  });
});

describe('dates do not slip a day', () => {
  it('midnight UTC labels are formatted as UTC, whatever the browser zone', () => {
    setDisplayLocale('pt-BR');
    expect(formatDate('2027-01-01')).toBe('01/01/2027');
    expect(formatDate('2026-12-31')).toBe('31/12/2026');
  });
});

describe('a bad or empty answer keeps the default', () => {
  it.each([null, '', '   ', 'not-a-locale-xx-yy-zz', 'pt_BR!!'])(
    '%s',
    (value) => {
      setDisplayLocale(value);
      expect(formatDate('2026-08-10')).toBe('10 August 2026');
      expect(formatCount(12345)).toBe('12,345');
    },
  );
});

describe('the top bar and the Months tab go through the same rules', () => {
  it('formatDateMedium keeps the top bar text by default', () => {
    expect(formatDateMedium('2026-10-03')).toBe('3 Oct 2026');
  });

  it('formatDateMedium is numeric with a locale', () => {
    setDisplayLocale('pt-BR');
    expect(formatDateMedium('2026-10-03')).toBe('03/10/2026');
  });

  it('formatMonth gives exactly what the Months tab printed before', () => {
    for (let m = 1; m <= 12; m++) {
      const key = `2026-${String(m).padStart(2, '0')}`;
      const before = new Date(Date.UTC(2026, m - 1, 1)).toLocaleDateString(
        'en-GB',
        {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        },
      );
      expect(formatMonth(key)).toBe(before);
    }
  });
});
