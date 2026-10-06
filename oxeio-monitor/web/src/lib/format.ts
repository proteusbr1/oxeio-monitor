/**
 * The one place for showing numbers and dates.
 *
 * Because all six pages use the same functions, "7.5 hours" and "7h 32m" will not
 * look different on two screens. Do not write your own formatting in a page.
 *
 * Careful: the screen language is English (the owner's decision): months,
 * weekdays and units are all English: `7h 32m`, `11 August 2026`. Digits were
 * English before and still are; the `.num` class's tabular-nums only works then.
 *
 * Comments in this file are project documentation, not screen text; only the
 * returned strings are English screen text.
 */

/**
 * Asia/Dhaka = UTC+06:00, no DST; exactly the same constant as the server's
 * `work-time.ts`. With two numbers in two places, one would eventually change.
 */
let WORK_OFFSET_MS = 6 * 60 * 60 * 1000;

/**
 * The work-day zone, which the server may run on something other than
 * Asia/Dhaka (`WORK_TIMEZONE`). Starts as Dhaka, so a server that does not
 * send the zone (older version, request failed) behaves exactly as before.
 */
let workZone = { timeZone: 'Asia/Dhaka', utcOffsetMinutes: 360 };

/**
 * Replaces the offset used by every helper in this file. Called once from
 * `main.tsx` with the answer of `GET /auth/time-zone`, before the first
 * render — components read "today" in `useState` initialisers, so a value
 * that changed after mounting would leave them on the wrong day.
 */
export function setWorkTimeZone(zone: {
  timeZone: string;
  utcOffsetMinutes: number;
}): void {
  if (!Number.isFinite(zone.utcOffsetMinutes)) return;
  workZone = {
    timeZone: zone.timeZone,
    utcOffsetMinutes: zone.utcOffsetMinutes,
  };
  WORK_OFFSET_MS = zone.utcOffsetMinutes * 60 * 1000;
}

/** IANA name of the work-day zone — `Asia/Dhaka` by default */
export function workTimeZone(): string {
  return workZone.timeZone;
}

/** Short place name for labels: `Asia/Dhaka` → `Dhaka`, `America/Sao_Paulo` → `Sao Paulo` */
export function workTimeZoneLabel(): string {
  return (workZone.timeZone.split('/').pop() ?? workZone.timeZone).replace(
    /_/g,
    ' ',
  );
}

/** Offset of the work-day zone in ms (Dhaka = 6 h) — for the few callers that cut days by hand */
export function workOffsetMs(): number {
  return WORK_OFFSET_MS;
}

/** The offset as an ISO-8601 suffix: `+06:00`, `-03:00` */
export function workOffsetIso(): string {
  const min = workZone.utcOffsetMinutes;
  const abs = Math.abs(min);
  return `${min < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR = 3600;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Hand-written short forms of the months, for narrow columns.
 *
 * In English `MONTHS[i].slice(0, 3)` would work, yet the list stays hand-written:
 * with a Bengali list that same `slice()` silently broke the text. JS `slice()`
 * counts UTF-16 units; it does not know conjuncts or vowel signs.
 *   - October in Bengali, sliced to 3, ends in a hasanta (virama): broken text
 *   - December in Bengali, sliced to 3, comes out right, but by coincidence
 *   - February in Bengali, sliced to 3, ends in a hasanta again
 * So at least three months a year would look broken on every row of attendance,
 * summary and the audit log, with no error. If Bengali (or any other Indic
 * script) ever returns, the trap must not be set again, so the two lists are
 * kept separate.
 */
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Sun = 0 ... Sat = 6 (the order of JS `getUTCDay()`). */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Display locale (DISPLAY_LOCALE on the server) ───────────────────────────

/**
 * How dates and numbers are written — `null` (the default) keeps every
 * function below exactly as it was. Set from `GET /auth/display-locale` in
 * `main.tsx`, before the first render.
 *
 * ⚠️ Formatting only, never translation: with a locale, dates are numeric in
 *    that locale's order and numbers use its separators. No month or weekday
 *    name changes language — the rest of the screen is English, and a
 *    Portuguese "agosto" in an English table would be neither.
 */
let displayLocale: string | null = null;

/** The locale's thousands and decimal separators, cached per locale */
let separators: { group: string; decimal: string } = {
  group: ',',
  decimal: '.',
};

export function setDisplayLocale(locale: string | null | undefined): void {
  const tag = typeof locale === 'string' ? locale.trim() : '';
  let supported = false;
  try {
    supported =
      tag !== '' && Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0;
  } catch {
    // a malformed tag throws RangeError — treat it as no locale
  }
  if (!supported) {
    displayLocale = null;
    separators = { group: ',', decimal: '.' };
    return;
  }
  displayLocale = tag;
  const parts = new Intl.NumberFormat(tag).formatToParts(12345.6);
  separators = {
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
  };
}

/**
 * `'13,000.50'` (the formats below) → the locale's separators, e.g.
 * `'13.000,50'`. Works on the string, never through `Number()` — the same
 * rule `formatTaka` keeps for money.
 */
function localizeDigits(text: string): string {
  if (displayLocale === null) return text;
  return text.replace(/[,.]/g, (c) =>
    c === ',' ? separators.group : separators.decimal,
  );
}

/** Numeric date in the locale's order — only called with a locale set */
function localeDate(
  date: Date,
  parts: Pick<Intl.DateTimeFormatOptions, 'day' | 'month' | 'year'>,
): string {
  return new Intl.DateTimeFormat(displayLocale!, {
    timeZone: 'UTC',
    ...parts,
  }).format(date);
}

// ── Workday (`YYYY-MM-DD`) ──────────────────────────────────────────────────

/**
 * Today's workday in Dhaka: the browser's timezone is not assumed.
 *
 * `new Date().toISOString().slice(0, 10)` would give the UTC date, and in Dhaka
 * between midnight and 6 a.m. that shows the previous day, so an employee working
 * at night (normal per section 2.1-a) could not find their own hours for today.
 * In the other direction, in a browser in Bangkok `toLocaleDateString()` would run
 * a day ahead. So the offset is stated explicitly here.
 */
export function todayInWorkZone(now: Date = new Date()): string {
  return isoDateOf(new Date(now.getTime() + WORK_OFFSET_MS));
}

/**
 * The current hour in Dhaka, 0-23: "where are we now" on the day-rhythm chart.
 *
 * Careful: `new Date().getHours()` cannot be used; that is the browser's hour. If
 * the owner opened the board from abroad, the marker would sit under the wrong
 * column, and a hard-to-spot error: the chart would be right, only the mark moved.
 * The offset is explicit here, as in `todayInDhaka`.
 */
export function workHourNow(now: Date = new Date()): number {
  return new Date(now.getTime() + WORK_OFFSET_MS).getUTCHours();
}

/** Which Dhaka workday an instant falls in: `YYYY-MM-DD`. */
export function workDateOf(instant: Date | string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  return isoDateOf(new Date(date.getTime() + WORK_OFFSET_MS));
}

/** `YYYY-MM-DD` from the UTC parts; no local getter. */
function isoDateOf(shifted: Date): string {
  return [
    shifted.getUTCFullYear(),
    pad(shifted.getUTCMonth() + 1),
    pad(shifted.getUTCDate()),
  ].join('-');
}

/**
 * `YYYY-MM-DD` to a UTC-midnight Date.
 *
 * Careful: `new Date('2026-02-31')` quietly makes 3 March, so the result is checked
 * by converting back. `null` if it does not match; otherwise the user would see
 * data for the wrong date without knowing.
 */
export function parseWorkDate(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;

  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function isValidWorkDate(text: string): boolean {
  return parseWorkDate(text) !== null;
}

/** Shift a workday: `shiftWorkDate('2026-08-10', -1)` gives `'2026-08-09'`. */
export function shiftWorkDate(date: string, days: number): string {
  const parsed = parseWorkDate(date);
  if (!parsed) return date;
  return isoDateOf(new Date(parsed.getTime() + days * DAY_MS));
}

/** The 1st of that date's month: the report's default `from`. */
export function monthStartOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The last day of that month: both `'2026-02'` and `'2026-02-10'` work. */
export function monthEndOf(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  // Day 0 of the next month = last day of this month; leap years work out by themselves
  return isoDateOf(new Date(Date.UTC(year, month, 0)));
}

/** `'2026-08-10'` to `'2026-08'`: the format of payroll and monthly_summary. */
export function monthKeyOf(date: string): string {
  return date.slice(0, 7);
}

/** Shift a month: `shiftMonth('2026-01', -1)` gives `'2025-12'`. */
export function shiftMonth(monthKey: string, months: number): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const moved = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}`;
}

/** The 1st of the current month to today in Dhaka. The default range for report pages. */
export function thisMonthRange(now: Date = new Date()): {
  from: string;
  to: string;
} {
  const today = todayInWorkZone(now);
  return { from: monthStartOf(today), to: today };
}

// ── Showing dates ───────────────────────────────────────────────────────────

/** `'2026-08-10'` → `'10 August 2026'` */
export function formatDate(date: string): string {
  const parsed = parseWorkDate(date);
  if (!parsed) return date;
  if (displayLocale !== null) {
    return localeDate(parsed, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
}

/** `'2026-08-10'` to `'10 Aug'`: for narrow table columns. */
/**
 * `'2026-10-03'` → `'3 Oct 2026'` — the top bar's date. With a display
 * locale, the same numeric form as `formatDate` (`03/10/2026`).
 */
export function formatDateMedium(date: string): string {
  const parsed = parseWorkDate(date);
  if (!parsed) return date;
  if (displayLocale !== null) {
    return localeDate(parsed, { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  return `${parsed.getUTCDate()} ${MONTHS_SHORT[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
}

export function formatDateShort(date: string): string {
  const parsed = parseWorkDate(date);
  if (!parsed) return date;
  if (displayLocale !== null)
    return localeDate(parsed, { day: '2-digit', month: '2-digit' });
  return `${parsed.getUTCDate()} ${MONTHS_SHORT[parsed.getUTCMonth()]}`;
}

/**
 * `'2026-08-10'` to `'Mon'`
 *
 * Careful: in Bengali the word for "day" used to be appended (Sun + that word).
 * Do not do that in English: `Mon` is complete by itself, and appending would
 * give something like "Mon" glued to a Bengali suffix.
 */
export function weekdayOf(date: string): string {
  const parsed = parseWorkDate(date);
  if (!parsed) return '';
  return WEEKDAYS[parsed.getUTCDay()];
}

/** `'2026-08'` → `'August 2026'` */
export function formatMonth(monthKey: string): string {
  const month = Number(monthKey.slice(5, 7));
  if (!Number.isFinite(month) || month < 1 || month > 12) return monthKey;
  if (displayLocale !== null) {
    const first = new Date(
      Date.UTC(Number(monthKey.slice(0, 4)), month - 1, 1),
    );
    return localeDate(first, { month: '2-digit', year: 'numeric' });
  }
  return `${MONTHS[month - 1]} ${monthKey.slice(0, 4)}`;
}

/**
 * ISO instant to the Dhaka clock time, `'14:32'`.
 *
 * Careful: `toLocaleTimeString()` would show the user's own timezone; someone
 * outside Dhaka (or on a VPN) would see wrong screenshot times and have no way
 * to notice. All office times are Dhaka time.
 */
export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const shifted = new Date(new Date(iso).getTime() + WORK_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) return '—';
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

/** ISO instant to `'10 August 2026, 14:32'` (Dhaka time). */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return `${formatDate(workDateOf(at))}, ${formatTime(iso)}`;
}

/**
 * "How long ago": `'3 minutes ago'`.
 *
 * For showing the age of a heartbeat on the live board. Careful: a future time
 * (clock skew) gives `'Just now'`; showing a negative number would look as if the
 * system had broken.
 *
 * Careful: English needs singular/plural agreement (Bengali did not):
 * `1 minute ago`, `2 minutes ago`. Seeing "1 minutes ago" makes the text sound
 * mechanical and lowers trust in the numbers.
 */
export function formatAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';

  const sec = Math.floor((now.getTime() - at.getTime()) / 1000);
  if (sec < 45) return 'Just now';
  if (sec < 3600) return ago(Math.round(sec / 60), 'minute');
  if (sec < 86400) return ago(Math.round(sec / 3600), 'hour');
  return ago(Math.round(sec / 86400), 'day');
}

function ago(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

// ── Duration ────────────────────────────────────────────────────────────────

/**
 * Seconds to `'7h 32m'`. Under an hour just `'32m'`; zero gives `'0m'`.
 *
 * Careful: zero is `'0m'`, not an empty string. An empty cell does not tell you
 * whether there is no data or the value really is zero, and this file has `'—'`
 * for "no data".
 *
 * Careful: minutes can reach 60 after rounding (3598 seconds gives 0h 60m). If
 * that is not carried into the hours, "60m" would sit on screen; it would not
 * look wrong, but nobody would trust it as a number.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return '—';
  }

  const total = Math.max(0, Math.round(seconds));
  let hours = Math.floor(total / HOUR);
  let minutes = Math.round((total - hours * HOUR) / 60);

  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }

  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

/**
 * Format of an hours correction: `'+2:00'` / `'−0:30'` (B14, G35).
 *
 * Careful: the sign is the actual information, so it is never dropped, even `+`
 * for positive. With `2:00` alone you could not tell whether hours were added or
 * removed, and the difference is someone's pay.
 *
 * Careful: the Unicode minus (`−`, U+2212), not a hyphen: a hyphen next to a
 * number looks short and the negative sign could slip past the eye.
 *
 * Careful: `formatDuration()` is deliberately not used here: it writes `7h 32m` and
 * drops the hours below an hour. In the corrections list all rows need the same
 * width (`+0:30` beside `+2:00`), so the hour part is always present.
 */
export function formatSignedDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  const hours = Math.floor(abs / 3600);
  let minutes = Math.round((abs % 3600) / 60);
  let carried = hours;

  // Careful: the same trap as `formatDuration()`: 3598 seconds gives `0:60`
  if (minutes === 60) {
    carried += 1;
    minutes = 0;
  }

  return `${seconds < 0 ? '−' : '+'}${carried}:${pad(minutes)}`;
}

/** Seconds to decimal hours, `'7.5'`: for chart axes and comparisons. */
export function formatHours(
  seconds: number | null | undefined,
  digits = 1,
): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return '—';
  }
  return localizeDigits((seconds / HOUR).toFixed(digits));
}

/**
 * Decimal hours to `'7h 32m'`.
 *
 * Careful: the reports API sends hours (`workedHours: 7.53`), the live board sends
 * seconds (`todayWorkedSec`). This bridge is needed to show the same text on both
 * screens. Payroll sends hours as a string (`'7.53'`); that works too.
 */
export function formatHoursAsDuration(
  hours: number | string | null | undefined,
): string {
  if (hours === null || hours === undefined) return '—';
  const value = typeof hours === 'string' ? Number(hours) : hours;
  if (!Number.isFinite(value)) return '—';
  return formatDuration(value * HOUR);
}

/** Decimal hours to seconds: for passing to ProgressRing. */
export function hoursToSeconds(hours: number | string): number {
  const value = typeof hours === 'string' ? Number(hours) : hours;
  return Number.isFinite(value) ? value * HOUR : 0;
}

// ── Percentages, bytes, taka ────────────────────────────────────────────────

/**
 * `null` means no data, not zero (the server's `scorePct` sends exactly this).
 * Writing `0%` would say "was not productive at all", when the truth is "nothing
 * to say"; on a day off the difference changes the whole report.
 */
export function formatPct(
  value: number | null | undefined,
  digits = 0,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return `${localizeDigits(value.toFixed(digits))}%`;
}

/** Progress percentage: 0 if the denominator is zero, not NaN or Infinity. */
export function pctOf(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return (part / whole) * 100;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return '—';
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${localizeDigits(value.toFixed(value < 10 ? 1 : 0))} ${units[unit]}`;
}

/**
 * The currency's symbol — `৳` until the server says otherwise
 * (`GET /auth/currency`, loaded in `main.tsx` before the first render).
 * Only the symbol changes; the number keeps the formatting below.
 */
let currencySymbolValue = '৳';

export function setCurrency(currency: { code: string; symbol: string }): void {
  if (typeof currency.symbol === 'string' && currency.symbol.trim() !== '') {
    currencySymbolValue = currency.symbol.trim();
  }
}

/** For labels such as "Monthly salary (৳)" */
export function currencySymbol(): string {
  return currencySymbolValue;
}

/**
 * Taka: `'13000.50'` to `'৳ 13,000.50'`.
 *
 * The symbol is the configured currency's (`currencySymbol()`); with the
 * default BDT the text is exactly what it always was.
 *
 * Careful: the server sends money as a string (Decimal, not float). No `Number()`
 * arithmetic is done here, only thousands separators are inserted; otherwise
 * 13000.10 would become 13000.0999... on screen.
 *
 * It must not be called on anyone's screen except the owner's (section 4.3, ADR-023).
 */
export function formatTaka(amount: string | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const [whole, fraction] = amount.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currencySymbolValue} ${localizeDigits(`${sign}${grouped}${fraction ? `.${fraction}` : ''}`)}`;
}

/** A plain number, with thousands separators. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return localizeDigits(Math.round(value).toLocaleString('en-US'));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
