# Delivery 4 — Pay-period hours statement: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every pay period (cutoff day configurable) the server takes a snapshot of each hourly person's hours, adds the carry-over from earlier periods, emails it to the finance recipients, and shows it on an Hours statement screen where a new `finance` role marks each line as posted.

**Architecture:** A new `hours-statement/` module. Pure rules decide the periods (`pay-period.rules.ts`), the carry-over ledger (`ledger.rules.ts`), the per-person day counts (`statement.rules.ts`) and the email text (`statement-mail.ts`). `pay_periods` always holds one open period (the anchor); an hourly job snapshots it once its send moment passes, delivers, and opens the next one. The `finance` role is refused by the roles guard everywhere it is not named, except routes marked `@EveryRole()`.

**Tech Stack:** NestJS 11 (`@nestjs/schedule`), Prisma 6, exceljs, vitest; React 19, i18next.

**Spec:** `docs/superpowers/specs/2026-10-09-work-hours-and-pay-period-design.md` § 7 (and § 1a). Index and working rules: `docs/superpowers/plans/2026-10-09-work-hours-index.md`. **Requires Deliveries 1 and 2** (`Mailer`, `MailRecipients`, `MAIL_KINDS`, `mailText`, `hoursAndMinutes`, presence in `credited_sec`).

## Global Constraints

- Default cutoff "end of month" and send time 07:00: a generic install gets calendar-month statements; nothing is emailed while there are no recipients.
- Cutoff day 1–28 or `'end'`. Periods never overlap or leave gaps, even when the cutoff changes (a period starts the day after the previous one ended).
- On the first run nothing is backfilled: the first statement is for the period running when the module first ran.
- No pay rates, salaries or money anywhere in this module, its emails, files or screens. The query that decides who is hourly selects only the pay *basis*.
- Hours to post are whole minutes, rounded down; the leftover seconds and late corrections reach the next statement through the ledger.
- A snapshot is never taken twice for a period; a resend sends the stored snapshot.
- The module is the feature `hoursStatement` (Settings → Modules), on by default.
- Roles: owner and `finance` see the screen; resend and the settings card are owner only; `finance` sees nothing else.
- Generic text; screen and email text in `en`/`pt-BR`/`es` (the spreadsheet stays English like the other reports).
- Branch `feat/hours-statement` off `pericialmed` (after Deliveries 1 and 2 are merged).

## Review Focus

1. Someone switched from monthly to hourly pay mid-year must not get all their earlier hours as "carry-over" — the ledger only covers periods in which they had a line — test in Task 6. (A period that touches both a monthly and an hourly month includes the person for the whole period; the owner can correct the posted value.)
2. The server down at 07:00 on the 26th and back at 15:00: the statement goes out at the 15:10 run, once — test in Task 6.
3. Changing the cutoff from 25 to "end of month" while a period is open stretches that open period instead of skipping or overlapping days — test in Task 1 and Task 7.
4. A `finance` login must get 403 on screens and endpoints not named for it (staff, reports, payroll, screenshots, settings) while still loading the dashboard shell (`/auth/me`, `/features`, account) — test in Task 3.
5. A line marked "posted" can be undone until the next period's snapshot, then it is locked (409) — test in Task 6.

---

### Task 1: Pay periods (pure)

**Files:**
- Create: `oxeio-monitor/server/src/hours-statement/pay-period.rules.ts`
- Test: `oxeio-monitor/server/test/pay-period.rules.spec.ts`

**Interfaces:**
- Produces:
  - `PAY_PERIOD_SETTING_KEY = 'payPeriod'`
  - `type CutoffDay = number | 'end'`; `interface PayPeriodConfig { cutoffDay: CutoffDay; sendTime: string }`; `DEFAULT_PAY_PERIOD`
  - `resolvePayPeriod(saved: Partial<PayPeriodConfig> | null): PayPeriodConfig`
  - `payPeriodProblem(input: { cutoffDay: unknown; sendTime: unknown }): string | null`
  - `interface PeriodRange { start: string; end: string }` (`YYYY-MM-DD`, inclusive)
  - `addDays(date: string, n: number): string`
  - `cutoffOnOrAfter(date: string, cutoff: CutoffDay): string`
  - `periodHolding(date: string, cutoff: CutoffDay): PeriodRange`
  - `periodAfter(lastEnd: string, cutoff: CutoffDay): PeriodRange`
  - `isDue(end: string, today: string, nowMin: number, sendTime: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// oxeio-monitor/server/test/pay-period.rules.spec.ts
import { describe, expect, it } from 'vitest';

import {
  addDays,
  cutoffOnOrAfter,
  isDue,
  payPeriodProblem,
  periodAfter,
  periodHolding,
  resolvePayPeriod,
} from '../src/hours-statement/pay-period.rules';

describe('resolvePayPeriod', () => {
  it('defaults: calendar month, 07:00', () => {
    expect(resolvePayPeriod(null)).toEqual({ cutoffDay: 'end', sendTime: '07:00' });
  });
  it('keeps valid saved values, drops broken ones', () => {
    expect(resolvePayPeriod({ cutoffDay: 25, sendTime: '06:30' })).toEqual({ cutoffDay: 25, sendTime: '06:30' });
    expect(resolvePayPeriod({ cutoffDay: 31 as number, sendTime: '7h' })).toEqual({ cutoffDay: 'end', sendTime: '07:00' });
  });
});

describe('payPeriodProblem', () => {
  it('cutoff 1–28 or end; time HH:MM', () => {
    expect(payPeriodProblem({ cutoffDay: 25, sendTime: '07:00' })).toBeNull();
    expect(payPeriodProblem({ cutoffDay: 'end', sendTime: '23:59' })).toBeNull();
    expect(payPeriodProblem({ cutoffDay: 29, sendTime: '07:00' })).toMatch(/28/);
    expect(payPeriodProblem({ cutoffDay: 0, sendTime: '07:00' })).toMatch(/28/);
    expect(payPeriodProblem({ cutoffDay: 25, sendTime: '24:00' })).toMatch(/HH:MM/);
  });
});

describe('dates', () => {
  it('addDays crosses months and years', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('cutoffOnOrAfter', () => {
    expect(cutoffOnOrAfter('2026-10-09', 25)).toBe('2026-10-25');
    expect(cutoffOnOrAfter('2026-10-25', 25)).toBe('2026-10-25');
    expect(cutoffOnOrAfter('2026-10-26', 25)).toBe('2026-11-25');
    expect(cutoffOnOrAfter('2026-12-26', 25)).toBe('2027-01-25');
    expect(cutoffOnOrAfter('2028-02-10', 'end')).toBe('2028-02-29');
  });
});

describe('periods', () => {
  it('the period holding a day, cutoff 25', () => {
    expect(periodHolding('2026-10-09', 25)).toEqual({ start: '2026-09-26', end: '2026-10-25' });
    expect(periodHolding('2026-10-26', 25)).toEqual({ start: '2026-10-26', end: '2026-11-25' });
    expect(periodHolding('2026-01-10', 25)).toEqual({ start: '2025-12-26', end: '2026-01-25' });
  });
  it('end of month is the calendar month', () => {
    expect(periodHolding('2026-02-10', 'end')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
  it('the next period starts the day after, even when the cutoff changed', () => {
    expect(periodAfter('2026-10-25', 25)).toEqual({ start: '2026-10-26', end: '2026-11-25' });
    expect(periodAfter('2026-10-25', 'end')).toEqual({ start: '2026-10-26', end: '2026-10-31' });
    expect(periodAfter('2026-10-31', 25)).toEqual({ start: '2026-11-01', end: '2026-11-25' });
  });
});

describe('isDue — the day after the end, at the send time', () => {
  const end = '2026-10-25';
  it('not on the last day, not before the time', () => {
    expect(isDue(end, '2026-10-25', 23 * 60, '07:00')).toBe(false);
    expect(isDue(end, '2026-10-26', 6 * 60 + 59, '07:00')).toBe(false);
  });
  it('from the time on, and any later day (server was down)', () => {
    expect(isDue(end, '2026-10-26', 7 * 60, '07:00')).toBe(true);
    expect(isDue(end, '2026-10-26', 15 * 60 + 10, '07:00')).toBe(true);
    expect(isDue(end, '2026-11-02', 0, '07:00')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `oxeio-monitor/server`): `npm test -- test/pay-period.rules.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// oxeio-monitor/server/src/hours-statement/pay-period.rules.ts
/**
 * Pay periods — pure rules on calendar dates (`YYYY-MM-DD`, work-zone dates).
 *
 * A period runs from the day after one cutoff to the next cutoff, inclusive:
 * with cutoff 25, 26 September – 25 October. "end" means the last day of the
 * month (the calendar month). A period always starts the day after the
 * previous one ended, so changing the cutoff never skips or repeats a day —
 * the period after the change is simply shorter or longer.
 *
 * The statement goes out the day after the cutoff at the send time, once that
 * day's hours are complete.
 */

export const PAY_PERIOD_SETTING_KEY = 'payPeriod';

export type CutoffDay = number | 'end';

export interface PayPeriodConfig {
  cutoffDay: CutoffDay;
  /** 'HH:MM', work zone */
  sendTime: string;
}

export const DEFAULT_PAY_PERIOD: PayPeriodConfig = { cutoffDay: 'end', sendTime: '07:00' };

export interface PeriodRange {
  start: string;
  end: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

function validCutoff(value: unknown): value is CutoffDay {
  return value === 'end' || (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 28);
}

export function resolvePayPeriod(saved: Partial<PayPeriodConfig> | null): PayPeriodConfig {
  return {
    cutoffDay: validCutoff(saved?.cutoffDay) ? saved.cutoffDay : DEFAULT_PAY_PERIOD.cutoffDay,
    sendTime: typeof saved?.sendTime === 'string' && HHMM.test(saved.sendTime) ? saved.sendTime : DEFAULT_PAY_PERIOD.sendTime,
  };
}

export function payPeriodProblem(input: { cutoffDay: unknown; sendTime: unknown }): string | null {
  if (!validCutoff(input.cutoffDay)) return 'The cutoff day must be from 1 to 28, or the end of the month';
  if (typeof input.sendTime !== 'string' || !HHMM.test(input.sendTime)) return "The send time must be in 'HH:MM' format";
  return null;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function shiftMonth(yearMonth: string, by: number): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function cutoffIn(yearMonth: string, cutoff: CutoffDay): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const day = cutoff === 'end' ? new Date(Date.UTC(y, m, 0)).getUTCDate() : cutoff;
  return `${yearMonth}-${String(day).padStart(2, '0')}`;
}

export function cutoffOnOrAfter(date: string, cutoff: CutoffDay): string {
  const here = cutoffIn(date.slice(0, 7), cutoff);
  return here >= date ? here : cutoffIn(shiftMonth(date.slice(0, 7), 1), cutoff);
}

/** The period holding `date` — used only for the very first period */
export function periodHolding(date: string, cutoff: CutoffDay): PeriodRange {
  const end = cutoffOnOrAfter(date, cutoff);
  const previous = cutoffIn(shiftMonth(end.slice(0, 7), -1), cutoff);
  return { start: addDays(previous, 1), end };
}

/** The period after one that ended on `lastEnd` */
export function periodAfter(lastEnd: string, cutoff: CutoffDay): PeriodRange {
  const start = addDays(lastEnd, 1);
  return { start, end: cutoffOnOrAfter(start, cutoff) };
}

/** `today` and `nowMin` (minutes since midnight) are the work zone's */
export function isDue(end: string, today: string, nowMin: number, sendTime: string): boolean {
  const sendDay = addDays(end, 1);
  if (today !== sendDay) return today > sendDay;
  const [h, m] = sendTime.split(':').map(Number);
  return nowMin >= h * 60 + m;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/pay-period.rules.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add oxeio-monitor/server/src/hours-statement/pay-period.rules.ts oxeio-monitor/server/test/pay-period.rules.spec.ts
git commit -m "feat(server): pay period rules — cutoff day, no gaps, send the day after"
```

---

### Task 2: The ledger and the per-person counts (pure)

**Files:**
- Create: `oxeio-monitor/server/src/hours-statement/ledger.rules.ts`, `oxeio-monitor/server/src/hours-statement/statement.rules.ts`
- Test: `oxeio-monitor/server/test/ledger.rules.spec.ts`, `oxeio-monitor/server/test/statement.rules.spec.ts`

**Interfaces:**
- Consumes: `payTermsForMonth`, `PayTermsSlice` (`payroll/payroll.math.ts`), `addDays` (Task 1).
- Produces:
  - `statementLine(input: { measuredSec: number; earlierRealSec: number; earlierPostedMin: number }): { carryInSec: number; toPostMin: number }`
  - `monthsTouched(range: PeriodRange): string[]`
  - `hourlyInPeriod(months: readonly string[], currentBasis: PayBasisName, slices: readonly { throughMonth: string; payBasis: PayBasisName }[]): boolean` with `type PayBasisName = 'monthly' | 'hourly' | 'none'`
  - `employedRange(range: PeriodRange, joinedOn: string | null, leftOn: string | null): PeriodRange | null`
  - `countDays(input: { from: string; to: string; offDays: readonly number[]; holidays: ReadonlySet<string>; leaves: ReadonlySet<string>; creditedByDate: ReadonlyMap<string, number> }): { leaveDays: number; holidayDays: number; noDataDays: number }`

- [ ] **Step 1: Write the failing tests**

```ts
// oxeio-monitor/server/test/ledger.rules.spec.ts
import { describe, expect, it } from 'vitest';

import { statementLine } from '../src/hours-statement/ledger.rules';

/**
 * The carry-over is a running ledger: what was really worked in every earlier
 * statement (as it stands now) minus what was posted for them. Each case
 * chains statements the way the job would.
 */
describe('statementLine', () => {
  it('first statement: no carry, whole minutes rounded down', () => {
    expect(statementLine({ measuredSec: 55_820, earlierRealSec: 0, earlierPostedMin: 0 })).toEqual({ carryInSec: 0, toPostMin: 930 });
  });

  it('leftover seconds are never lost', () => {
    // P1: 100 s → 1 min posted; P2: 0 s; P3: 30 s
    const p1 = statementLine({ measuredSec: 100, earlierRealSec: 0, earlierPostedMin: 0 });
    const p2 = statementLine({ measuredSec: 0, earlierRealSec: 100, earlierPostedMin: p1.toPostMin });
    const p3 = statementLine({ measuredSec: 30, earlierRealSec: 100, earlierPostedMin: p1.toPostMin + p2.toPostMin });
    expect([p1.toPostMin, p2.toPostMin, p3.toPostMin]).toEqual([1, 0, 1]);
    expect(p3.carryInSec).toBe(40);
  });

  it('a late correction to an earlier period shows up once', () => {
    const p1 = statementLine({ measuredSec: 36_000, earlierRealSec: 0, earlierPostedMin: 0 }); // 600 min
    // an hour was added to a P1 day after it was sent
    const p2 = statementLine({ measuredSec: 7_200, earlierRealSec: 39_600, earlierPostedMin: p1.toPostMin });
    expect(p2).toEqual({ carryInSec: 3_600, toPostMin: 180 });
    const p3 = statementLine({ measuredSec: 0, earlierRealSec: 39_600 + 7_200, earlierPostedMin: p1.toPostMin + p2.toPostMin });
    expect(p3).toEqual({ carryInSec: 0, toPostMin: 0 });
  });

  it('a posted value different from the proposal is corrected next time', () => {
    // 600 proposed, 590 posted
    const p2 = statementLine({ measuredSec: 0, earlierRealSec: 36_000, earlierPostedMin: 590 });
    expect(p2).toEqual({ carryInSec: 600, toPostMin: 10 });
  });

  it('a correction larger than the new period gives a negative result', () => {
    const p2 = statementLine({ measuredSec: 600, earlierRealSec: 36_000 - 3_600, earlierPostedMin: 600 });
    expect(p2).toEqual({ carryInSec: -3_600, toPostMin: -50 });
  });
});
```

```ts
// oxeio-monitor/server/test/statement.rules.spec.ts
import { describe, expect, it } from 'vitest';

import { countDays, employedRange, hourlyInPeriod, monthsTouched } from '../src/hours-statement/statement.rules';

describe('monthsTouched', () => {
  it('the months a period crosses', () => {
    expect(monthsTouched({ start: '2026-09-26', end: '2026-10-25' })).toEqual(['2026-09', '2026-10']);
    expect(monthsTouched({ start: '2026-10-01', end: '2026-10-31' })).toEqual(['2026-10']);
  });
});

describe('hourlyInPeriod — from the pay terms history, basis only', () => {
  it('hourly now and no history', () => {
    expect(hourlyInPeriod(['2026-09', '2026-10'], 'hourly', [])).toBe(true);
  });
  it('monthly until September, hourly from October: in the 26/09–25/10 period', () => {
    expect(hourlyInPeriod(['2026-09', '2026-10'], 'hourly', [{ throughMonth: '2026-09', payBasis: 'monthly' }])).toBe(true);
  });
  it('hourly until August, monthly since: not in the September–October period', () => {
    expect(hourlyInPeriod(['2026-09', '2026-10'], 'monthly', [{ throughMonth: '2026-08', payBasis: 'hourly' }])).toBe(false);
  });
});

describe('employedRange', () => {
  const range = { start: '2026-09-26', end: '2026-10-25' };
  it('cut at joining and leaving', () => {
    expect(employedRange(range, '2026-10-01', null)).toEqual({ start: '2026-10-01', end: '2026-10-25' });
    expect(employedRange(range, null, '2026-10-10')).toEqual({ start: '2026-09-26', end: '2026-10-10' });
  });
  it('not employed in the period: null', () => {
    expect(employedRange(range, '2026-11-01', null)).toBeNull();
    expect(employedRange(range, null, '2026-09-20')).toBeNull();
  });
});

describe('countDays', () => {
  it('leave, holidays and workdays with nothing recorded; days off ignored', () => {
    // 2026-10-05 Mon … 2026-10-11 Sun; Sat+Sun off
    const counts = countDays({
      from: '2026-10-05',
      to: '2026-10-11',
      offDays: [6, 7],
      holidays: new Set(['2026-10-07']),
      leaves: new Set(['2026-10-08']),
      creditedByDate: new Map([['2026-10-05', 28_800], ['2026-10-06', 0]]),
    });
    // Mon worked; Tue 0 → no data; Wed holiday; Thu leave; Fri nothing → no data
    expect(counts).toEqual({ leaveDays: 1, holidayDays: 1, noDataDays: 2 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- test/ledger.rules.spec.ts test/statement.rules.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// oxeio-monitor/server/src/hours-statement/ledger.rules.ts
/**
 * The hours to post for one person in one statement — a running ledger.
 *
 *   carry-in = (credited time, as it stands now, over every earlier statement
 *               line of this person) − (minutes posted for those lines × 60)
 *   to post  = (measured in this period + carry-in), whole minutes, rounded down
 *
 * So a correction to any earlier day, the seconds dropped by rounding, and a
 * posted value different from the proposal all surface exactly once, in the
 * next statement. "Posted" is the value recorded on the screen, or the
 * proposal when nothing different was recorded.
 */
export function statementLine(input: {
  measuredSec: number;
  earlierRealSec: number;
  earlierPostedMin: number;
}): { carryInSec: number; toPostMin: number } {
  const carryInSec = input.earlierRealSec - input.earlierPostedMin * 60;
  return { carryInSec, toPostMin: Math.floor((input.measuredSec + carryInSec) / 60) };
}
```

```ts
// oxeio-monitor/server/src/hours-statement/statement.rules.ts
import { payTermsForMonth } from '../payroll/payroll.math';
import { addDays, type PeriodRange } from './pay-period.rules';

export type PayBasisName = 'monthly' | 'hourly' | 'none';

export function monthsTouched(range: PeriodRange): string[] {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) {
    const month = d.slice(0, 7);
    if (out[out.length - 1] !== month) out.push(month);
  }
  return out;
}

/**
 * Paid by the hour in any month the period touches. Reads the basis only:
 * this module never selects an amount.
 */
export function hourlyInPeriod(
  months: readonly string[],
  currentBasis: PayBasisName,
  slices: readonly { throughMonth: string; payBasis: PayBasisName }[],
): boolean {
  const current = { payBasis: currentBasis, monthlySalary: null, hourlyRate: null };
  const history = slices.map((s) => ({ ...s, monthlySalary: null, hourlyRate: null }));
  return months.some((month) => payTermsForMonth(month, current, history).payBasis === 'hourly');
}

export function employedRange(range: PeriodRange, joinedOn: string | null, leftOn: string | null): PeriodRange | null {
  const start = joinedOn && joinedOn > range.start ? joinedOn : range.start;
  const end = leftOn && leftOn < range.end ? leftOn : range.end;
  return start <= end ? { start, end } : null;
}

/** ISO weekday of a 'YYYY-MM-DD' date: Mon = 1 … Sun = 7 */
function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function countDays(input: {
  from: string;
  to: string;
  offDays: readonly number[];
  holidays: ReadonlySet<string>;
  leaves: ReadonlySet<string>;
  creditedByDate: ReadonlyMap<string, number>;
}): { leaveDays: number; holidayDays: number; noDataDays: number } {
  let leaveDays = 0;
  let holidayDays = 0;
  let noDataDays = 0;
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) {
    if (input.offDays.includes(isoWeekday(d))) continue;
    if (input.holidays.has(d)) holidayDays += 1;
    else if (input.leaves.has(d)) leaveDays += 1;
    else if ((input.creditedByDate.get(d) ?? 0) <= 0) noDataDays += 1;
  }
  return { leaveDays, holidayDays, noDataDays };
}
```

Check `payTermsForMonth`'s parameter types in `payroll/payroll.math.ts` (`PayTerms`, `PayTermsSlice` use `string | null` amounts) — the `null` amounts above satisfy them.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/ledger.rules.spec.ts test/statement.rules.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add oxeio-monitor/server/src/hours-statement oxeio-monitor/server/test/ledger.rules.spec.ts oxeio-monitor/server/test/statement.rules.spec.ts
git commit -m "feat(server): hours statement ledger and per-person day counts"
```

---

### Task 3: The `finance` role

**Files:**
- Create: `oxeio-monitor/server/prisma/migrations/20261014120000_finance_role/migration.sql`
- Modify: `oxeio-monitor/server/prisma/schema.prisma` (`enum UserRole`)
- Modify: `oxeio-monitor/server/src/auth/decorators.ts` (`EveryRole`), `auth/guards/roles.guard.ts`
- Modify: `oxeio-monitor/server/src/auth/auth.controller.ts`, `auth/account.controller.ts`, `features/features.controller.ts`, `error-reporting/error-reporting.controller.ts` (`@EveryRole()` where noted)
- Modify: `oxeio-monitor/server/src/staff/users.controller.ts` (`ChangeRoleDto`), `auth/auth.service.ts` (role parameter type)
- Test: `oxeio-monitor/server/test/finance-role.e2e.spec.ts`

**Interfaces:**
- Produces:
  - `UserRole.finance`
  - `EVERY_ROLE = 'oxeio:everyRole'`, `EveryRole(): MethodDecorator & ClassDecorator`
  - Guard rule: a route with no `@Roles` stays open to owner/manager/coordinator/employee as today, but refuses `finance` unless it (or its class) carries `@EveryRole()`; a route with `@Roles(...)` admits `finance` only if listed.

- [ ] **Step 1: Migration and enum**

```sql
-- oxeio-monitor/server/prisma/migrations/20261014120000_finance_role/migration.sql
-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'finance';
```

In `schema.prisma`, add to `enum UserRole` (after `employee`), with a comment:

```prisma
  /// Finance: the hours statement only (posting hours into the payroll system); nothing else
  finance
```

Run `npx prisma generate`.

- [ ] **Step 2: Write the failing e2e test**

```ts
// oxeio-monitor/server/test/finance-role.e2e.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createEmployeeWithCode,
  createHarness,
  hashPassword,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

let h: Harness;
let finance: Session;
const PASSWORD = 'finance-password-123';

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  const { employeeId } = await createEmployeeWithCode(h.prisma, 'FIN-1');
  await h.prisma.user.create({
    data: { email: 'finance@test.local', passwordHash: await hashPassword(PASSWORD), fullName: 'Finance Person', role: 'finance', employeeId, mustChangePw: false },
  });
  finance = await loginReady(h, 'finance@test.local', PASSWORD);
});

describe('the finance role', () => {
  it('loads the dashboard shell', async () => {
    for (const path of ['/auth/me', '/auth/time-zone', '/auth/currency', '/account', '/features']) {
      const res = await finance.http.get(`/api/v1${path}`);
      expect(res.status, path).toBe(200);
    }
  });

  it('is refused everywhere else', async () => {
    const refused = [
      '/me',
      '/employees',
      '/work-policies',
      '/payroll?month=2026-10',
      '/reports/attendance?from=2026-10-01&to=2026-10-02',
      '/screenshots/latest',
      '/alerts',
      '/settings/smtp',
      '/settings/region',
      '/audit-log',
    ];
    for (const path of refused) {
      const res = await finance.http.get(`/api/v1${path}`);
      expect(res.status, path).toBe(403);
    }
  });

  it('the owner can make a portal login finance', async () => {
    const owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
    const user = await h.prisma.user.findUniqueOrThrow({ where: { email: 'finance@test.local' } });
    await h.prisma.user.update({ where: { id: user.id }, data: { role: 'employee' } });
    const res = await owner.http.patch(`/api/v1/users/${user.id}/role`).set('X-CSRF-Token', owner.csrf).send({ role: 'finance' }).expect(200);
    expect(res.body.role).toBe('finance');
  });
});
```

Before running, check each path in the `refused` list exists (grep the `@Controller`/`@Get` decorators): a 404 there would mean a wrong path, not a passing guard. Replace any path that does not exist with a real GET route of the same module.

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- test/finance-role.e2e.spec.ts`
Expected: FAIL — several "refused" paths answer 200 (routes without `@Roles`), and the role change answers 400.

- [ ] **Step 4: Implement the guard rule**

In `auth/decorators.ts`:

```ts
export const EVERY_ROLE = 'oxeio:everyRole';

/**
 * Open to every signed-in role, `finance` included. Finance is refused on any
 * route that neither lists it in `@Roles` nor carries this: a new route stays
 * closed to it by default.
 */
export const EveryRole = (): MethodDecorator & ClassDecorator =>
  SetMetadata(EVERY_ROLE, true);
```

In `auth/guards/roles.guard.ts`, replace `if (!required || required.length === 0) return true;` and the request lookup with:

```ts
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    if (!required || required.length === 0) {
      // finance sees the hours statement and its own account, nothing else
      if (req.user?.role === 'finance') {
        const open = this.reflector.getAllAndOverride<boolean>(EVERY_ROLE, [ctx.getHandler(), ctx.getClass()]);
        if (!open) throw new ForbiddenException("You don't have access to this action");
      }
      return true;
    }

    if (!req.user || !required.includes(req.user.role)) {
      throw new ForbiddenException("You don't have access to this action");
    }
    return true;
```

(import `EVERY_ROLE` from `'../decorators'`; update the class comment to mention finance.)

Mark with `@EveryRole()` at class level: `AuthController` (`auth/auth.controller.ts`), `AccountController` (`auth/account.controller.ts`), and the `FeaturesController` (`features/features.controller.ts` — its owner routes keep their method-level `@Roles(owner)`, which wins). On `ErrorReportingController`, put `@EveryRole()` on the `@Post('error-reports')` method only (browser crash reports).

In `staff/users.controller.ts`, `ChangeRoleDto`: `@IsIn(['employee', 'coordinator', 'manager', 'finance'])` and the type `'employee' | 'coordinator' | 'manager' | 'finance'`; widen the same union in `auth/auth.service.ts` (the `role:` parameter near line 386) and wherever TypeScript then complains.

Also search for hand-written role checks that would open the wrong way for a new role (the `UserRole` enum comment warns about `role !== employee`):

Run: `grep -rn "role !== 'employee'\|role !== UserRole.employee\|role === 'employee'" oxeio-monitor/server/src`
For each hit, decide whether `finance` should behave like staff there; most are scope rules for owner/manager and need `|| role === 'finance'` on the restrictive side. Note each decision in the commit message.

- [ ] **Step 5: Run tests**

Run: `npm test -- test/finance-role.e2e.spec.ts test/change-role.e2e.spec.ts test/auth.e2e.spec.ts test/account.e2e.spec.ts test/endpoints.e2e.spec.ts test/module-switches.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A oxeio-monitor/server
git commit -m "feat(server): finance role — refused everywhere it is not named"
```

---

### Task 4: Tables, recipients and the module switch

**Files:**
- Create: `oxeio-monitor/server/prisma/migrations/20261014120100_pay_periods/migration.sql`
- Modify: `oxeio-monitor/server/prisma/schema.prisma` (`enum StatementDelivery`, `PayPeriod`, `PayPeriodLine`, relations on `Employee` and `User`)
- Modify: `oxeio-monitor/server/test/setup/harness.ts` (truncate `pay_period_lines`, `pay_periods`)
- Modify: `oxeio-monitor/server/src/mail/recipients.rules.ts`, `mail/recipients.service.ts` (kind `hoursStatement`)
- Modify: `oxeio-monitor/server/src/features/features.rules.ts` (`hoursStatement`)
- Modify: `oxeio-monitor/server/src/alerts/alerts.constants.ts` (`statement_delivery_failed`) and every place `backup_failed` is listed
- Test: `oxeio-monitor/server/test/recipients.rules.spec.ts` (add cases), `oxeio-monitor/server/test/features.rules.spec.ts` (add a case if it lists keys)

**Interfaces:**
- Produces:
  - Prisma `StatementDelivery` = `pending | sent | failed | no_recipients | not_configured | no_staff`
  - Prisma `PayPeriod` (`pay_periods`): `id`, `startDate` (unique, Date), `endDate` (Date), `snapshotAt?`, `deliveryStatus?`, `deliveryError?`, `deliveryAttempts` (default 0), `sentAt?`, `createdAt`, `lines`
  - Prisma `PayPeriodLine` (`pay_period_lines`): `id`, `periodId`, `employeeId`, `fromDate`, `toDate`, `measuredSec`, `carryInSec`, `toPostMin`, `leaveDays`, `holidayDays`, `noDataDays`, `postedMin?`, `postedAt?`, `postedById?`, `note?`; unique `(periodId, employeeId)`
  - `MAIL_KINDS` gains `'hoursStatement'`; `ENV_FALLBACK.hoursStatement = null`; `RecipientsInput.finance?: readonly string[]`
  - `FEATURE_KEYS` gains `'hoursStatement'`
  - `AlertType` gains `'statement_delivery_failed'`

- [ ] **Step 1: Schema and migration**

```prisma
/// What happened to a pay period's statement email
enum StatementDelivery {
  pending
  sent
  failed
  /// no finance login and no extra address
  no_recipients
  /// SMTP not set up
  not_configured
  /// nobody was paid by the hour in the period
  no_staff
}

/// A pay period (src/hours-statement/). The newest row is the open period; a snapshot freezes
/// its lines and the next period opens the day after its end.
model PayPeriod {
  id               Int                @id @default(autoincrement())
  startDate        DateTime           @unique @map("start_date") @db.Date
  endDate          DateTime           @map("end_date") @db.Date
  /// when the lines were frozen; null = the open period
  snapshotAt       DateTime?          @map("snapshot_at") @db.Timestamptz(3)
  deliveryStatus   StatementDelivery? @map("delivery_status")
  deliveryError    String?            @map("delivery_error")
  deliveryAttempts Int                @default(0) @map("delivery_attempts")
  sentAt           DateTime?          @map("sent_at") @db.Timestamptz(3)
  createdAt        DateTime           @default(now()) @map("created_at") @db.Timestamptz(3)

  lines PayPeriodLine[]

  @@map("pay_periods")
}

/// One hourly person in a frozen pay period. Hours only — never money.
model PayPeriodLine {
  id          Int       @id @default(autoincrement())
  periodId    Int       @map("period_id")
  employeeId  Int       @map("employee_id")
  /// the period cut at joining/leaving
  fromDate    DateTime  @map("from_date") @db.Date
  toDate      DateTime  @map("to_date") @db.Date
  /// credited seconds inside the range when frozen
  measuredSec Int       @map("measured_sec")
  /// from the ledger: earlier real time − earlier posted (src/hours-statement/ledger.rules.ts)
  carryInSec  Int       @map("carry_in_sec")
  toPostMin   Int       @map("to_post_min")
  leaveDays   Int       @default(0) @map("leave_days")
  holidayDays Int       @default(0) @map("holiday_days")
  noDataDays  Int       @default(0) @map("no_data_days")
  /// what was actually posted, when different from to_post_min; null = as proposed
  postedMin   Int?      @map("posted_min")
  postedAt    DateTime? @map("posted_at") @db.Timestamptz(3)
  postedById  Int?      @map("posted_by_id")
  note        String?

  period   PayPeriod @relation(fields: [periodId], references: [id], onDelete: Cascade)
  employee Employee  @relation(fields: [employeeId], references: [id])
  postedBy User?     @relation("PayLinePostedBy", fields: [postedById], references: [id])

  @@unique([periodId, employeeId])
  @@index([employeeId])
  @@map("pay_period_lines")
}
```

Add `payPeriodLines PayPeriodLine[]` to `Employee` and `payLinesPosted PayPeriodLine[] @relation("PayLinePostedBy")` to `User`.

```sql
-- oxeio-monitor/server/prisma/migrations/20261014120100_pay_periods/migration.sql
-- CreateEnum
CREATE TYPE "StatementDelivery" AS ENUM ('pending', 'sent', 'failed', 'no_recipients', 'not_configured', 'no_staff');

-- CreateTable
CREATE TABLE "pay_periods" (
    "id" SERIAL NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "snapshot_at" TIMESTAMPTZ(3),
    "delivery_status" "StatementDelivery",
    "delivery_error" TEXT,
    "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_period_lines" (
    "id" SERIAL NOT NULL,
    "period_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "measured_sec" INTEGER NOT NULL,
    "carry_in_sec" INTEGER NOT NULL,
    "to_post_min" INTEGER NOT NULL,
    "leave_days" INTEGER NOT NULL DEFAULT 0,
    "holiday_days" INTEGER NOT NULL DEFAULT 0,
    "no_data_days" INTEGER NOT NULL DEFAULT 0,
    "posted_min" INTEGER,
    "posted_at" TIMESTAMPTZ(3),
    "posted_by_id" INTEGER,
    "note" TEXT,

    CONSTRAINT "pay_period_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pay_periods_start_date_key" ON "pay_periods"("start_date");
CREATE INDEX "pay_period_lines_employee_id_idx" ON "pay_period_lines"("employee_id");
CREATE UNIQUE INDEX "pay_period_lines_period_id_employee_id_key" ON "pay_period_lines"("period_id", "employee_id");

-- AddForeignKey
ALTER TABLE "pay_period_lines" ADD CONSTRAINT "pay_period_lines_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "pay_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pay_period_lines" ADD CONSTRAINT "pay_period_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pay_period_lines" ADD CONSTRAINT "pay_period_lines_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

Run `npx prisma generate`. Add `pay_period_lines, pay_periods` to the `TRUNCATE` list in `test/setup/harness.ts`.

- [ ] **Step 2: Failing recipient cases** — append to `test/recipients.rules.spec.ts`:

```ts
describe('recipientsFor — hours statement', () => {
  it('finance logins plus the saved extras; never the owners, never an env list', () => {
    expect(
      recipientsFor({
        kind: 'hoursStatement',
        saved: { hoursStatement: ['books@x.test', 'FIN@x.test'] },
        env: { DIGEST_EMAIL_TO: 'boss@x.test' },
        owners: ['owner@x.test'],
        finance: ['fin@x.test'],
      }),
    ).toEqual(['fin@x.test', 'books@x.test']);
  });
  it('nobody set up: nobody', () => {
    expect(recipientsFor({ kind: 'hoursStatement', saved: null, env: {}, owners: ['owner@x.test'] })).toEqual([]);
  });
});
```

Run: `npm test -- test/recipients.rules.spec.ts` — Expected: FAIL (`hoursStatement` not a kind).

- [ ] **Step 3: Implement the recipients change**

In `mail/recipients.rules.ts`:

```ts
export const MAIL_KINDS = ['alerts', 'dailyDigest', 'weeklyDigest', 'monthClosed', 'hoursStatement'] as const;

/** null = no environment fallback (the kind is newer than the env variables) */
export const ENV_FALLBACK: Record<MailKind, 'ALERT_EMAIL_TO' | 'DIGEST_EMAIL_TO' | null> = {
  alerts: 'ALERT_EMAIL_TO',
  dailyDigest: 'DIGEST_EMAIL_TO',
  weeklyDigest: 'DIGEST_EMAIL_TO',
  monthClosed: 'DIGEST_EMAIL_TO',
  hoursStatement: null,
};
```

`RecipientsInput` gains `/** active finance logins (used by the hours statement only) */ finance?: readonly string[];` and `recipientsFor` starts with:

```ts
  // the hours statement is for finance: their logins plus any extra address, and nobody else
  if (input.kind === 'hoursStatement') {
    return cleanAddresses([...(input.finance ?? []), ...(input.saved?.hoursStatement ?? [])]);
  }
```

and the env step becomes `const variable = ENV_FALLBACK[input.kind]; const fromEnv = variable ? splitList(input.env[variable]) : [];`.

In `MailRecipients.for()`: also query `role: 'finance', isActive: true` emails and pass them as `finance`. In `MailRecipientsController.read()`, `envVariable` may now be `null` (type `string | null`).

- [ ] **Step 4: Module switch and alert type**

- `features/features.rules.ts`: add `'hoursStatement'` to `FEATURE_KEYS` (no parent: it does not need Payroll, finance must not need salaries).
- `alerts/alerts.constants.ts`: add `'statement_delivery_failed'` to `AlertType` and `ALERT_TYPE_VALUES`.
- Run `grep -rn "backup_failed" oxeio-monitor/server/src oxeio-monitor/web/src` and add the new type next to each exhaustive list or label map (e.g. the Telegram label allowlist in `ops/ops.rules.ts`, `web/src/api/alerts.ts` labels: `statement_delivery_failed: 'Hours statement not sent'`).

- [ ] **Step 5: Run tests**

Run: `npm test -- test/recipients.rules.spec.ts test/mail-recipients.e2e.spec.ts test/features.rules.spec.ts test/module-switches.e2e.spec.ts test/alerts.rules.spec.ts`
Expected: PASS (update any test that asserts the exact list of feature keys or alert types).

- [ ] **Step 6: Commit**

```bash
git add -A oxeio-monitor/server oxeio-monitor/web/src/api/alerts.ts
git commit -m "feat(server): pay period tables, hours statement recipients, module switch"
```

---

### Task 5: Email text and the spreadsheet (pure)

**Files:**
- Modify: `oxeio-monitor/server/src/mail/mail-text.ts` (statement keys, `formatDay`)
- Create: `oxeio-monitor/server/src/hours-statement/statement-mail.ts`, `oxeio-monitor/server/src/hours-statement/statement-sheet.ts`
- Test: `oxeio-monitor/server/test/statement-mail.spec.ts`

**Interfaces:**
- Consumes: `mailText`, `hoursAndMinutes`, `MAIL_CATALOG` (Delivery 1); `sheetOf`, `buildWorkbook`, `NUM_FMT_2` (`reports/reports.excel.ts`).
- Produces:
  - `formatDay(date: string, lang: Language): string` (`'26/09/2026'` in pt-BR and es, `'26 Sep 2026'` in en)
  - `interface StatementMailLine { fullName: string; empCode: string; toPostMin: number; carryInSec: number; leaveDays: number; holidayDays: number; noDataDays: number }`
  - `statementMail(input: { lang: Language; org: string; start: string; end: string; lines: readonly StatementMailLine[]; link: string | null }): { subject: string; text: string; html: string }`
  - `interface StatementDayRow { fullName: string; empCode: string; date: string; arrived: string | null; left: string | null; presenceHours: number; activeHours: number; adjustmentHours: number; creditedHours: number }`
  - `statementWorkbook(input: { start: string; end: string; lines: readonly (StatementMailLine & { fromDate: string; toDate: string; measuredSec: number })[]; days: readonly StatementDayRow[] }): Promise<Buffer>`

- [ ] **Step 1: Write the failing test**

```ts
// oxeio-monitor/server/test/statement-mail.spec.ts
import { describe, expect, it } from 'vitest';

import { formatDay } from '../src/mail/mail-text';
import { statementMail } from '../src/hours-statement/statement-mail';
import { statementWorkbook } from '../src/hours-statement/statement-sheet';

const lines = [
  { fullName: 'Ana <Lima>', empCode: 'A1', toPostMin: 10_405, carryInSec: 3_600, leaveDays: 1, holidayDays: 0, noDataDays: 0 },
  { fullName: 'Bo', empCode: 'B2', toPostMin: -50, carryInSec: -3_600, leaveDays: 0, holidayDays: 1, noDataDays: 2 },
];

describe('formatDay', () => {
  it('day first in pt-BR and es', () => {
    expect(formatDay('2026-09-26', 'pt-BR')).toBe('26/09/2026');
    expect(formatDay('2026-09-26', 'es')).toBe('26/09/2026');
  });
});

describe('statementMail', () => {
  const mail = statementMail({ lang: 'pt-BR', org: 'Acme', start: '2026-09-26', end: '2026-10-25', lines, link: 'https://app.example/hours?period=3' });

  it('subject names the company and the dates', () => {
    expect(mail.subject).toBe('Acme — horas para lançar, de 26/09/2026 a 25/10/2026');
  });

  it('one line per person in hours and minutes, carry and days off', () => {
    expect(mail.text).toContain('Ana <Lima> (A1): 173 h 25 min a lançar');
    expect(mail.text).toContain('inclui 1 h 00 min de ajuste de períodos anteriores');
    expect(mail.text).toContain('dias de folga: 1');
    expect(mail.text).toContain('https://app.example/hours?period=3');
  });

  it('warnings: no recorded time, negative result', () => {
    expect(mail.text).toContain('Bo: 2 dia(s) útil(eis) sem tempo registrado');
    expect(mail.text).toContain('Bo: resultado negativo');
  });

  it('the html escapes names and never mentions money', () => {
    expect(mail.html).toContain('Ana &lt;Lima&gt;');
    expect(mail.html).not.toContain('<Lima>');
    expect(`${mail.text}${mail.html}`).not.toMatch(/rate|salary|R\$|\$/i);
  });

  it('no link configured: no link line', () => {
    const plain = statementMail({ lang: 'en', org: 'Acme', start: '2026-09-26', end: '2026-10-25', lines, link: null });
    expect(plain.text).not.toContain('http');
  });
});

describe('statementWorkbook', () => {
  it('builds a file', async () => {
    const bytes = await statementWorkbook({
      start: '2026-09-26',
      end: '2026-10-25',
      lines: lines.map((l) => ({ ...l, fromDate: '2026-09-26', toDate: '2026-10-25', measuredSec: 600_000 })),
      days: [{ fullName: 'Ana', empCode: 'A1', date: '2026-09-28', arrived: '08:02', left: '17:01', presenceHours: 8, activeHours: 7.2, adjustmentHours: 0, creditedHours: 8 }],
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/statement-mail.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Add the catalog keys and `formatDay`**

Add to `EN` in `mail/mail-text.ts` (and the same keys to `pt-BR` and `es`; the completeness test from Delivery 1 enforces it):

```ts
  'statement.subject': '{org} — hours to post, {start} to {end}',
  'statement.intro': 'Hours worked by hourly staff from {start} to {end}, ready to post in the payroll system.',
  'statement.line': '{name} ({code}): {hours} to post',
  'statement.carry': 'includes {carry} carried over from earlier periods',
  'statement.leave': 'leave days: {n}',
  'statement.holidays': 'holidays: {n}',
  'statement.warnings': 'Check before posting:',
  'statement.noData': '{name}: {n} workday(s) with no recorded time',
  'statement.negative': '{name}: negative result — a correction lowered hours already posted',
  'statement.link': 'Details and day-by-day hours: {url}',
  'statement.markPosted': 'After posting, mark each person as posted on that screen.',
```

pt-BR:

```ts
  'statement.subject': '{org} — horas para lançar, de {start} a {end}',
  'statement.intro': 'Horas trabalhadas pelos horistas de {start} a {end}, prontas para lançar no sistema de folha.',
  'statement.line': '{name} ({code}): {hours} a lançar',
  'statement.carry': 'inclui {carry} de ajuste de períodos anteriores',
  'statement.leave': 'dias de folga: {n}',
  'statement.holidays': 'feriados: {n}',
  'statement.warnings': 'Confira antes de lançar:',
  'statement.noData': '{name}: {n} dia(s) útil(eis) sem tempo registrado',
  'statement.negative': '{name}: resultado negativo — uma correção reduziu horas já lançadas',
  'statement.link': 'Detalhes e horas dia a dia: {url}',
  'statement.markPosted': 'Depois de lançar, marque cada pessoa como lançada nessa tela.',
```

es:

```ts
  'statement.subject': '{org} — horas para registrar, del {start} al {end}',
  'statement.intro': 'Horas trabajadas por el personal por horas del {start} al {end}, listas para registrar en el sistema de nómina.',
  'statement.line': '{name} ({code}): {hours} a registrar',
  'statement.carry': 'incluye {carry} de ajuste de períodos anteriores',
  'statement.leave': 'días de permiso: {n}',
  'statement.holidays': 'feriados: {n}',
  'statement.warnings': 'Revise antes de registrar:',
  'statement.noData': '{name}: {n} día(s) laborable(s) sin tiempo registrado',
  'statement.negative': '{name}: resultado negativo — una corrección redujo horas ya registradas',
  'statement.link': 'Detalles y horas día por día: {url}',
  'statement.markPosted': 'Después de registrar, marque a cada persona como registrada en esa pantalla.',
```

And the helper:

```ts
const DAY_LOCALE: Record<Language, string> = { en: 'en-GB', 'pt-BR': 'pt-BR', es: 'es-ES' };

/** A calendar date ('YYYY-MM-DD') written the reader's way */
export function formatDay(date: string, lang: Language): string {
  const options: Intl.DateTimeFormatOptions =
    lang === 'en'
      ? { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }
      : { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' };
  return new Intl.DateTimeFormat(DAY_LOCALE[lang], options).format(new Date(`${date}T00:00:00.000Z`));
}
```

- [ ] **Step 4: Write `statement-mail.ts` and `statement-sheet.ts`**

```ts
// oxeio-monitor/server/src/hours-statement/statement-mail.ts
import { formatDay, hoursAndMinutes, mailText } from '../mail/mail-text';
import type { Language } from '../settings/languages';

export interface StatementMailLine {
  fullName: string;
  empCode: string;
  toPostMin: number;
  carryInSec: number;
  leaveDays: number;
  holidayDays: number;
  noDataDays: number;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The hours statement email: hours and days only — no rate, no money, the
 * same reasoning as every email here (it sits in mailboxes for years).
 */
export function statementMail(input: {
  lang: Language;
  org: string;
  start: string;
  end: string;
  lines: readonly StatementMailLine[];
  link: string | null;
}): { subject: string; text: string; html: string } {
  const { lang } = input;
  const start = formatDay(input.start, lang);
  const end = formatDay(input.end, lang);

  const people = input.lines.map((l) => {
    const head = mailText(lang, 'statement.line', { name: l.fullName, code: l.empCode, hours: hoursAndMinutes(l.toPostMin, lang) });
    const extras = [
      l.carryInSec !== 0 ? mailText(lang, 'statement.carry', { carry: hoursAndMinutes(Math.trunc(l.carryInSec / 60), lang) }) : null,
      l.leaveDays > 0 ? mailText(lang, 'statement.leave', { n: l.leaveDays }) : null,
      l.holidayDays > 0 ? mailText(lang, 'statement.holidays', { n: l.holidayDays }) : null,
    ].filter((x): x is string => x !== null);
    return { head, extras };
  });

  const warnings = input.lines.flatMap((l) => [
    ...(l.noDataDays > 0 ? [mailText(lang, 'statement.noData', { name: l.fullName, n: l.noDataDays })] : []),
    ...(l.toPostMin < 0 ? [mailText(lang, 'statement.negative', { name: l.fullName })] : []),
  ]);

  const closing = [
    ...(input.link ? [mailText(lang, 'statement.link', { url: input.link })] : []),
    mailText(lang, 'statement.markPosted'),
  ];

  const text = [
    mailText(lang, 'statement.intro', { start, end }),
    '',
    ...people.map((p) => (p.extras.length > 0 ? `• ${p.head} (${p.extras.join('; ')})` : `• ${p.head}`)),
    ...(warnings.length > 0 ? ['', mailText(lang, 'statement.warnings'), ...warnings.map((w) => `• ${w}`)] : []),
    '',
    ...closing,
  ].join('\n');

  const html = [
    `<p>${escapeHtml(mailText(lang, 'statement.intro', { start, end }))}</p>`,
    '<ul>',
    ...people.map((p) => `<li><b>${escapeHtml(p.head)}</b>${p.extras.length > 0 ? ` — ${escapeHtml(p.extras.join('; '))}` : ''}</li>`),
    '</ul>',
    ...(warnings.length > 0
      ? [`<p><b>${escapeHtml(mailText(lang, 'statement.warnings'))}</b></p>`, '<ul>', ...warnings.map((w) => `<li>${escapeHtml(w)}</li>`), '</ul>']
      : []),
    ...closing.map((c) => `<p>${escapeHtml(c)}</p>`),
  ].join('\n');

  return {
    subject: mailText(lang, 'statement.subject', { org: input.org, start, end }),
    text,
    html,
  };
}
```

```ts
// oxeio-monitor/server/src/hours-statement/statement-sheet.ts
import { buildWorkbook, NUM_FMT_2, sheetOf, type ExcelColumn } from '../reports/reports.excel';
import type { StatementMailLine } from './statement-mail';

export interface StatementDayRow {
  fullName: string;
  empCode: string;
  date: string;
  arrived: string | null;
  left: string | null;
  presenceHours: number;
  activeHours: number;
  adjustmentHours: number;
  creditedHours: number;
}

type SheetLine = StatementMailLine & { fromDate: string; toDate: string; measuredSec: number };

/** The statement as a spreadsheet: a summary sheet and the day-by-day detail (English, like the other reports) */
export function statementWorkbook(input: {
  start: string;
  end: string;
  lines: readonly SheetLine[];
  days: readonly StatementDayRow[];
}): Promise<Buffer> {
  const summary: ExcelColumn<SheetLine>[] = [
    { header: 'Emp code', width: 12, value: (l) => l.empCode },
    { header: 'Name', width: 26, value: (l) => l.fullName },
    { header: 'From', width: 12, value: (l) => l.fromDate },
    { header: 'To', width: 12, value: (l) => l.toDate },
    { header: 'Hours to post', width: 14, value: (l) => Math.trunc(l.toPostMin / 60) },
    { header: 'Minutes to post', width: 15, value: (l) => l.toPostMin % 60 },
    { header: 'Measured (hours)', width: 16, numFmt: NUM_FMT_2, value: (l) => l.measuredSec / 3600 },
    { header: 'Carried over (minutes)', width: 20, value: (l) => Math.trunc(l.carryInSec / 60) },
    { header: 'Leave days', width: 11, value: (l) => l.leaveDays },
    { header: 'Holidays', width: 10, value: (l) => l.holidayDays },
    { header: 'Workdays with no time', width: 20, value: (l) => l.noDataDays },
  ];
  const detail: ExcelColumn<StatementDayRow>[] = [
    { header: 'Emp code', width: 12, value: (d) => d.empCode },
    { header: 'Name', width: 26, value: (d) => d.fullName },
    { header: 'Date', width: 12, value: (d) => d.date },
    { header: 'First use', width: 10, value: (d) => d.arrived },
    { header: 'Last use', width: 10, value: (d) => d.left },
    { header: 'Presence (hours)', width: 16, numFmt: NUM_FMT_2, value: (d) => d.presenceHours },
    { header: 'Active (hours)', width: 14, numFmt: NUM_FMT_2, value: (d) => d.activeHours },
    { header: 'Adjustment (hours)', width: 18, numFmt: NUM_FMT_2, value: (d) => d.adjustmentHours },
    { header: 'Credited (hours)', width: 16, numFmt: NUM_FMT_2, value: (d) => d.creditedHours },
  ];
  return buildWorkbook(
    [sheetOf('Hours to post', summary, input.lines), sheetOf('Day by day', detail, input.days)],
    [['Period', `${input.start} to ${input.end}`]],
  );
}
```

Note on negative minutes: `Math.trunc(-50 / 60)` = `-0` and `-50 % 60` = `-50`, so a negative line shows `0` hours and `-50` minutes — correct for a negative result; keep it.

- [ ] **Step 5: Run tests**

Run: `npm test -- test/statement-mail.spec.ts test/mail-text.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A oxeio-monitor/server/src oxeio-monitor/server/test/statement-mail.spec.ts
git commit -m "feat(server): hours statement email text and spreadsheet"
```

---

### Task 6: The statement service, delivery and the hourly job

**Files:**
- Create: `oxeio-monitor/server/src/hours-statement/hours-statement.service.ts`
- Create: `oxeio-monitor/server/src/hours-statement/statement-delivery.service.ts`
- Create: `oxeio-monitor/server/src/hours-statement/hours-statement.job.ts`
- Create: `oxeio-monitor/server/src/hours-statement/hours-statement.module.ts`
- Modify: `oxeio-monitor/server/src/settings/app-settings.service.ts` (`payPeriod()`), `oxeio-monitor/server/src/app.module.ts`
- Test: `oxeio-monitor/server/test/hours-statement.e2e.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5; `SummaryService.drainDirty`, `SummaryService.refreshDate`; `Mailer.deliver`; `MailRecipients.for('hoursStatement')`; `AlertsService.raise`; `FeaturesService.isOn`; `workDateOf`, `workWallOf`, `workClock` (`agent/util/work-time.ts`).
- Produces:
  - `AppSettingsService.payPeriod(): Promise<PayPeriodConfig>`
  - `HoursStatementService`:
    - `ensureOpen(today: string): Promise<PayPeriodRow>`
    - `computeLines(period: { id: number; start: string; end: string }): Promise<ComputedLine[]>`
    - `snapshot(periodId: number, now: Date): Promise<void>`
    - `isLocked(periodId: number): Promise<boolean>` (a later period has a snapshot)
    - `markPosted(lineId: number, actor: SessionUser, postedMin: number | undefined, note: string | undefined, ip: string)`, `unmarkPosted(lineId: number, actor: SessionUser, ip: string)`
    - `reanchorOpen(cutoff: CutoffDay): Promise<void>`
    - `days(period, employeeId): Promise<StatementDayRow[]>`
  - `interface ComputedLine { employeeId: number; empCode: string; fullName: string; fromDate: string; toDate: string; measuredSec: number; carryInSec: number; toPostMin: number; leaveDays: number; holidayDays: number; noDataDays: number }`
  - `StatementDeliveryService.deliver(periodId: number): Promise<StatementDelivery>`; `MAX_DELIVERY_ATTEMPTS = 24`
  - `HoursStatementJob.tick(now: Date): Promise<void>` (the cron calls it at minute 10 of every hour)

- [ ] **Step 1: Write the failing e2e test**

```ts
// oxeio-monitor/server/test/hours-statement.e2e.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HoursStatementJob } from '../src/hours-statement/hours-statement.job';
import { Mailer } from '../src/mail/mailer';
import { AppSettingsService } from '../src/settings/app-settings.service';
import {
  createEmployeeWithCode,
  createHarness,
  hashPassword,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/**
 * A full cycle in the pinned zone Etc/GMT-6 (local = UTC+6), cutoff 25, send 07:00.
 * local(…) builds the instant of a local wall-clock time.
 */
let h: Harness;
let owner: Session;
let employeeId: number;
let sent: { to: readonly string[]; subject: string }[];

const local = (iso: string) => new Date(Date.parse(`${iso}:00.000Z`) - 6 * 3600_000);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
  await h.app.get(AppSettingsService).replace('payPeriod', { cutoffDay: 25, sendTime: '07:00' }, 1);

  ({ employeeId } = await createEmployeeWithCode(h.prisma, 'HR-1'));
  await h.prisma.employee.update({ where: { id: employeeId }, data: { payBasis: 'hourly', hourlyRate: '10' } });
  await h.prisma.user.create({
    data: { email: 'fin@test.local', passwordHash: await hashPassword('fin-password-123'), fullName: 'Fin', role: 'finance', mustChangePw: false },
  });

  sent = [];
  const mailer = h.app.get(Mailer);
  vi.spyOn(mailer, 'deliver').mockImplementation(async (to, message) => {
    sent.push({ to, subject: message.subject });
    return { outcome: 'sent' };
  });
});

const credited = (date: string, sec: number) =>
  h.prisma.dailySummary.upsert({
    where: { employeeId_workDate: { employeeId, workDate: day(date) } },
    create: { employeeId, workDate: day(date), workedSec: sec, creditedSec: sec },
    update: { workedSec: sec, creditedSec: sec },
  });

describe('the hours statement cycle', () => {
  it('opens a period, sends it the day after the cutoff, carries corrections forward', async () => {
    const job = h.app.get(HoursStatementJob);

    await job.tick(local('2026-09-10T06:00'));
    const open = await h.prisma.payPeriod.findMany();
    expect(open.map((p) => [p.startDate.toISOString().slice(0, 10), p.endDate.toISOString().slice(0, 10)])).toEqual([['2026-08-26', '2026-09-25']]);

    await credited('2026-09-01', 28_800);
    await credited('2026-09-02', 27_020);

    await job.tick(local('2026-09-26T06:30'));
    expect(sent).toHaveLength(0);

    await job.tick(local('2026-09-26T07:10'));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['fin@test.local']);
    const first = await h.prisma.payPeriodLine.findFirstOrThrow({ where: { employeeId } });
    expect(first).toMatchObject({ measuredSec: 55_820, carryInSec: 0, toPostMin: 930 });

    // an hour added to an already-sent day, and an hour in the new period
    await credited('2026-09-01', 32_400);
    await credited('2026-10-01', 3_600);

    await job.tick(local('2026-10-26T07:10'));
    expect(sent).toHaveLength(2);
    const lines = await h.prisma.payPeriodLine.findMany({ where: { employeeId }, orderBy: { id: 'asc' } });
    expect(lines[1]).toMatchObject({ measuredSec: 3_600, carryInSec: 3_620, toPostMin: 120 });
  });

  it('server down at 07:00: sent at the next run, once', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await job.tick(local('2026-09-26T15:10'));
    await job.tick(local('2026-09-26T16:10'));
    expect(sent).toHaveLength(1);
  });

  it('first run never backfills old periods', async () => {
    await h.app.get(HoursStatementJob).tick(local('2026-10-09T10:00'));
    expect(sent).toHaveLength(0);
    expect(await h.prisma.payPeriod.count()).toBe(1);
  });

  it('a failed delivery is retried, and after 24 attempts the owner gets an alert', async () => {
    const job = h.app.get(HoursStatementJob);
    vi.spyOn(h.app.get(Mailer), 'deliver').mockResolvedValue({ outcome: 'failed', error: 'timeout' });
    await job.tick(local('2026-09-10T06:00'));
    await job.tick(local('2026-09-26T07:10'));
    const period = await h.prisma.payPeriod.findFirstOrThrow({ where: { snapshotAt: { not: null } } });
    expect(period).toMatchObject({ deliveryStatus: 'failed', deliveryAttempts: 1, deliveryError: 'timeout' });

    await h.prisma.payPeriod.update({ where: { id: period.id }, data: { deliveryAttempts: 23 } });
    await job.tick(local('2026-09-26T08:10'));
    expect(await h.prisma.alert.count({ where: { type: 'statement_delivery_failed' } })).toBe(1);
  });

  it('someone hourly only since this period gets no carry-over from before', async () => {
    const job = h.app.get(HoursStatementJob);
    await h.prisma.employee.update({ where: { id: employeeId }, data: { payBasis: 'monthly' } });
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 28_800);
    await job.tick(local('2026-09-26T07:10')); // nobody hourly: no lines
    expect(await h.prisma.payPeriodLine.count()).toBe(0);

    await h.prisma.employee.update({ where: { id: employeeId }, data: { payBasis: 'hourly' } });
    await credited('2026-10-01', 3_600);
    await job.tick(local('2026-10-26T07:10'));
    const line = await h.prisma.payPeriodLine.findFirstOrThrow({ where: { employeeId } });
    expect(line).toMatchObject({ measuredSec: 3_600, carryInSec: 0, toPostMin: 60 });
  });

  it('posted can be undone until the next snapshot, then it is locked', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 36_000);
    await job.tick(local('2026-09-26T07:10'));
    const line = await h.prisma.payPeriodLine.findFirstOrThrow();

    const fin = await loginReady(h, 'fin@test.local', 'fin-password-123');
    const post = (body: object) => fin.http.post(`/api/v1/hours-statement/lines/${line.id}/posted`).set('X-CSRF-Token', fin.csrf).send(body);
    await post({ postedMin: 590, note: 'rounded by hand' }).expect(201);
    await fin.http.delete(`/api/v1/hours-statement/lines/${line.id}/posted`).set('X-CSRF-Token', fin.csrf).expect(200);
    await post({ postedMin: 590 }).expect(201);

    await job.tick(local('2026-10-26T07:10'));
    await post({}).expect(409);
    const next = await h.prisma.payPeriodLine.findFirstOrThrow({ where: { NOT: { id: line.id } } });
    expect(next.carryInSec).toBe(600); // 36 000 s worked − 590 min posted
  });
});
```

The last test depends on Task 7's controller; keep it in this file and expect it to pass only after Task 7 (mark it `it.todo` until then if running Task 6 alone, and switch it back in Task 7).

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/hours-statement.e2e.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Settings reader**

In `app-settings.service.ts`:

```ts
import { PAY_PERIOD_SETTING_KEY, resolvePayPeriod, type PayPeriodConfig } from '../hours-statement/pay-period.rules';
```

```ts
  /** Cutoff day and send time of the hours statement (Settings → Hours statement) */
  async payPeriod(): Promise<PayPeriodConfig> {
    return resolvePayPeriod(await this.read<Partial<PayPeriodConfig>>(PAY_PERIOD_SETTING_KEY));
  }
```

- [ ] **Step 4: The statement service**

```ts
// oxeio-monitor/server/src/hours-statement/hours-statement.service.ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PayPeriod } from '@prisma/client';

import { workClock } from '../agent/util/work-time';
import { AuditService } from '../audit/audit.service';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { SummaryService } from '../summary/summary.service';
import { statementLine } from './ledger.rules';
import { periodAfter, periodHolding, cutoffOnOrAfter, type CutoffDay } from './pay-period.rules';
import { countDays, employedRange, hourlyInPeriod, monthsTouched, type PayBasisName } from './statement.rules';
import type { StatementDayRow } from './statement-sheet';

export interface ComputedLine {
  employeeId: number;
  empCode: string;
  fullName: string;
  fromDate: string;
  toDate: string;
  measuredSec: number;
  carryInSec: number;
  toPostMin: number;
  leaveDays: number;
  holidayDays: number;
  noDataDays: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

/**
 * The hours statement: who was paid by the hour in a period, their hours and
 * the carry-over, frozen once per period. Hours only — this service never
 * selects a pay amount.
 */
@Injectable()
export class HoursStatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly summary: SummaryService,
    private readonly audit: AuditService,
  ) {}

  /** The open period (no snapshot); created from `today` on the very first run */
  async ensureOpen(today: string, cutoff: CutoffDay): Promise<PayPeriod> {
    const latest = await this.prisma.payPeriod.findFirst({ orderBy: { startDate: 'desc' } });
    if (latest && latest.snapshotAt === null) return latest;
    const range = latest ? periodAfter(iso(latest.endDate), cutoff) : periodHolding(today, cutoff);
    return this.prisma.payPeriod.create({ data: { startDate: day(range.start), endDate: day(range.end) } });
  }

  /** After the cutoff changes, the open period ends at the new cutoff (it never moves its start) */
  async reanchorOpen(cutoff: CutoffDay): Promise<void> {
    const open = await this.prisma.payPeriod.findFirst({ where: { snapshotAt: null }, orderBy: { startDate: 'desc' } });
    if (!open) return;
    await this.prisma.payPeriod.update({
      where: { id: open.id },
      data: { endDate: day(cutoffOnOrAfter(iso(open.startDate), cutoff)) },
    });
  }

  async computeLines(period: { id: number; start: string; end: string }): Promise<ComputedLine[]> {
    const months = monthsTouched({ start: period.start, end: period.end });
    const staff = await this.prisma.employee.findMany({
      select: {
        id: true,
        empCode: true,
        fullName: true,
        joinedOn: true,
        leftOn: true,
        payBasis: true,
        salaryPeriods: { select: { throughMonth: true, payBasis: true } },
        policy: { select: { weeklyOffDays: true } },
      },
      orderBy: { fullName: 'asc' },
    });

    const lines: ComputedLine[] = [];
    const holidays = await this.prisma.holiday.findMany({
      where: { holidayDate: { gte: day(period.start), lte: day(period.end) } },
      select: { holidayDate: true },
    });
    const holidaySet = new Set(holidays.map((x) => iso(x.holidayDate)));

    for (const e of staff) {
      if (!hourlyInPeriod(months, e.payBasis as PayBasisName, e.salaryPeriods as { throughMonth: string; payBasis: PayBasisName }[])) continue;
      const range = employedRange({ start: period.start, end: period.end }, e.joinedOn ? iso(e.joinedOn) : null, e.leftOn ? iso(e.leftOn) : null);
      if (!range) continue;

      const [days, leaves, earlier] = await Promise.all([
        this.prisma.dailySummary.findMany({
          where: { employeeId: e.id, workDate: { gte: day(range.start), lte: day(range.end) } },
          select: { workDate: true, creditedSec: true },
        }),
        this.prisma.leave.findMany({
          where: { employeeId: e.id, leaveDate: { gte: day(range.start), lte: day(range.end) } },
          select: { leaveDate: true },
        }),
        this.earlier(e.id, period.id, period.start),
      ]);

      const measuredSec = days.reduce((total, d) => total + d.creditedSec, 0);
      const { carryInSec, toPostMin } = statementLine({ measuredSec, ...earlier });
      lines.push({
        employeeId: e.id,
        empCode: e.empCode,
        fullName: e.fullName,
        fromDate: range.start,
        toDate: range.end,
        measuredSec,
        carryInSec,
        toPostMin,
        ...countDays({
          from: range.start,
          to: range.end,
          offDays: e.policy?.weeklyOffDays ?? [],
          holidays: holidaySet,
          leaves: new Set(leaves.map((l) => iso(l.leaveDate))),
          creditedByDate: new Map(days.map((d) => [iso(d.workDate), d.creditedSec])),
        }),
      });
    }
    return lines;
  }

  /** Real time now and posted minutes over this person's earlier frozen lines */
  private async earlier(employeeId: number, periodId: number, start: string): Promise<{ earlierRealSec: number; earlierPostedMin: number }> {
    const [real] = await this.prisma.$queryRaw<{ sec: bigint | null }[]>`
      SELECT SUM(ds.credited_sec)::bigint AS sec
        FROM pay_period_lines l
        JOIN pay_periods p ON p.id = l.period_id
        JOIN daily_summary ds
          ON ds.employee_id = l.employee_id
         AND ds.work_date BETWEEN l.from_date AND l.to_date
       WHERE l.employee_id = ${employeeId}
         AND p.id <> ${periodId}
         AND p.snapshot_at IS NOT NULL
         AND p.start_date < ${start}::date
    `;
    const posted = await this.prisma.payPeriodLine.findMany({
      where: { employeeId, periodId: { not: periodId }, period: { snapshotAt: { not: null }, startDate: { lt: day(start) } } },
      select: { toPostMin: true, postedMin: true },
    });
    return {
      earlierRealSec: Number(real?.sec ?? 0),
      earlierPostedMin: posted.reduce((total, l) => total + (l.postedMin ?? l.toPostMin), 0),
    };
  }

  /** Freezes a period once; late uploads and the last day are counted first */
  async snapshot(periodId: number, now: Date): Promise<void> {
    const period = await this.prisma.payPeriod.findUniqueOrThrow({ where: { id: periodId } });
    if (period.snapshotAt) return;

    // Prisma's `take` is a 32-bit int: a large finite batch, not MAX_SAFE_INTEGER
    await this.summary.drainDirty(now, 10_000);
    await this.summary.refreshDate(period.endDate, now);

    const lines = await this.computeLines({ id: period.id, start: iso(period.startDate), end: iso(period.endDate) });
    await this.prisma.$transaction([
      this.prisma.payPeriodLine.createMany({
        data: lines.map((l) => ({
          periodId: period.id,
          employeeId: l.employeeId,
          fromDate: day(l.fromDate),
          toDate: day(l.toDate),
          measuredSec: l.measuredSec,
          carryInSec: l.carryInSec,
          toPostMin: l.toPostMin,
          leaveDays: l.leaveDays,
          holidayDays: l.holidayDays,
          noDataDays: l.noDataDays,
        })),
      }),
      this.prisma.payPeriod.update({
        where: { id: period.id },
        data: { snapshotAt: now, deliveryStatus: lines.length === 0 ? 'no_staff' : 'pending' },
      }),
    ]);
  }

  /** A frozen period is locked once a later period was frozen too (its posted values fed a carry-over) */
  async isLocked(periodId: number): Promise<boolean> {
    const period = await this.prisma.payPeriod.findUniqueOrThrow({ where: { id: periodId } });
    const later = await this.prisma.payPeriod.count({ where: { startDate: { gt: period.startDate }, snapshotAt: { not: null } } });
    return later > 0;
  }

  async markPosted(lineId: number, actor: SessionUser, postedMin: number | undefined, note: string | undefined, ip: string): Promise<void> {
    const line = await this.lineOrThrow(lineId);
    if (await this.isLocked(line.periodId)) throw new ConflictException('This period is closed: a later statement already used it');
    await this.prisma.payPeriodLine.update({
      where: { id: lineId },
      data: {
        postedMin: postedMin === undefined || postedMin === line.toPostMin ? null : postedMin,
        postedAt: new Date(),
        postedById: actor.userId,
        note: note?.trim() || null,
      },
    });
    await this.audit.record({
      userId: actor.userId,
      action: 'change_setting',
      targetType: 'pay_period_line',
      targetId: lineId,
      ipAddress: ip,
      meta: { op: 'posted', postedMin: postedMin ?? line.toPostMin },
    });
  }

  async unmarkPosted(lineId: number, actor: SessionUser, ip: string): Promise<void> {
    const line = await this.lineOrThrow(lineId);
    if (await this.isLocked(line.periodId)) throw new ConflictException('This period is closed: a later statement already used it');
    await this.prisma.payPeriodLine.update({ where: { id: lineId }, data: { postedMin: null, postedAt: null, postedById: null, note: null } });
    await this.audit.record({ userId: actor.userId, action: 'change_setting', targetType: 'pay_period_line', targetId: lineId, ipAddress: ip, meta: { op: 'unposted' } });
  }

  /** One person's days in a period, for the screen and the spreadsheet */
  async days(range: { start: string; end: string }, employeeIds: readonly number[]): Promise<StatementDayRow[]> {
    const rows = await this.prisma.dailySummary.findMany({
      where: { employeeId: { in: [...employeeIds] }, workDate: { gte: day(range.start), lte: day(range.end) } },
      select: {
        workDate: true,
        firstActivityAt: true,
        lastActivityAt: true,
        presenceSec: true,
        workedSec: true,
        adjustmentSec: true,
        creditedSec: true,
        employee: { select: { fullName: true, empCode: true } },
      },
      orderBy: [{ employeeId: 'asc' }, { workDate: 'asc' }],
    });
    const h = (sec: number) => Math.round((sec / 3600) * 100) / 100;
    return rows.map((r) => ({
      fullName: r.employee.fullName,
      empCode: r.employee.empCode,
      date: iso(r.workDate),
      arrived: r.firstActivityAt ? workClock(r.firstActivityAt) : null,
      left: r.lastActivityAt ? workClock(r.lastActivityAt) : null,
      presenceHours: h(r.presenceSec),
      activeHours: h(r.workedSec),
      adjustmentHours: h(r.adjustmentSec),
      creditedHours: h(r.creditedSec),
    }));
  }

  private async lineOrThrow(lineId: number) {
    const line = await this.prisma.payPeriodLine.findUnique({ where: { id: lineId } });
    if (!line) throw new NotFoundException('Line not found');
    return line;
  }
}
```

`workClock(instant)` (`agent/util/work-time.ts`) returns the work-zone `'HH:MM'`; `audit.record`'s `targetType` is a free string, so `'pay_period_line'` needs no registration (add it to `ADMIN_TARGET` in `audit/admin-audit.ts` only if the audit screen labels targets from that list).

- [ ] **Step 5: Delivery**

```ts
// oxeio-monitor/server/src/hours-statement/statement-delivery.service.ts
import { Injectable, Logger } from '@nestjs/common';
import type { StatementDelivery } from '@prisma/client';

import { AlertsService } from '../alerts/alerts.service';
import { XLSX_MIME } from '../reports/reports.download';
import { Mailer } from '../mail/mailer';
import { MailRecipients } from '../mail/recipients.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { HoursStatementService } from './hours-statement.service';
import { statementMail } from './statement-mail';
import { statementWorkbook } from './statement-sheet';

/** One snapshot is sent at most this many times by the job (once an hour) before the owner is told */
export const MAX_DELIVERY_ATTEMPTS = 24;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Sends a frozen statement. Never throws: the outcome is stored on the period. */
@Injectable()
export class StatementDeliveryService {
  private readonly logger = new Logger(StatementDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly statements: HoursStatementService,
    private readonly mailer: Mailer,
    private readonly recipients: MailRecipients,
    private readonly settings: AppSettingsService,
    private readonly alerts: AlertsService,
  ) {}

  async deliver(periodId: number): Promise<StatementDelivery> {
    const period = await this.prisma.payPeriod.findUniqueOrThrow({
      where: { id: periodId },
      include: { lines: { include: { employee: { select: { fullName: true, empCode: true } } }, orderBy: { employee: { fullName: 'asc' } } } },
    });
    if (period.lines.length === 0) return this.record(periodId, 'no_staff', null);

    const to = await this.recipients.for('hoursStatement');
    if (to.length === 0) return this.record(periodId, 'no_recipients', null);

    try {
      const lang = (await this.settings.region()).language.value;
      const org = (await this.settings.organization()).name;
      const start = iso(period.startDate);
      const end = iso(period.endDate);
      const lines = period.lines.map((l) => ({
        fullName: l.employee.fullName,
        empCode: l.employee.empCode,
        toPostMin: l.toPostMin,
        carryInSec: l.carryInSec,
        leaveDays: l.leaveDays,
        holidayDays: l.holidayDays,
        noDataDays: l.noDataDays,
        fromDate: iso(l.fromDate),
        toDate: iso(l.toDate),
        measuredSec: l.measuredSec,
      }));
      const base = (process.env.PUBLIC_URL?.trim() || process.env.CORS_ORIGIN?.trim() || '').replace(/\/$/, '');
      const mail = statementMail({ lang, org, start, end, lines, link: base ? `${base}/hours?period=${period.id}` : null });
      const file = await statementWorkbook({ start, end, lines, days: await this.statements.days({ start, end }, period.lines.map((l) => l.employeeId)) });

      const result = await this.mailer.deliver(to, {
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        attachments: [{ filename: `oxeio-hours-${start}_${end}.xlsx`, content: file, contentType: XLSX_MIME }],
      });
      return this.record(periodId, result.outcome === 'sent' ? 'sent' : result.outcome === 'not_configured' ? 'not_configured' : 'failed', result.error ?? null);
    } catch (err) {
      const error = err instanceof Error ? err.message : 'unknown error';
      this.logger.error(`Hours statement ${periodId} could not be built: ${error}`);
      return this.record(periodId, 'failed', error);
    }
  }

  private async record(periodId: number, status: StatementDelivery, error: string | null): Promise<StatementDelivery> {
    const period = await this.prisma.payPeriod.update({
      where: { id: periodId },
      data: {
        deliveryStatus: status,
        deliveryError: error,
        deliveryAttempts: { increment: 1 },
        ...(status === 'sent' ? { sentAt: new Date() } : {}),
      },
    });
    if (status === 'failed' && period.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.alerts.raise({
        type: 'statement_delivery_failed',
        severity: 'warning',
        deviceId: null,
        employeeId: null,
        title: 'The hours statement email could not be sent',
        detail: `Period ${iso(period.startDate)} to ${iso(period.endDate)}: ${error ?? 'unknown error'}. Check Settings → Notifications, then resend it from the Hours statement screen.`,
      });
    }
    return status;
  }
}
```

`AlertsService` is exported by `AlertsModule`; import that module in `HoursStatementModule`.

- [ ] **Step 6: The job and the module**

```ts
// oxeio-monitor/server/src/hours-statement/hours-statement.job.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { workDateOf, workWallOf } from '../agent/util/work-time';
import { FeaturesService } from '../features/features.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { SCHEDULING_ENABLED } from '../summary/scheduling';
import { HoursStatementService } from './hours-statement.service';
import { isDue } from './pay-period.rules';
import { MAX_DELIVERY_ATTEMPTS, StatementDeliveryService } from './statement-delivery.service';

/**
 * Every hour at minute 10: freeze and send every period whose send moment has
 * passed (several if the server was down for long), retry failed emails, and
 * keep one open period ahead. Deciding by the clock rather than firing at
 * 07:00 means a server that was down at 07:00 still sends at its next run.
 */
@Injectable()
export class HoursStatementJob {
  private readonly logger = new Logger(HoursStatementJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly statements: HoursStatementService,
    private readonly delivery: StatementDeliveryService,
    private readonly settings: AppSettingsService,
    private readonly features: FeaturesService,
  ) {}

  @Cron('0 10 * * * *', { name: 'hours-statement', disabled: !SCHEDULING_ENABLED, waitForCompletion: true })
  async scheduled(): Promise<void> {
    try {
      await this.tick(new Date());
    } catch (err) {
      this.logger.error(`Hours statement run failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async tick(now: Date): Promise<void> {
    if (!(await this.features.isOn('hoursStatement'))) return;
    const config = await this.settings.payPeriod();
    const today = workDateOf(now).toISOString().slice(0, 10);
    const wall = workWallOf(now);
    const nowMin = wall.getUTCHours() * 60 + wall.getUTCMinutes();

    // periods frozen in this run already had their attempt; retries start next hour
    const justSent = new Set<number>();
    let open = await this.statements.ensureOpen(today, config.cutoffDay);
    while (isDue(open.endDate.toISOString().slice(0, 10), today, nowMin, config.sendTime)) {
      await this.statements.snapshot(open.id, now);
      await this.delivery.deliver(open.id);
      justSent.add(open.id);
      open = await this.statements.ensureOpen(today, config.cutoffDay);
    }

    const failed = await this.prisma.payPeriod.findMany({
      where: { deliveryStatus: 'failed', deliveryAttempts: { lt: MAX_DELIVERY_ATTEMPTS } },
      select: { id: true },
    });
    for (const p of failed) {
      if (!justSent.has(p.id)) await this.delivery.deliver(p.id);
    }
  }
}
```

`justSent` keeps a period that failed in this run from a second attempt in the same run, so `deliveryAttempts` counts hours, as the alert text assumes.

```ts
// oxeio-monitor/server/src/hours-statement/hours-statement.module.ts
import { Module } from '@nestjs/common';

import { AlertsModule } from '../alerts/alerts.module';
import { SummaryModule } from '../summary/summary.module';
import { HoursStatementJob } from './hours-statement.job';
import { HoursStatementService } from './hours-statement.service';
import { StatementDeliveryService } from './statement-delivery.service';

/** Pay periods and the hours statement for hourly staff (Settings → Modules: hoursStatement) */
@Module({
  imports: [SummaryModule, AlertsModule],
  providers: [HoursStatementService, StatementDeliveryService, HoursStatementJob],
  exports: [HoursStatementService],
})
export class HoursStatementModule {}
```

Check that `SummaryModule` exports `SummaryService`; add it to its `exports` if missing. Add `HoursStatementModule` to `app.module.ts` imports.

- [ ] **Step 7: Run tests**

Run: `npm test -- test/hours-statement.e2e.spec.ts` (the posting test stays `it.todo` until Task 7)
Expected: PASS for the cycle, down-at-07:00, first-run, retry/alert and "hourly since this period" cases.

- [ ] **Step 8: Commit**

```bash
git add -A oxeio-monitor/server
git commit -m "feat(server): hours statement — hourly job freezes, sends and retries each pay period"
```

---

### Task 7: Endpoints and the settings card's server side

**Files:**
- Create: `oxeio-monitor/server/src/hours-statement/hours-statement.controller.ts`, `oxeio-monitor/server/src/hours-statement/pay-period.controller.ts`
- Modify: `hours-statement/hours-statement.module.ts` (controllers)
- Test: `oxeio-monitor/server/test/hours-statement.e2e.spec.ts` (switch the posting test back on; add endpoint cases)

**Interfaces:**
- Produces (HTTP; class `@Roles(owner, finance)`, `@RequiresFeature('hoursStatement')`):
  - `GET /api/v1/hours-statement/periods` → `PeriodSummary[]` = `{ id; start; end; open: boolean; snapshotAt: string | null; deliveryStatus: StatementDelivery | null; sentAt: string | null; deliveryError: string | null }[]`, newest first
  - `GET /api/v1/hours-statement/periods/:id` → `{ period: PeriodSummary; locked: boolean; lines: LineView[] }` — the open period answers live (computed) lines with `id: null`
  - `GET /api/v1/hours-statement/periods/:id/people/:employeeId` → `StatementDayRow[]`
  - `GET /api/v1/hours-statement/periods/:id/file` → xlsx download
  - `POST /api/v1/hours-statement/lines/:id/posted` body `{ postedMin?: number; note?: string }` → `{ ok: true }` (409 when locked)
  - `DELETE /api/v1/hours-statement/lines/:id/posted` → `{ ok: true }`
  - `POST /api/v1/hours-statement/periods/:id/resend` (owner only) → `{ status: StatementDelivery }`
  - `GET /api/v1/settings/pay-period` (owner) → `PayPeriodConfig & { open: { start: string; end: string } | null }`
  - `PUT /api/v1/settings/pay-period` (owner) body `PayPeriodConfig` → same
  - `LineView = ComputedLine & { id: number | null; postedMin: number | null; postedAt: string | null; postedBy: string | null; note: string | null }`

- [ ] **Step 1: Add the failing endpoint cases** — in `test/hours-statement.e2e.spec.ts`, turn the posting test back into `it(...)` and append:

```ts
describe('hours statement endpoints', () => {
  it('finance lists periods and sees live numbers for the open one; no money in the answer', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 3_600);

    const fin = await loginReady(h, 'fin@test.local', 'fin-password-123');
    const list = await fin.http.get('/api/v1/hours-statement/periods').expect(200);
    expect(list.body[0]).toMatchObject({ start: '2026-08-26', end: '2026-09-25', open: true });

    const view = await fin.http.get(`/api/v1/hours-statement/periods/${list.body[0].id}`).expect(200);
    expect(view.body.lines[0]).toMatchObject({ id: null, measuredSec: 3_600, toPostMin: 60 });
    expect(JSON.stringify(view.body)).not.toMatch(/hourlyRate|monthlySalary|salary/i);
  });

  it('resend is owner only', async () => {
    const job = h.app.get(HoursStatementJob);
    await job.tick(local('2026-09-10T06:00'));
    await credited('2026-09-01', 3_600);
    await job.tick(local('2026-09-26T07:10'));
    const period = await h.prisma.payPeriod.findFirstOrThrow({ where: { snapshotAt: { not: null } } });

    const fin = await loginReady(h, 'fin@test.local', 'fin-password-123');
    await fin.http.post(`/api/v1/hours-statement/periods/${period.id}/resend`).set('X-CSRF-Token', fin.csrf).expect(403);
    const res = await owner.http.post(`/api/v1/hours-statement/periods/${period.id}/resend`).set('X-CSRF-Token', owner.csrf).expect(201);
    expect(res.body.status).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('changing the cutoff stretches the open period', async () => {
    await h.app.get(HoursStatementJob).tick(local('2026-10-09T10:00'));
    const res = await owner.http.put('/api/v1/settings/pay-period').set('X-CSRF-Token', owner.csrf).send({ cutoffDay: 'end', sendTime: '07:00' }).expect(200);
    expect(res.body.open).toEqual({ start: '2026-09-26', end: '2026-09-30' });
  });

  it('the file downloads', async () => {
    await h.app.get(HoursStatementJob).tick(local('2026-09-10T06:00'));
    const period = await h.prisma.payPeriod.findFirstOrThrow();
    const res = await owner.http.get(`/api/v1/hours-statement/periods/${period.id}/file`).expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });
});
```

(The cutoff case: the open period was 26/09–25/10; with "end of month" its end becomes the first month end on or after 26/09, which is 30/09 — already past on 09/10, so it will be frozen at the next run. That is the documented behaviour.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/hours-statement.e2e.spec.ts`
Expected: FAIL — 404s.

- [ ] **Step 3: Implement the controllers**

```ts
// oxeio-monitor/server/src/hours-statement/hours-statement.controller.ts
import { Body, Controller, Delete, Get, Ip, NotFoundException, Param, ParseIntPipe, Post, StreamableFile } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { RequiresFeature } from '../features/requires-feature';
import { PrismaService } from '../prisma/prisma.service';
import { XLSX_MIME } from '../reports/reports.download';
import { HoursStatementService } from './hours-statement.service';
import { statementWorkbook } from './statement-sheet';
import { StatementDeliveryService } from './statement-delivery.service';

class PostedDto {
  /** the value actually posted, when different from the proposal */
  @IsOptional() @IsInt() @Min(-100_000) @Max(100_000)
  postedMin?: number;

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The hours statement screen: owner and finance. Hours only — never money.
 * Resend is the owner's (it emails people).
 */
@Roles(UserRole.owner, UserRole.finance)
@RequiresFeature('hoursStatement')
@Controller('hours-statement')
export class HoursStatementController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly statements: HoursStatementService,
    private readonly delivery: StatementDeliveryService,
  ) {}

  @Get('periods')
  async periods() {
    const rows = await this.prisma.payPeriod.findMany({ orderBy: { startDate: 'desc' } });
    return rows.map((p) => this.summaryOf(p));
  }

  @Get('periods/:id')
  async period(@Param('id', ParseIntPipe) id: number) {
    const p = await this.periodOrThrow(id);
    const range = { id: p.id, start: iso(p.startDate), end: iso(p.endDate) };
    if (p.snapshotAt === null) {
      const live = await this.statements.computeLines(range);
      return {
        period: this.summaryOf(p),
        locked: false,
        lines: live.map((l) => ({ ...l, id: null, postedMin: null, postedAt: null, postedBy: null, note: null })),
      };
    }
    const lines = await this.prisma.payPeriodLine.findMany({
      where: { periodId: id },
      include: { employee: { select: { fullName: true, empCode: true } }, postedBy: { select: { fullName: true } } },
      orderBy: { employee: { fullName: 'asc' } },
    });
    return {
      period: this.summaryOf(p),
      locked: await this.statements.isLocked(id),
      lines: lines.map((l) => ({
        id: l.id,
        employeeId: l.employeeId,
        empCode: l.employee.empCode,
        fullName: l.employee.fullName,
        fromDate: iso(l.fromDate),
        toDate: iso(l.toDate),
        measuredSec: l.measuredSec,
        carryInSec: l.carryInSec,
        toPostMin: l.toPostMin,
        leaveDays: l.leaveDays,
        holidayDays: l.holidayDays,
        noDataDays: l.noDataDays,
        postedMin: l.postedMin,
        postedAt: l.postedAt?.toISOString() ?? null,
        postedBy: l.postedBy?.fullName ?? null,
        note: l.note,
      })),
    };
  }

  @Get('periods/:id/people/:employeeId')
  async person(@Param('id', ParseIntPipe) id: number, @Param('employeeId', ParseIntPipe) employeeId: number) {
    const p = await this.periodOrThrow(id);
    return this.statements.days({ start: iso(p.startDate), end: iso(p.endDate) }, [employeeId]);
  }

  @Get('periods/:id/file')
  async file(@Param('id', ParseIntPipe) id: number): Promise<StreamableFile> {
    const view = await this.period(id);
    const start = view.period.start;
    const end = view.period.end;
    const bytes = await statementWorkbook({
      start,
      end,
      lines: view.lines,
      days: await this.statements.days({ start, end }, view.lines.map((l) => l.employeeId)),
    });
    return new StreamableFile(bytes, {
      type: XLSX_MIME,
      disposition: `attachment; filename="oxeio-hours-${start}_${end}.xlsx"`,
      length: bytes.byteLength,
    });
  }

  @Post('lines/:id/posted')
  async posted(@Param('id', ParseIntPipe) id: number, @Body() dto: PostedDto, @CurrentUser() actor: SessionUser, @Ip() ip: string) {
    await this.statements.markPosted(id, actor, dto.postedMin, dto.note, ip);
    return { ok: true };
  }

  @Delete('lines/:id/posted')
  async unposted(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: SessionUser, @Ip() ip: string) {
    await this.statements.unmarkPosted(id, actor, ip);
    return { ok: true };
  }

  @Roles(UserRole.owner)
  @Post('periods/:id/resend')
  async resend(@Param('id', ParseIntPipe) id: number) {
    const p = await this.periodOrThrow(id);
    if (!p.snapshotAt) throw new NotFoundException('This period is still open — there is nothing to send yet');
    return { status: await this.delivery.deliver(id) };
  }

  private async periodOrThrow(id: number) {
    const p = await this.prisma.payPeriod.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Pay period not found');
    return p;
  }

  private summaryOf(p: { id: number; startDate: Date; endDate: Date; snapshotAt: Date | null; deliveryStatus: string | null; sentAt: Date | null; deliveryError: string | null }) {
    return {
      id: p.id,
      start: iso(p.startDate),
      end: iso(p.endDate),
      open: p.snapshotAt === null,
      snapshotAt: p.snapshotAt?.toISOString() ?? null,
      deliveryStatus: p.deliveryStatus,
      sentAt: p.sentAt?.toISOString() ?? null,
      deliveryError: p.deliveryError,
    };
  }
}
```

```ts
// oxeio-monitor/server/src/hours-statement/pay-period.controller.ts
import { BadRequestException, Body, Controller, Get, Ip, Put } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { SessionUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { HoursStatementService } from './hours-statement.service';
import { PAY_PERIOD_SETTING_KEY, payPeriodProblem, type PayPeriodConfig } from './pay-period.rules';

/** Cutoff day and send time — owner only */
@Roles(UserRole.owner)
@Controller('settings/pay-period')
export class PayPeriodController {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly statements: HoursStatementService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async read() {
    const config = await this.settings.payPeriod();
    const open = await this.prisma.payPeriod.findFirst({ where: { snapshotAt: null }, orderBy: { startDate: 'desc' } });
    return {
      ...config,
      open: open ? { start: open.startDate.toISOString().slice(0, 10), end: open.endDate.toISOString().slice(0, 10) } : null,
    };
  }

  /** The body is checked by `payPeriodProblem` (cutoffDay is a number or 'end') */
  @Put()
  async save(@Body() body: Record<string, unknown>, @CurrentUser() actor: SessionUser, @Ip() ip: string) {
    const problem = payPeriodProblem({ cutoffDay: body.cutoffDay, sendTime: body.sendTime });
    if (problem) throw new BadRequestException(problem);
    const next: PayPeriodConfig = { cutoffDay: body.cutoffDay as PayPeriodConfig['cutoffDay'], sendTime: body.sendTime as string };
    await this.settings.replace(PAY_PERIOD_SETTING_KEY, { ...next }, actor.userId);
    await this.statements.reanchorOpen(next.cutoffDay);
    await this.audit.record({ userId: actor.userId, action: 'change_setting', targetType: 'setting', targetId: PAY_PERIOD_SETTING_KEY, ipAddress: ip, meta: { ...next } });
    return this.read();
  }
}
```

Register both controllers in `hours-statement.module.ts` (`controllers: [HoursStatementController, PayPeriodController]`). Add `payPeriod: [PAY_PERIOD_SETTING_KEY]` to `ENV_SUBJECTS` only if a "Use the default" button is wanted on the card — it is not needed (there is no env variable); skip it.

Note on `@Body() body: Record<string, unknown>`: the global `ValidationPipe` only validates class types, so the plain object reaches the handler and `payPeriodProblem` validates it — the same pattern as the recipients controller in Delivery 1.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/hours-statement.e2e.spec.ts test/finance-role.e2e.spec.ts test/endpoints.e2e.spec.ts`
Expected: PASS (all cases, including posting and the lock).

- [ ] **Step 5: Commit**

```bash
git add -A oxeio-monitor/server
git commit -m "feat(server): hours statement endpoints, posted marks, resend, cutoff settings"
```

---

### Task 8: Dashboard — finance role, Hours statement screen, settings card

**Files:**
- Create: `oxeio-monitor/web/src/api/hoursStatement.ts`
- Create: `oxeio-monitor/web/src/pages/hours/HoursStatementPage.tsx`, `oxeio-monitor/web/src/pages/hours/hours.format.ts`, `oxeio-monitor/web/src/pages/hours/PostedDialog.tsx`
- Create: `oxeio-monitor/web/src/pages/settings/PayPeriodTab.tsx`
- Modify: `oxeio-monitor/web/src/api/staff.ts` (`Role`), `web/src/api/auth.ts` (`homePathFor`), `web/src/api/features.ts` (`hoursStatement`), `web/src/api/settings.ts` (`MailKind`, `envVariable: string | null`)
- Modify: `web/src/components/nav.ts`, `web/src/components/Layout.tsx` (`ROLE_LABEL`), `web/src/App.tsx` (route), `web/src/pages/staff/StaffDirectory.tsx` (`ASSIGNABLE_OF`, `PORTAL_ROLES`), `web/src/pages/settings/sections.ts`, `web/src/pages/settings/SettingsPage.tsx`, `web/src/pages/settings/ModulesTab.tsx`, `web/src/pages/settings/EmailCards.tsx` (`KIND_LABEL.hoursStatement`)
- Modify: catalogs `web/src/i18n/locales/{pt-BR,es}/*.json` (new keys), both `server.json`
- Test: `oxeio-monitor/web/test/hours-format.spec.ts`, `web/test/nav.spec.ts`, `web/test/home-path.spec.ts`

**Interfaces:**
- Consumes (HTTP): Task 7.
- Produces: `hm(totalMin: number): string` (`'173 h 25 min'`, `'−0 h 50 min'`), `lineStatus(line: { id: number | null; postedAt: string | null; postedMin: number | null }): 'live' | 'to_post' | 'posted' | 'posted_different'`, `periodLabel(start: string, end: string): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// oxeio-monitor/web/test/hours-format.spec.ts
import { describe, expect, it } from 'vitest';

import { hm, lineStatus } from '../src/pages/hours/hours.format';

describe('hours statement formatting', () => {
  it('whole hours and two-digit minutes, sign kept', () => {
    expect(hm(10_405)).toBe('173 h 25 min');
    expect(hm(0)).toBe('0 h 00 min');
    expect(hm(-50)).toBe('−0 h 50 min');
  });
  it('the status of a line', () => {
    expect(lineStatus({ id: null, postedAt: null, postedMin: null })).toBe('live');
    expect(lineStatus({ id: 1, postedAt: null, postedMin: null })).toBe('to_post');
    expect(lineStatus({ id: 1, postedAt: '2026-10-27T10:00:00Z', postedMin: null })).toBe('posted');
    expect(lineStatus({ id: 1, postedAt: '2026-10-27T10:00:00Z', postedMin: 590 })).toBe('posted_different');
  });
});
```

Append to `web/test/nav.spec.ts`:

```ts
describe('navFor — finance', () => {
  it('finance sees the hours statement and nothing else', () => {
    expect(paths(user({ role: 'finance' }))).toEqual(['/hours']);
  });
  it('the owner sees it too; the module switch hides it', () => {
    expect(paths(user())).toContain('/hours');
    expect(paths(user(), off({ hoursStatement: false }))).not.toContain('/hours');
  });
});
```

Append to `web/test/home-path.spec.ts` (match its imports):

```ts
it('finance lands on the hours statement', () => {
  expect(homePathFor('finance')).toBe('/hours');
});
```

- [ ] **Step 2: Run to verify they fail**

Run (in `oxeio-monitor/web`): `npm test -- test/hours-format.spec.ts test/nav.spec.ts test/home-path.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Types, role, nav, home**

- `api/staff.ts`: `export type Role = 'owner' | 'manager' | 'coordinator' | 'employee' | 'finance';`. Run `npm run typecheck`: every `Record<Role, …>` now fails — fix each:
  - `Layout.tsx` `ROLE_LABEL.finance = 'Finance'`
  - `StaffDirectory.tsx` `ASSIGNABLE_OF.finance = 'finance'`, and add to `PORTAL_ROLES`: `{ value: 'finance', label: 'Finance — the hours statement only; nothing else' }`
  - any other map the compiler names.
- `api/auth.ts` `homePathFor`: before the last return, `if (role === 'finance') return '/hours';`.
- `api/features.ts`: add `hoursStatement: boolean;` to `Features` and `hoursStatement: true` to `ALL_FEATURES_ON`; `FeatureKey` follows.
- `components/nav.ts`: add

```ts
  /** The hours statement: what to post for hourly staff each pay period (finance's only screen) */
  {
    to: '/hours',
    label: 'Hours statement',
    roles: ['owner', 'finance'],
    feature: 'hoursStatement',
  },
```

  and check every other entry's `roles` list does not include `finance` (none should).
- `App.tsx`: `{(isOwner || user.role === 'finance') && features.hoursStatement && <Route path="hours" element={<HoursStatementPage />} />}`. Check how `isStaff` is computed: finance must land through `homePathFor` (it is not owner/manager, so the index route's staff branch already sends it to `staffLanding`).
- `ModulesTab.tsx`: add the `hoursStatement` module with the same shape as the existing entries — label "Hours statement", description "Pay periods with a cutoff day; the hours of hourly staff emailed to finance and shown to the finance role".
- `EmailCards.tsx`: `KIND_LABEL.hoursStatement = 'Hours statement (besides finance logins)'`; `api/settings.ts` `MailKind` gains `'hoursStatement'` and `envVariable: string | null`; the hint in `RecipientsCard` shows the env variable only when not null.

- [ ] **Step 4: Formatting and API**

```ts
// oxeio-monitor/web/src/pages/hours/hours.format.ts
/** '173 h 25 min' — the shape payroll forms ask for */
export function hm(totalMin: number): string {
  const sign = totalMin < 0 ? '−' : '';
  const abs = Math.abs(Math.trunc(totalMin));
  return `${sign}${Math.floor(abs / 60)} h ${String(abs % 60).padStart(2, '0')} min`;
}

export function lineStatus(line: { id: number | null; postedAt: string | null; postedMin: number | null }): 'live' | 'to_post' | 'posted' | 'posted_different' {
  if (line.id === null) return 'live';
  if (line.postedAt === null) return 'to_post';
  return line.postedMin === null ? 'posted' : 'posted_different';
}
```

```ts
// oxeio-monitor/web/src/api/hoursStatement.ts
import { api } from './client';

/** Hours statement — server `hours-statement/` (owner and finance). Hours only, never money. */
export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'no_recipients' | 'not_configured' | 'no_staff';

export interface PeriodSummary {
  id: number;
  start: string;
  end: string;
  open: boolean;
  snapshotAt: string | null;
  deliveryStatus: DeliveryStatus | null;
  sentAt: string | null;
  deliveryError: string | null;
}

export interface StatementLine {
  id: number | null;
  employeeId: number;
  empCode: string;
  fullName: string;
  fromDate: string;
  toDate: string;
  measuredSec: number;
  carryInSec: number;
  toPostMin: number;
  leaveDays: number;
  holidayDays: number;
  noDataDays: number;
  postedMin: number | null;
  postedAt: string | null;
  postedBy: string | null;
  note: string | null;
}

export interface StatementDay {
  fullName: string;
  empCode: string;
  date: string;
  arrived: string | null;
  left: string | null;
  presenceHours: number;
  activeHours: number;
  adjustmentHours: number;
  creditedHours: number;
}

export const listPeriods = (signal?: AbortSignal) => api<PeriodSummary[]>('/hours-statement/periods', { signal });
export const getPeriod = (id: number, signal?: AbortSignal) =>
  api<{ period: PeriodSummary; locked: boolean; lines: StatementLine[] }>(`/hours-statement/periods/${id}`, { signal });
export const personDays = (id: number, employeeId: number, signal?: AbortSignal) =>
  api<StatementDay[]>(`/hours-statement/periods/${id}/people/${employeeId}`, { signal });
export const markPosted = (lineId: number, body: { postedMin?: number; note?: string }) =>
  api(`/hours-statement/lines/${lineId}/posted`, { method: 'POST', body });
export const unmarkPosted = (lineId: number) => api(`/hours-statement/lines/${lineId}/posted`, { method: 'DELETE' });
export const resendPeriod = (id: number) => api<{ status: DeliveryStatus }>(`/hours-statement/periods/${id}/resend`, { method: 'POST' });
export const periodFilePath = (id: number) => `/hours-statement/periods/${id}/file`;

export interface PayPeriodSettings {
  cutoffDay: number | 'end';
  sendTime: string;
  open: { start: string; end: string } | null;
}
export const getPayPeriodSettings = (signal?: AbortSignal) => api<PayPeriodSettings>('/settings/pay-period', { signal });
export const savePayPeriodSettings = (body: { cutoffDay: number | 'end'; sendTime: string }) =>
  api<PayPeriodSettings>('/settings/pay-period', { method: 'PUT', body });
```

For the file download, use the helper the Reports page uses (look in `web/src/lib/` for the download function and how `ReportsPage` calls it) with `periodFilePath(id)`.

- [ ] **Step 5: The page**

`HoursStatementPage.tsx`:
- Loads `listPeriods`; the selected period comes from `?period=<id>` (the email's link) or the newest frozen one, falling back to the open one.
- Header: period picker (each option `periodLabel(start, end)` plus "in progress" for the open one); delivery status line ("Sent on …", "Not sent: SMTP is not set up", "No recipients — add a finance login or an address in Settings → Notifications", "Failed: <error>"); owner only: "Resend" button; everyone: "Download spreadsheet".
- Open period: a notice "In progress — partial figures, not final".
- Table columns: Person · Hours in the period (`hm(Math.floor(measuredSec / 60))`) · Carried over (`hm(Math.trunc(carryInSec / 60))`) · **To post** (`hm(toPostMin)`, bold; red when negative) · Leave / holidays · Workdays with no time (warning colour when > 0) · Status (`lineStatus`) · action.
- Action per frozen, unlocked line: "Mark as posted" opens `PostedDialog` (number of hours + minutes prefilled from `toPostMin`, optional note; sends `postedMin` only when changed); a posted line shows "Posted by X on <date>" (+ the different value) and "Undo". Locked lines show the mark read-only.
- Clicking a person expands their days (`personDays`): date, first use, last use, presence, active, adjustment.

Build it from the shared pieces the other pages use (`Page`, `Card`, `Table`, `Modal`, `TextField`, `MiniButton`, `useApi`, `useMutation`, `Notice`, `ServerError`) — open `pages/payroll/PaySheet.tsx` as the model for a period-picker + table page and follow its structure and class names.

`PostedDialog.tsx`: a `Modal` with two number fields (hours, minutes) and a note; submit calls `markPosted(line.id, { postedMin: hours * 60 + minutes === line.toPostMin ? undefined : hours * 60 + minutes, note })`.

- [ ] **Step 6: The settings card**

`PayPeriodTab.tsx`: loads `getPayPeriodSettings`; a select "Cutoff day" with options `End of month` and `1`–`28`; a time field "Send at"; text: "The statement for each period is emailed the day after the cutoff at this time, to every finance login and the addresses in Settings → Notifications."; shows the open period ("Current period: 26/09 – 25/10"); Save calls `savePayPeriodSettings` and reloads.
Register it: in `sections.ts`, Work group, a tab `{ id: 'hours', label: 'Hours statement', manager: false, subtitle: 'Pay period cutoff and when the statement is sent', feature: 'hoursStatement' }`; in `SettingsPage.tsx`, `{active.id === 'hours' && <PayPeriodTab />}`.

- [ ] **Step 7: Translations, suites, browser**

Add every new English key to `pt-BR` and `es` (e.g. "Hours statement" → "Fechamento de horas" / "Cierre de horas"; "To post" → "A lançar" / "A registrar"; "Mark as posted" → "Marcar como lançado" / "Marcar como registrado"; "Carried over" → "Ajuste anterior" / "Ajuste anterior"; "Finance — the hours statement only; nothing else" → "Financeiro — só o fechamento de horas; nada mais" / "Finanzas — solo el cierre de horas; nada más"; "Cutoff day" → "Dia de corte" / "Día de corte"; "End of month" → "Fim do mês" / "Fin de mes"), and the new server messages (`'The cutoff day must be from 1 to 28, or the end of the month'`, `"The send time must be in 'HH:MM' format"`, `'This period is closed: a later statement already used it'`, `'This period is still open — there is nothing to send yet'`, `'Pay period not found'`, `'Line not found'`) to both `server.json`.

Run: `npm test && npm run typecheck && npm run lint` (web). Expected: PASS.

In the browser: as owner, Settings → Hours statement: set cutoff 25; Staff → a portal login → role Finance; sign in as that login: only "Hours statement" in the menu, it is the landing page, no 403 in the browser console during load; the open period shows live figures. (To see a frozen period locally, call the job's `tick` from a test or set the period's end in the database to yesterday and wait for minute 10.)

- [ ] **Step 8: Commit**

```bash
git add -A oxeio-monitor/web
git commit -m "feat(web): Hours statement screen, finance role and the pay period settings"
```

---

### Task 9: Docs and full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `oxeio-monitor/deploy/README.md`

- [ ] **Step 1: Document**

`docs/ARCHITECTURE.md`:
- API table: `| `hours-statement/` | pay periods with a cutoff day, the hours statement of hourly staff (snapshot, carry-over ledger, email, spreadsheet), the hourly job, posted marks. Rules: `pay-period.rules.ts`, `ledger.rules.ts`, `statement.rules.ts` |`
- Roles: "`finance` (the hours statement only — refused on every route that does not name it; shell routes carry `@EveryRole()`)".
- Modules table: `| `hoursStatement` | pay periods and the hours statement for hourly staff, the finance role's screen | |`
- Settings table: `| Settings → Hours statement | `payPeriod` | — (screen only) |`
- A short section "Hours statement": the period rule (day after the previous end through the next cutoff), the open period as anchor, the job at minute 10 deciding by the clock, the ledger formula, posted marks and the lock, no money anywhere.
- Dashboard tables: `hours` page and `hoursStatement` api.

`deploy/README.md`: a paragraph on the statement link — it uses `PUBLIC_URL` (already used by the setup link) to put a link to the screen in the email; without it the email has no link.

- [ ] **Step 2: Run every suite**

Run (server): `npm test && npm run typecheck && npm run lint`
Run (web): `npm test && npm run typecheck && npm run lint`
Run (agent): `dotnet test tests/oXeio.Core.Tests` (in `oxeio-monitor/agent`)
Run (in `oxeio-monitor`): `docker compose build api web`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md oxeio-monitor/deploy/README.md
git commit -m "docs: the hours statement, the finance role and pay periods"
```
