/**
 * The currency salaries, deductions and deposits are in — `CURRENCY`
 * (ISO 4217), default `BDT`.
 *
 * The server never prints money with a symbol: amounts leave as decimal
 * strings (`'13000.50'`, see `paisaToTaka`). Only the dashboard puts the
 * symbol in front, so this module only has to say which currency it is.
 *
 * ⚠️ Only currencies with two minor digits are accepted. Every amount is
 *    stored in hundredths (`amount_paisa`, `PAISA_PER_TAKA = 100`); a
 *    currency with none (JPY) or three (KWD) would be off by a factor of 100
 *    or 10 in every stored row, silently. Like an unknown time zone, it is
 *    refused at startup instead.
 */

export interface CurrencyInfo {
  /** ISO 4217, e.g. `BDT` */
  code: string;
  /** What goes in front of an amount, e.g. `৳`, `R$` */
  symbol: string;
}

export function checkCurrency(raw: string): CurrencyInfo {
  const code = raw.trim().toUpperCase();

  if (
    !/^[A-Z]{3}$/.test(code) ||
    !Intl.supportedValuesOf('currency').includes(code)
  ) {
    throw new Error(
      `CURRENCY="${raw}" is not an ISO 4217 code (example: BDT, BRL, USD)`,
    );
  }

  const format = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'narrowSymbol',
  });
  const digits = format.resolvedOptions().maximumFractionDigits;
  if (digits !== 2) {
    throw new Error(
      `CURRENCY="${code}" has ${digits} decimal places; amounts are stored in hundredths, ` +
        `so only currencies with 2 are supported`,
    );
  }

  const symbol =
    format.formatToParts(0).find((p) => p.type === 'currency')?.value ?? code;
  return { code, symbol };
}

/**
 * Read at import time like `WORK_TIMEZONE`, so a wrong value stops the
 * server before it answers a single request.
 */
export const CURRENCY: CurrencyInfo = checkCurrency(
  process.env.CURRENCY || 'BDT',
);
