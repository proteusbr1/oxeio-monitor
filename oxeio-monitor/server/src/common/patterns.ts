
/**
 * Careful: ValidationPipe is globally `whitelist + forbidNonWhitelisted`, so
 * sending a field that is not declared here returns 400 rather than being
 * silently ignored. The same holds for queries: writing `?foo=bar` also gives 400.
 */

/**
 * Money is taken **as a string**, not a number.
 *
 * If `13000.10` arrives from JSON as a number, it sits in IEEE-754 as
 * 13000.099999999999 and is then rounded back by Decimal(12,2), and nobody
 * would ever know why a cent was off. A string goes straight into Prisma's
 * Decimal with no float in between.
 */
export const MONEY = /^\d{1,10}(\.\d{1,2})?$/;
export const MONEY_MSG =
  'Salary must be given as a string in the form "13000" or "13000.50"';
export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
