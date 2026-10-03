import { describe, expect, it } from 'vitest';

import { checkCurrency, CURRENCY } from '../src/payroll/currency';

/**
 * `CURRENCY` — which currency the amounts are in. Default BDT, symbol ৳.
 * Amounts are stored in hundredths, so only two-decimal currencies pass.
 */
describe('checkCurrency', () => {
  it('default is BDT / ৳', () => {
    expect(CURRENCY).toEqual({ code: 'BDT', symbol: '৳' });
  });

  it.each([
    ['BRL', 'R$'],
    ['usd', '$'],
    [' eur ', '€'],
  ])('%s → %s', (raw, symbol) => {
    expect(checkCurrency(raw).symbol).toBe(symbol);
  });

  it.each(['JPY', 'KWD'])('%s is refused — not two decimal places', (code) => {
    expect(() => checkCurrency(code)).toThrow(/decimal places/);
  });

  it.each(['XYZ', 'taka', ''])('"%s" is not a currency', (raw) => {
    expect(() => checkCurrency(raw)).toThrow(/ISO 4217/);
  });
});
