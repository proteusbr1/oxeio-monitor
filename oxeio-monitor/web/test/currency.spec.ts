import { afterEach, describe, expect, it } from 'vitest';

import { currencySymbol, formatMoney, setCurrency } from '../src/lib/format';

/**
 * The currency symbol comes from the server (`CURRENCY`). Only the symbol
 * changes: the digits keep `formatMoney`'s exact-string formatting, so with the
 * default USD the text is '$ 13,000.50' (format.spec.ts checks that too).
 */
afterEach(() => setCurrency({ code: 'USD', symbol: '$' }));

describe('currency symbol', () => {
  it('default is $', () => {
    expect(currencySymbol()).toBe('$');
    expect(formatMoney('13000.50')).toBe('$ 13,000.50');
    expect(formatMoney('900')).toBe('$ 900');
  });

  it('another currency changes the symbol only', () => {
    setCurrency({ code: 'BRL', symbol: 'R$' });
    expect(formatMoney('13000.50')).toBe('R$ 13,000.50');
    expect(formatMoney('-250.05')).toBe('R$ -250.05');
    expect(currencySymbol()).toBe('R$');
  });

  it('an empty answer keeps the current symbol', () => {
    setCurrency({ code: 'XXX', symbol: '  ' });
    expect(currencySymbol()).toBe('$');
  });
});
