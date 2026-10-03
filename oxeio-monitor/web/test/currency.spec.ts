import { afterEach, describe, expect, it } from 'vitest';

import { currencySymbol, formatTaka, setCurrency } from '../src/lib/format';

/**
 * The currency symbol comes from the server (`CURRENCY`). Only the symbol
 * changes: the digits keep `formatTaka`'s exact-string formatting, so with the
 * default BDT the text is what it always was (format.spec.ts checks that too).
 */
afterEach(() => setCurrency({ code: 'BDT', symbol: '৳' }));

describe('currency symbol', () => {
  it('default is ৳ and the text is unchanged', () => {
    expect(currencySymbol()).toBe('৳');
    expect(formatTaka('13000.50')).toBe('৳ 13,000.50');
    expect(formatTaka('900')).toBe('৳ 900');
  });

  it('another currency changes the symbol only', () => {
    setCurrency({ code: 'BRL', symbol: 'R$' });
    expect(formatTaka('13000.50')).toBe('R$ 13,000.50');
    expect(formatTaka('-250.05')).toBe('R$ -250.05');
    expect(currencySymbol()).toBe('R$');
  });

  it('an empty answer keeps the current symbol', () => {
    setCurrency({ code: 'XXX', symbol: '  ' });
    expect(currencySymbol()).toBe('৳');
  });
});
