# Delivery 3 — Schedule compliance: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A work policy can enforce a fixed schedule: each workday the server records arrival, leaving and the break, flags late arrival, early leaving, a short or missing break and no-shows, and shows them on a Schedule screen and in the daily summary.

**Architecture:** One pure rule (`schedule/schedule.rules.ts`) works in minutes since local midnight on the day's presence blocks (Delivery 2's `presenceSpans`). The day roll-up (`SummaryService.refreshDate`, every 15 minutes and at day close) hands each person's active stretches to `ScheduleService.writeDay`, which stores one row per person per checked day in `schedule_days`. Screens and the digest only read that table.

**Tech Stack:** NestJS 11, Prisma 6, vitest; React 19, i18next.

**Spec:** `docs/superpowers/specs/2026-10-09-work-hours-and-pay-period-design.md` § 6 (and § 1a). Index and working rules: `docs/superpowers/plans/2026-10-09-work-hours-index.md`. **Requires Delivery 2** (`presenceSpans`, `measureOf`, `MEASURE_SELECT`, `datesToRecount`).

## Global Constraints

- `scheduleEnforced` defaults to false; tolerances default 0 / 0, range 0–60 minutes.
- The schedule uses the policy's existing `officeFrom`/`officeTo` (start/end) and `breakMinutes`; the break window is new and, when empty, is the whole working day.
- Weekly days off, public holidays and recorded leave are never checked; no row is kept for them.
- A breach that cannot be decided yet (the day is still running) is not reported: late only once someone arrived, early leave only after the end time, the break only once the window plus the break length has passed, no-show only after the end time.
- Hours outside the schedule are information (balance), never pay.
- Generic text; screen text in `en`/`pt-BR`/`es`. The digest stays English like the rest of it.
- Branch `feat/schedule-compliance` off `pericialmed` (after Delivery 2 is merged).

## Review Focus

1. A break split in two pieces (40 + 25 min) when 60 are required is "short", not "taken" — test in Task 1.
2. A day still in progress at 10:00 must show no early-leave or break breach — test in Task 1.
3. Arrival 4 min late and leaving 7 min early with tolerances 8/10: both reported (11 > 10) even though each is under 8 — test in Task 1.
4. A presence block ending at the work day's midnight cut maps to minute 1440, not 0 — test in Task 2.
5. Switching the schedule off removes the person's rows for the open months on the next recount, so the screen does not keep stale breaches — test in Task 3.

---

### Task 1: The schedule rule (pure)

**Files:**
- Create: `oxeio-monitor/server/src/schedule/schedule.rules.ts`
- Test: `oxeio-monitor/server/test/schedule.rules.spec.ts`

**Interfaces:**
- Produces:
  - `type Breach = 'late' | 'early_leave' | 'break_short' | 'break_missing' | 'no_show'`
  - `interface SchedulePolicy { startMin: number; endMin: number; breakMin: number; breakFromMin: number; breakToMin: number; toleranceMarkMin: number; toleranceDayMin: number }`
  - `interface DayBlock { fromMin: number; toMin: number }` (minutes since local midnight, 0–1440)
  - `interface ScheduleDay { arrivedMin: number | null; leftMin: number | null; breakStartMin: number | null; breakMin: number; lateMin: number; earlyLeaveMin: number; balanceMin: number; breaches: Breach[]; final: boolean }`
  - `checkDay(input: { blocks: readonly DayBlock[]; policy: SchedulePolicy; nowMin: number }): ScheduleDay` — `nowMin` is 1440 once the day is over
  - `MINUTES_PER_DAY = 1440`
  - `monthTotals(days: readonly ScheduleDay[]): { late: number; earlyLeave: number; breakShort: number; breakMissing: number; noShow: number; balanceMin: number }`

- [ ] **Step 1: Write the failing test**

```ts
// oxeio-monitor/server/test/schedule.rules.spec.ts
import { describe, expect, it } from 'vitest';

import { checkDay, monthTotals, type DayBlock, type SchedulePolicy } from '../src/schedule/schedule.rules';

const m = (hhmm: string) => {
  const [h, mm] = hhmm.split(':').map(Number);
  return h * 60 + mm;
};
const block = (from: string, to: string): DayBlock => ({ fromMin: m(from), toMin: m(to) });

/** 08:00–17:00, 60-minute break starting between 11:00 and 14:00 */
const policy: SchedulePolicy = {
  startMin: m('08:00'),
  endMin: m('17:00'),
  breakMin: 60,
  breakFromMin: m('11:00'),
  breakToMin: m('14:00'),
  toleranceMarkMin: 5,
  toleranceDayMin: 10,
};
const DAY_OVER = 1440;

describe('checkDay — a full day', () => {
  it('kept the schedule: no breaches, balance 0', () => {
    const day = checkDay({ blocks: [block('08:00', '12:00'), block('13:00', '17:00')], policy, nowMin: DAY_OVER });
    expect(day).toEqual({
      arrivedMin: m('08:00'),
      leftMin: m('17:00'),
      breakStartMin: m('12:00'),
      breakMin: 60,
      lateMin: 0,
      earlyLeaveMin: 0,
      balanceMin: 0,
      breaches: [],
      final: true,
    });
  });

  it('within the per-mark tolerance on both ends and under the daily one: nothing', () => {
    const day = checkDay({ blocks: [block('08:04', '12:00'), block('13:00', '16:56')], policy, nowMin: DAY_OVER });
    expect(day.breaches).toEqual([]);
  });

  // with two marks a day, the daily limit only bites when it is below twice the per-mark one
  it('each within the per-mark tolerance but together over the daily one: both reported', () => {
    const day = checkDay({
      blocks: [block('08:04', '12:00'), block('13:00', '16:53')],
      policy: { ...policy, toleranceMarkMin: 8 },
      nowMin: DAY_OVER,
    });
    expect(day.breaches).toEqual(['late', 'early_leave']);
    expect(day.lateMin).toBe(4);
    expect(day.earlyLeaveMin).toBe(7);
  });

  it('late beyond the per-mark tolerance', () => {
    const day = checkDay({ blocks: [block('08:12', '12:00'), block('13:00', '17:00')], policy, nowMin: DAY_OVER });
    expect(day.breaches).toEqual(['late']);
    expect(day.lateMin).toBe(12);
    expect(day.balanceMin).toBe(-12);
  });

  it('a break split in two pieces is short, not taken', () => {
    const day = checkDay({
      blocks: [block('08:00', '11:30'), block('12:10', '12:20'), block('12:45', '17:00')],
      policy,
      nowMin: DAY_OVER,
    });
    expect(day.breakMin).toBe(40);
    expect(day.breakStartMin).toBe(m('11:30'));
    expect(day.breaches).toEqual(['break_short']);
  });

  it('a pause that starts before the window does not count as the break', () => {
    const day = checkDay({ blocks: [block('08:00', '10:30'), block('11:40', '17:00')], policy, nowMin: DAY_OVER });
    expect(day.breaches).toEqual(['break_missing']);
  });

  it('worked straight through: no break', () => {
    const day = checkDay({ blocks: [block('08:00', '17:00')], policy, nowMin: DAY_OVER });
    expect(day.breaches).toEqual(['break_missing']);
    expect(day.balanceMin).toBe(60);
  });

  it('no activity on a checked day: no-show', () => {
    const day = checkDay({ blocks: [], policy, nowMin: DAY_OVER });
    expect(day.breaches).toEqual(['no_show']);
    expect(day.arrivedMin).toBeNull();
    expect(day.balanceMin).toBe(-480);
  });

  it('arriving early and staying late is a positive balance, not a breach', () => {
    const day = checkDay({ blocks: [block('07:30', '12:00'), block('13:00', '17:40')], policy, nowMin: DAY_OVER });
    expect(day.breaches).toEqual([]);
    expect(day.balanceMin).toBe(70);
  });
});

describe('checkDay — while the day is running', () => {
  it('at 10:00, on time so far: nothing to report, not final', () => {
    const day = checkDay({ blocks: [block('08:00', '10:00')], policy, nowMin: m('10:00') });
    expect(day.breaches).toEqual([]);
    expect(day.final).toBe(false);
  });

  it('late is reported as soon as the person arrives', () => {
    expect(checkDay({ blocks: [block('08:20', '09:00')], policy, nowMin: m('09:00') }).breaches).toEqual(['late']);
  });

  it('nobody yet at 09:00: no no-show until the end time', () => {
    expect(checkDay({ blocks: [], policy, nowMin: m('09:00') }).breaches).toEqual([]);
    expect(checkDay({ blocks: [], policy, nowMin: m('17:01') }).breaches).toEqual(['no_show']);
  });

  it('an ongoing pause inside the window counts toward the break', () => {
    const day = checkDay({ blocks: [block('08:00', '12:00')], policy, nowMin: m('12:30') });
    expect(day.breakStartMin).toBe(m('12:00'));
    expect(day.breakMin).toBe(30);
    expect(day.breaches).toEqual([]);
  });

  it('the break is judged once the window plus its length has passed', () => {
    const blocks = [block('08:00', '15:30')];
    expect(checkDay({ blocks, policy, nowMin: m('14:30') }).breaches).toEqual([]);
    expect(checkDay({ blocks, policy, nowMin: m('15:00') }).breaches).toEqual(['break_missing']);
  });

  it('early leave only after the end time', () => {
    const blocks = [block('08:00', '12:00'), block('13:00', '16:00')];
    expect(checkDay({ blocks, policy, nowMin: m('16:30') }).breaches).toEqual([]);
    expect(checkDay({ blocks, policy, nowMin: m('17:30') }).breaches).toEqual(['early_leave']);
  });
});

describe('monthTotals', () => {
  it('counts breaches by kind and adds the balance', () => {
    const days = [
      checkDay({ blocks: [block('08:12', '12:00'), block('13:00', '17:00')], policy, nowMin: DAY_OVER }),
      checkDay({ blocks: [block('08:00', '17:00')], policy, nowMin: DAY_OVER }),
      checkDay({ blocks: [], policy, nowMin: DAY_OVER }),
    ];
    expect(monthTotals(days)).toEqual({ late: 1, earlyLeave: 0, breakShort: 0, breakMissing: 1, noShow: 1, balanceMin: -12 + 60 - 480 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `oxeio-monitor/server`): `npm test -- test/schedule.rules.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// oxeio-monitor/server/src/schedule/schedule.rules.ts
/**
 * Schedule compliance — the pure rule.
 *
 * Input: the day's presence blocks (active stretches joined across short
 * pauses, summary.math `presenceSpans`) as minutes since local midnight, the
 * policy's schedule, and "now" in the same unit (1440 once the day is over).
 *
 * Tolerance works like a clock-in rule common in labour codes: up to
 * `toleranceMarkMin` off at each end is ignored, but if both ends together
 * exceed `toleranceDayMin`, both are reported. With 0 / 0 every minute counts.
 *
 * Nothing is reported before it can be known: a running day never shows an
 * early leave before the end time, nor a missing break before the break
 * window plus the break's length has passed.
 */

export type Breach = 'late' | 'early_leave' | 'break_short' | 'break_missing' | 'no_show';

export interface SchedulePolicy {
  startMin: number;
  endMin: number;
  /** the shortest continuous break that counts */
  breakMin: number;
  /** the break must start between these two times */
  breakFromMin: number;
  breakToMin: number;
  toleranceMarkMin: number;
  toleranceDayMin: number;
}

export interface DayBlock {
  fromMin: number;
  toMin: number;
}

export interface ScheduleDay {
  arrivedMin: number | null;
  leftMin: number | null;
  breakStartMin: number | null;
  breakMin: number;
  lateMin: number;
  earlyLeaveMin: number;
  /** presence minus the scheduled time (end − start − break); + = extra, − = short */
  balanceMin: number;
  breaches: Breach[];
  /** false while the day is still running */
  final: boolean;
}

export const MINUTES_PER_DAY = 1440;

export function checkDay(input: { blocks: readonly DayBlock[]; policy: SchedulePolicy; nowMin: number }): ScheduleDay {
  const { policy: p, nowMin } = input;
  const blocks = [...input.blocks].filter((b) => b.toMin > b.fromMin).sort((a, b) => a.fromMin - b.fromMin);
  const final = nowMin >= MINUTES_PER_DAY;
  const scheduledMin = p.endMin - p.startMin - p.breakMin;
  const presenceMin = blocks.reduce((total, b) => total + (b.toMin - b.fromMin), 0);
  const afterEnd = nowMin > p.endMin;

  if (blocks.length === 0) {
    return {
      arrivedMin: null,
      leftMin: null,
      breakStartMin: null,
      breakMin: 0,
      lateMin: 0,
      earlyLeaveMin: 0,
      balanceMin: -scheduledMin,
      breaches: afterEnd ? ['no_show'] : [],
      final,
    };
  }

  const arrivedMin = blocks[0].fromMin;
  const leftMin = blocks[blocks.length - 1].toMin;

  const rawLate = Math.max(0, arrivedMin - p.startMin);
  const rawEarly = afterEnd ? Math.max(0, p.endMin - leftMin) : 0;
  const overDay = rawLate + rawEarly > p.toleranceDayMin;
  const isLate = rawLate > p.toleranceMarkMin || (overDay && rawLate > 0);
  const isEarly = rawEarly > p.toleranceMarkMin || (overDay && rawEarly > 0);

  // gaps between blocks, plus the pause going on right now (only during working hours)
  const gaps: { start: number; length: number }[] = [];
  for (let i = 1; i < blocks.length; i += 1) {
    gaps.push({ start: blocks[i - 1].toMin, length: blocks[i].fromMin - blocks[i - 1].toMin });
  }
  if (!final && nowMin <= p.endMin && leftMin < nowMin) {
    gaps.push({ start: leftMin, length: nowMin - leftMin });
  }
  const inWindow = gaps.filter((g) => g.start >= p.breakFromMin && g.start <= p.breakToMin);
  const best = inWindow.reduce<{ start: number; length: number } | null>(
    (top, g) => (top === null || g.length > top.length ? g : top),
    null,
  );
  const breakJudged = final || nowMin >= p.breakToMin + p.breakMin;

  const breaches: Breach[] = [];
  if (isLate) breaches.push('late');
  if (isEarly) breaches.push('early_leave');
  if (breakJudged && p.breakMin > 0) {
    if (best === null) breaches.push('break_missing');
    else if (best.length < p.breakMin) breaches.push('break_short');
  }

  return {
    arrivedMin,
    leftMin,
    breakStartMin: best?.start ?? null,
    breakMin: best?.length ?? 0,
    lateMin: isLate ? rawLate : 0,
    earlyLeaveMin: isEarly ? rawEarly : 0,
    balanceMin: presenceMin - scheduledMin,
    breaches,
    final,
  };
}

export function monthTotals(days: readonly Pick<ScheduleDay, 'breaches' | 'balanceMin'>[]) {
  const count = (b: Breach) => days.filter((d) => d.breaches.includes(b)).length;
  return {
    late: count('late'),
    earlyLeave: count('early_leave'),
    breakShort: count('break_short'),
    breakMissing: count('break_missing'),
    noShow: count('no_show'),
    balanceMin: days.reduce((total, d) => total + d.balanceMin, 0),
  };
}
```

Check against the tests: "08:00–15:30 at 15:00" — window ends 14:00, break 60 → judged at 15:00; no gap → `break_missing`. "At 14:30" not judged yet. "08:00–12:00 at 12:30": ongoing gap from 12:00 (in window) of 30 min, not yet judged → no breach.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/schedule.rules.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add oxeio-monitor/server/src/schedule/schedule.rules.ts oxeio-monitor/server/test/schedule.rules.spec.ts
git commit -m "feat(server): schedule compliance rule — late, early leave, break, no-show"
```

---

### Task 2: Policy fields, the `schedule_days` table and the minute clock

**Files:**
- Create: `oxeio-monitor/server/prisma/migrations/20261013120000_schedule_compliance/migration.sql`
- Modify: `oxeio-monitor/server/prisma/schema.prisma` (`WorkPolicy` fields, `model ScheduleDay`, `Employee.scheduleDays`)
- Create: `oxeio-monitor/server/src/schedule/schedule-policy.ts` (policy row → `SchedulePolicy`, instant → minute)
- Modify: `oxeio-monitor/server/test/setup/harness.ts` (truncate `schedule_days`)
- Test: `oxeio-monitor/server/test/schedule-policy.spec.ts`

**Interfaces:**
- Consumes: `SchedulePolicy`, `MINUTES_PER_DAY` (Task 1); `hhmmToMinutes` (`calendar/work-policy.rules.ts`); `workWallOf`, `startOfWorkDate`, `nextLocalMidnight` (`agent/util/work-time.ts`).
- Produces:
  - Prisma `WorkPolicy.scheduleEnforced: Boolean @default(false)`, `breakWindowFrom/To: String? @db.VarChar(5)`, `toleranceMarkMin: Int @default(0)`, `toleranceDayMin: Int @default(0)`
  - Prisma `ScheduleDay` (`schedule_days`): `employeeId`, `workDate`, `arrivedMin?`, `leftMin?`, `breakStartMin?`, `breakMin`, `lateMin`, `earlyLeaveMin`, `balanceMin` (SmallInt), `breaches String[]`, `final Boolean`, `computedAt`; PK (employeeId, workDate)
  - `SCHEDULE_SELECT = { scheduleEnforced, officeFrom, officeTo, breakMinutes, breakWindowFrom, breakWindowTo, toleranceMarkMin, toleranceDayMin }` (all `true`)
  - `schedulePolicyOf(row: ScheduleRow | null | undefined): SchedulePolicy | null`
  - `minuteOfWorkDay(instant: Date, workDate: Date): number` (0–1440)

- [ ] **Step 1: Schema and migration**

In `model WorkPolicy`, after `officeTo`:

```prisma
  /// Check each workday against the schedule (officeFrom–officeTo, breakMinutes): late, early leave, break
  scheduleEnforced   Boolean @default(false) @map("schedule_enforced")
  /// 'HH:MM': the break must START inside this window; null = anywhere in the working day
  breakWindowFrom    String? @map("break_window_from") @db.VarChar(5)
  breakWindowTo      String? @map("break_window_to") @db.VarChar(5)
  /// minutes ignored at each end (arrival, leaving); 0 = every minute counts
  toleranceMarkMin   Int     @default(0) @map("tolerance_mark_min")
  /// at most this many a day across both ends; above it, both ends are reported
  toleranceDayMin    Int     @default(0) @map("tolerance_day_min")
```

New model (after `DailySummary`), and `scheduleDays ScheduleDay[]` in `Employee`'s relation list:

```prisma
/// One checked workday of someone on a policy with `schedule_enforced` (src/schedule/).
/// Times are minutes since the work zone's midnight (0–1440). Days off, holidays and
/// leave have no row.
model ScheduleDay {
  employeeId    Int      @map("employee_id")
  workDate      DateTime @map("work_date") @db.Date
  arrivedMin    Int?     @map("arrived_min") @db.SmallInt
  leftMin       Int?     @map("left_min") @db.SmallInt
  breakStartMin Int?     @map("break_start_min") @db.SmallInt
  breakMin      Int      @default(0) @map("break_min") @db.SmallInt
  lateMin       Int      @default(0) @map("late_min") @db.SmallInt
  earlyLeaveMin Int      @default(0) @map("early_leave_min") @db.SmallInt
  /// presence − scheduled minutes; information only, never pay
  balanceMin    Int      @default(0) @map("balance_min") @db.SmallInt
  /// late | early_leave | break_short | break_missing | no_show
  breaches      String[] @default([])
  /// false while the day is still running
  final         Boolean  @default(false)
  computedAt    DateTime @default(now()) @map("computed_at") @db.Timestamptz(3)

  employee Employee @relation(fields: [employeeId], references: [id])

  @@id([employeeId, workDate])
  @@index([workDate])
  @@map("schedule_days")
}
```

```sql
-- oxeio-monitor/server/prisma/migrations/20261013120000_schedule_compliance/migration.sql
-- AlterTable
ALTER TABLE "work_policies" ADD COLUMN     "schedule_enforced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "break_window_from" VARCHAR(5),
ADD COLUMN     "break_window_to" VARCHAR(5),
ADD COLUMN     "tolerance_mark_min" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tolerance_day_min" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "schedule_days" (
    "employee_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "arrived_min" SMALLINT,
    "left_min" SMALLINT,
    "break_start_min" SMALLINT,
    "break_min" SMALLINT NOT NULL DEFAULT 0,
    "late_min" SMALLINT NOT NULL DEFAULT 0,
    "early_leave_min" SMALLINT NOT NULL DEFAULT 0,
    "balance_min" SMALLINT NOT NULL DEFAULT 0,
    "breaches" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "final" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_days_pkey" PRIMARY KEY ("employee_id","work_date")
);

-- CreateIndex
CREATE INDEX "schedule_days_work_date_idx" ON "schedule_days"("work_date");

-- AddForeignKey
ALTER TABLE "schedule_days" ADD CONSTRAINT "schedule_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

Run `npx prisma generate`. Then compare with what Prisma would write: `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script --shadow-database-url "$SHADOW_URL"` if a shadow database is at hand; otherwise trust the test run in Step 5 (it applies the migration and Prisma fails on a schema mismatch at query time).

In `test/setup/harness.ts`, add `schedule_days` to the `TRUNCATE TABLE` list (before `employees` is fine; `CASCADE` covers order).

- [ ] **Step 2: Write the failing test**

```ts
// oxeio-monitor/server/test/schedule-policy.spec.ts
import { describe, expect, it } from 'vitest';

import { minuteOfWorkDay, schedulePolicyOf } from '../src/schedule/schedule-policy';

/** Tests run in the pinned zone Etc/GMT-6 (UTC+6, no daylight saving). */
const workDate = new Date('2026-10-05T00:00:00.000Z');

describe('minuteOfWorkDay', () => {
  it('local wall-clock minutes of an instant on that work day', () => {
    expect(minuteOfWorkDay(new Date('2026-10-05T02:30:00Z'), workDate)).toBe(8 * 60 + 30);
  });
  it('the midnight cut that ends the day is 1440, not 0', () => {
    expect(minuteOfWorkDay(new Date('2026-10-05T18:00:00Z'), workDate)).toBe(1440);
  });
  it('before the day: 0', () => {
    expect(minuteOfWorkDay(new Date('2026-10-04T17:00:00Z'), workDate)).toBe(0);
  });
});

describe('schedulePolicyOf', () => {
  const row = {
    scheduleEnforced: true,
    officeFrom: '08:00',
    officeTo: '17:00',
    breakMinutes: 60,
    breakWindowFrom: '11:00',
    breakWindowTo: '14:00',
    toleranceMarkMin: 5,
    toleranceDayMin: 10,
  };

  it('turns the row into minutes', () => {
    expect(schedulePolicyOf(row)).toEqual({ startMin: 480, endMin: 1020, breakMin: 60, breakFromMin: 660, breakToMin: 840, toleranceMarkMin: 5, toleranceDayMin: 10 });
  });
  it('not enforced, or no office hours: null', () => {
    expect(schedulePolicyOf({ ...row, scheduleEnforced: false })).toBeNull();
    expect(schedulePolicyOf({ ...row, officeFrom: null })).toBeNull();
    expect(schedulePolicyOf(null)).toBeNull();
  });
  it('no window: the whole working day; no break minutes: 0', () => {
    expect(schedulePolicyOf({ ...row, breakWindowFrom: null, breakWindowTo: null, breakMinutes: null })).toMatchObject({ breakMin: 0, breakFromMin: 480, breakToMin: 1020 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/schedule-policy.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// oxeio-monitor/server/src/schedule/schedule-policy.ts
import { nextLocalMidnight, startOfWorkDate, workWallOf } from '../agent/util/work-time';
import { hhmmToMinutes } from '../calendar/work-policy.rules';
import { MINUTES_PER_DAY, type SchedulePolicy } from './schedule.rules';

/** The policy fields a query must select for schedulePolicyOf() */
export const SCHEDULE_SELECT = {
  scheduleEnforced: true,
  officeFrom: true,
  officeTo: true,
  breakMinutes: true,
  breakWindowFrom: true,
  breakWindowTo: true,
  toleranceMarkMin: true,
  toleranceDayMin: true,
} as const;

export interface ScheduleRow {
  scheduleEnforced: boolean;
  officeFrom: string | null;
  officeTo: string | null;
  breakMinutes: number | null;
  breakWindowFrom: string | null;
  breakWindowTo: string | null;
  toleranceMarkMin: number;
  toleranceDayMin: number;
}

/** The schedule to check, or null when this policy checks none */
export function schedulePolicyOf(row: ScheduleRow | null | undefined): SchedulePolicy | null {
  if (!row?.scheduleEnforced || !row.officeFrom || !row.officeTo) return null;
  const startMin = hhmmToMinutes(row.officeFrom);
  const endMin = hhmmToMinutes(row.officeTo);
  if (startMin === null || endMin === null || endMin <= startMin) return null;

  const from = row.breakWindowFrom ? hhmmToMinutes(row.breakWindowFrom) : null;
  const to = row.breakWindowTo ? hhmmToMinutes(row.breakWindowTo) : null;
  return {
    startMin,
    endMin,
    breakMin: row.breakMinutes ?? 0,
    breakFromMin: from ?? startMin,
    breakToMin: to ?? endMin,
    toleranceMarkMin: row.toleranceMarkMin,
    toleranceDayMin: row.toleranceDayMin,
  };
}

/**
 * Minutes since the work zone's midnight on `workDate`, by the wall clock
 * (so 08:00 is 480 even on a daylight-saving day). The instant that ends the
 * day — the next local midnight — is 1440, not 0.
 */
export function minuteOfWorkDay(instant: Date, workDate: Date): number {
  const start = startOfWorkDate(workDate);
  if (instant <= start) return 0;
  if (instant >= nextLocalMidnight(start)) return MINUTES_PER_DAY;
  const wall = workWallOf(instant);
  return wall.getUTCHours() * 60 + wall.getUTCMinutes();
}
```

Check `startOfWorkDate`'s parameter (`work-time.ts:63`): it takes the UTC-midnight work date and returns the instant of local midnight; `nextLocalMidnight(instant)` returns the next local midnight after it. If their contracts differ, adapt the two lines that compute `start` and the end.

- [ ] **Step 5: Run tests**

Run: `npm test -- test/schedule-policy.spec.ts test/schedule.rules.spec.ts test/work-timezone.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A oxeio-monitor/server/prisma oxeio-monitor/server/src/schedule oxeio-monitor/server/test
git commit -m "feat(server): schedule fields on work policies and the schedule_days table"
```

---

### Task 3: Write the days from the roll-up; policy endpoints

**Files:**
- Create: `oxeio-monitor/server/src/schedule/schedule.service.ts`, `oxeio-monitor/server/src/schedule/schedule.module.ts`
- Modify: `oxeio-monitor/server/src/summary/summary.module.ts` (import `ScheduleModule`), `summary/summary.service.ts` (call `writeDay`)
- Modify: `oxeio-monitor/server/src/calendar/work-policy.rules.ts` (`scheduleProblem`), `calendar/calendar.dto.ts`, `calendar/work-policies.service.ts`
- Modify: `oxeio-monitor/server/src/app.module.ts` (import `ScheduleModule` if not reached through `SummaryModule`)
- Test: `oxeio-monitor/server/test/schedule.e2e.spec.ts`, `oxeio-monitor/server/test/admin-work-policy.spec.ts` (add `scheduleProblem` cases)

**Interfaces:**
- Consumes: `checkDay`, `SchedulePolicy` (Task 1); `schedulePolicyOf`, `SCHEDULE_SELECT`, `minuteOfWorkDay` (Task 2); `presenceSpans`, `Span` (Delivery 2); `datesToRecount` (Delivery 2).
- Produces:
  - `ScheduleService.writeDay(workDate: Date, people: ScheduleInput[], now: Date): Promise<void>` with `interface ScheduleInput { employeeId: number; schedule: SchedulePolicy | null; presenceGapSec: number; checked: boolean; active: readonly Span[] }`
  - `scheduleProblem(input: { scheduleEnforced: boolean; officeFrom: string | null; officeTo: string | null; breakMinutes: number | null; breakWindowFrom: string | null; breakWindowTo: string | null; toleranceMarkMin: number; toleranceDayMin: number }): string | null`
  - `WorkPolicyView` + DTOs gain `scheduleEnforced`, `breakWindowFrom`, `breakWindowTo`, `toleranceMarkMin`, `toleranceDayMin`

- [ ] **Step 1: Write the failing tests**

Append to `test/admin-work-policy.spec.ts` (create the `describe` there; keep its existing imports style):

```ts
import { scheduleProblem } from '../src/calendar/work-policy.rules';

describe('scheduleProblem', () => {
  const ok = {
    scheduleEnforced: true,
    officeFrom: '08:00',
    officeTo: '17:00',
    breakMinutes: 60,
    breakWindowFrom: '11:00',
    breakWindowTo: '14:00',
    toleranceMarkMin: 5,
    toleranceDayMin: 10,
  };
  it('a complete schedule is fine; off needs nothing', () => {
    expect(scheduleProblem(ok)).toBeNull();
    expect(scheduleProblem({ ...ok, scheduleEnforced: false, officeFrom: null })).toBeNull();
  });
  it('enforced needs both working-hour ends', () => {
    expect(scheduleProblem({ ...ok, officeTo: null })).toMatch(/working hours/);
  });
  it('the break window: both ends or neither, inside the day, in order', () => {
    expect(scheduleProblem({ ...ok, breakWindowTo: null })).toMatch(/both/);
    expect(scheduleProblem({ ...ok, breakWindowFrom: '07:00' })).toMatch(/inside/);
    expect(scheduleProblem({ ...ok, breakWindowFrom: '14:00', breakWindowTo: '11:00' })).toMatch(/before/);
  });
  it('the break must be shorter than the day; tolerances 0–60', () => {
    expect(scheduleProblem({ ...ok, breakMinutes: 540 })).toMatch(/shorter/);
    expect(scheduleProblem({ ...ok, toleranceMarkMin: 61 })).toMatch(/0 and 60/);
    expect(scheduleProblem({ ...ok, toleranceDayMin: -1 })).toMatch(/0 and 60/);
  });
});
```

```ts
// oxeio-monitor/server/test/schedule.e2e.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SummaryService } from '../src/summary/summary.service';
import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/** Zone Etc/GMT-6: local 08:00 on 2026-10-05 is 02:00Z. */
let h: Harness;
let owner: Session;
const workDate = new Date('2026-10-05T00:00:00.000Z');
const DAY_OVER = new Date('2026-10-06T06:00:00Z');

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

const local = (hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 5, hh - 6, mm));
};

async function enforce(on: boolean) {
  const policy = await h.prisma.workPolicy.findFirstOrThrow();
  return owner.http
    .patch(`/api/v1/work-policies/${policy.id}`)
    .set('X-CSRF-Token', owner.csrf)
    .send({
      scheduleEnforced: on,
      officeFrom: '08:00',
      officeTo: '17:00',
      breakMinutes: 60,
      breakWindowFrom: '11:00',
      breakWindowTo: '14:00',
      toleranceMarkMin: 5,
      toleranceDayMin: 10,
    });
}

async function dayWith(stretches: [string, string][]) {
  const { employeeId, code } = await createEmployeeWithCode(h.prisma);
  const { deviceId } = await enrollDevice(h, code);
  const session = await h.prisma.workSession.create({ data: { employeeId, deviceId, workDate, startedAt: local('07:00') } });
  for (const [from, to] of stretches) {
    await h.prisma.activitySegment.create({
      data: {
        sessionId: session.id,
        employeeId,
        deviceId,
        clientUuid: crypto.randomUUID(),
        workDate,
        state: 'active',
        startedAt: local(from),
        endedAt: local(to),
        durationSec: (local(to).getTime() - local(from).getTime()) / 1000,
        countsAsWork: true,
      },
    });
  }
  return employeeId;
}

describe('schedule days from the roll-up', () => {
  it('a late arrival and a short break are stored', async () => {
    await enforce(true).expect(200);
    const employeeId = await dayWith([['08:20', '12:00'], ['12:30', '17:00']]);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);

    const row = await h.prisma.scheduleDay.findUniqueOrThrow({ where: { employeeId_workDate: { employeeId, workDate } } });
    expect(row).toMatchObject({ arrivedMin: 500, leftMin: 1020, lateMin: 20, breakMin: 30, final: true });
    expect(row.breaches).toEqual(['late', 'break_short']);
  });

  it('no schedule enforced: no rows', async () => {
    await dayWith([['08:00', '17:00']]);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(0);
  });

  it('switching it off removes the rows on the next recount', async () => {
    await enforce(true).expect(200);
    await dayWith([['08:00', '17:00']]);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(1);

    await enforce(false).expect(200);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(0);
  });

  it('a day of recorded leave is not checked', async () => {
    await enforce(true).expect(200);
    const employeeId = await dayWith([]);
    await h.prisma.leave.create({ data: { employeeId, leaveDate: workDate, createdBy: OWNER_EMAIL } });
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(0);
  });

  it('changing the schedule queues the open months for recount', async () => {
    await enforce(true).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- test/admin-work-policy.spec.ts test/schedule.e2e.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Validation rule**

Append to `src/calendar/work-policy.rules.ts`:

```ts
export interface ScheduleInput {
  scheduleEnforced: boolean;
  officeFrom: string | null;
  officeTo: string | null;
  breakMinutes: number | null;
  breakWindowFrom: string | null;
  breakWindowTo: string | null;
  toleranceMarkMin: number;
  toleranceDayMin: number;
}

/** `null` if the schedule can be saved, otherwise why not (checked as it will be stored) */
export function scheduleProblem(s: ScheduleInput): string | null {
  for (const v of [s.toleranceMarkMin, s.toleranceDayMin]) {
    if (!Number.isInteger(v) || v < 0 || v > 60) return 'Tolerances must be whole minutes between 0 and 60';
  }
  if (!s.scheduleEnforced) return null;

  const start = s.officeFrom ? hhmmToMinutes(s.officeFrom) : null;
  const end = s.officeTo ? hhmmToMinutes(s.officeTo) : null;
  if (start === null || end === null) return 'A checked schedule needs the working hours (from and until)';
  if (start >= end) return 'The working hours must start before they end';
  if ((s.breakMinutes ?? 0) >= end - start) return 'The break must be shorter than the working day';

  if ((s.breakWindowFrom === null) !== (s.breakWindowTo === null)) {
    return 'Give both ends of the break window, or neither';
  }
  if (s.breakWindowFrom !== null && s.breakWindowTo !== null) {
    const from = hhmmToMinutes(s.breakWindowFrom);
    const to = hhmmToMinutes(s.breakWindowTo);
    if (from === null || to === null) return "The break window must be in 'HH:MM' format";
    if (from >= to) return 'The break window must start before it ends';
    if (from < start || to > end) return 'The break window must be inside the working hours';
  }
  return null;
}
```

- [ ] **Step 4: DTOs and the policy service**

In `calendar.dto.ts`, add to both create and update DTOs:

```ts
  @IsOptional() @IsBoolean()
  scheduleEnforced?: boolean;

  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(HHMM, { message: "breakWindowFrom must be in 'HH:MM' format" })
  breakWindowFrom?: string | null;

  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(HHMM, { message: "breakWindowTo must be in 'HH:MM' format" })
  breakWindowTo?: string | null;

  @IsOptional() @IsInt() @Min(0) @Max(60)
  toleranceMarkMin?: number;

  @IsOptional() @IsInt() @Min(0) @Max(60)
  toleranceDayMin?: number;
```

(`HHMM` is already defined in that file for `officeFrom`. Import `IsBoolean`, `ValidateIf` if missing.)

In `work-policies.service.ts`:

1. `WorkPolicyView` gains `scheduleEnforced: boolean; breakWindowFrom: string | null; breakWindowTo: string | null; toleranceMarkMin: number; toleranceDayMin: number;`, copied in `toView()`.
2. `create()` and `update()`: build the would-be stored schedule and validate it, then write the fields. In `update()` (after the office-hours block):

```ts
    const schedule = {
      scheduleEnforced: dto.scheduleEnforced ?? before.scheduleEnforced,
      officeFrom,
      officeTo,
      breakMinutes: dto.breakMinutes !== undefined ? dto.breakMinutes : before.breakMinutes,
      breakWindowFrom: dto.breakWindowFrom !== undefined ? dto.breakWindowFrom : before.breakWindowFrom,
      breakWindowTo: dto.breakWindowTo !== undefined ? dto.breakWindowTo : before.breakWindowTo,
      toleranceMarkMin: dto.toleranceMarkMin ?? before.toleranceMarkMin,
      toleranceDayMin: dto.toleranceDayMin ?? before.toleranceDayMin,
    };
    const scheduleError = scheduleProblem(schedule);
    if (scheduleError) throw new BadRequestException(scheduleError);
```

   add `scheduleEnforced: schedule.scheduleEnforced, breakWindowFrom: schedule.breakWindowFrom, breakWindowTo: schedule.breakWindowTo, toleranceMarkMin: schedule.toleranceMarkMin, toleranceDayMin: schedule.toleranceDayMin,` to `data`, and widen Delivery 2's recount condition:

```ts
    const scheduleChanged = (Object.keys(schedule) as (keyof typeof schedule)[]).some(
      (k) => schedule[k] !== before[k],
    );
    if (measureChanged || scheduleChanged) { /* the existing summaryDirty.createMany */ }
```

   In `create()` do the same validation with `before` replaced by the defaults (`scheduleEnforced: false`, windows `null`, tolerances `0`, `breakMinutes: dto.breakMinutes ?? null`).

- [ ] **Step 5: The service and the roll-up hook**

```ts
// oxeio-monitor/server/src/schedule/schedule.service.ts
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { presenceSpans, type Span } from '../summary/summary.math';
import { minuteOfWorkDay } from './schedule-policy';
import { checkDay, MINUTES_PER_DAY, type SchedulePolicy } from './schedule.rules';

export interface ScheduleInput {
  employeeId: number;
  /** null = this person's policy checks no schedule */
  schedule: SchedulePolicy | null;
  presenceGapSec: number;
  /** a workday for this person: not a day off, not a holiday, employed */
  checked: boolean;
  active: readonly Span[];
}

/**
 * Writes the schedule check of one work day, called by the day roll-up right
 * after it stores the day's hours. Rows exist only for checked days; a day
 * that stops being checked (schedule switched off, leave added) loses its row,
 * so the screen never shows a stale breach.
 */
@Injectable()
export class ScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  async writeDay(workDate: Date, people: readonly ScheduleInput[], now: Date): Promise<void> {
    if (people.length === 0) return;
    const ids = people.map((p) => p.employeeId);
    const onLeave = new Set(
      (
        await this.prisma.leave.findMany({
          where: { leaveDate: workDate, employeeId: { in: ids } },
          select: { employeeId: true },
        })
      ).map((l) => l.employeeId),
    );

    const nowMin = minuteOfWorkDay(now, workDate);
    const ops: Prisma.PrismaPromise<unknown>[] = [];

    for (const p of people) {
      const where = { employeeId_workDate: { employeeId: p.employeeId, workDate } };
      if (!p.schedule || !p.checked || onLeave.has(p.employeeId)) {
        ops.push(this.prisma.scheduleDay.deleteMany({ where: { employeeId: p.employeeId, workDate } }));
        continue;
      }
      const blocks = presenceSpans(p.active, p.presenceGapSec).map((s) => ({
        fromMin: minuteOfWorkDay(s.startedAt, workDate),
        toMin: minuteOfWorkDay(s.endedAt, workDate),
      }));
      const day = checkDay({ blocks, policy: p.schedule, nowMin: Math.min(nowMin, MINUTES_PER_DAY) });
      const data = { ...day, computedAt: now };
      ops.push(
        this.prisma.scheduleDay.upsert({
          where,
          create: { employeeId: p.employeeId, workDate, ...data },
          update: data,
        }),
      );
    }

    await this.prisma.$transaction(ops);
  }
}
```

```ts
// oxeio-monitor/server/src/schedule/schedule.module.ts
import { Module } from '@nestjs/common';

import { ScheduleService } from './schedule.service';

/** Schedule compliance: the day check (written by the roll-up), its screen and the digest block */
@Module({
  providers: [ScheduleService],
  exports: [ScheduleService],
})
export class ScheduleModule {}
```

(Name clash: `@nestjs/schedule` also exports a `ScheduleModule`. Wherever both are imported in one file — check `summary.module.ts` — import ours as `import { ScheduleModule as ScheduleCheckModule } from '../schedule/schedule.module'`.)

In `summary/summary.module.ts`: add our module to `imports`.

In `summary/summary.service.ts`:

1. Inject `private readonly schedule: ScheduleService` in the constructor.
2. `EmployeePolicy` gains `schedule: SchedulePolicy | null;`; `activeEmployees()` selects `policy: { select: { ...REGIME_SELECT, ...MEASURE_SELECT, ...SCHEDULE_SELECT } }` and returns `schedule: schedulePolicyOf(r.policy),`.
3. In `refreshDate()`, after `await this.prisma.$transaction(ops);` and before `refreshMonth`:

```ts
    // the schedule check reads the same segments; it never blocks the hours
    try {
      await this.schedule.writeDay(
        workDate,
        employees.map((e) => ({
          employeeId: e.id,
          schedule: e.schedule,
          presenceGapSec: e.presenceGapSec,
          checked:
            isWorkday(workDate, e.weeklyOffDays, holidays) &&
            (e.joinedOn === null || e.joinedOn <= workDate) &&
            (e.leftOn === null || e.leftOn >= workDate),
          active: (segmentsBy.get(e.id) ?? []).filter((s) => s.state === 'active'),
        })),
        now,
      );
    } catch (err) {
      this.logger.error(`Schedule check for ${workDate.toISOString().slice(0, 10)} failed: ${err instanceof Error ? err.message : err}`);
    }
```

Imports: `ScheduleService` from `'../schedule/schedule.service'`, `SCHEDULE_SELECT, schedulePolicyOf` from `'../schedule/schedule-policy'`, `type SchedulePolicy` from `'../schedule/schedule.rules'`.

Tests that build `SummaryService` by hand (`grep -rn "new SummaryService" oxeio-monitor/server/test`) need the extra constructor argument: pass `{ writeDay: async () => undefined } as unknown as ScheduleService`.

- [ ] **Step 6: Run tests**

Run: `npm test -- test/admin-work-policy.spec.ts test/schedule.e2e.spec.ts test/presence.e2e.spec.ts test/summary-late-days.e2e.spec.ts test/endpoints.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A oxeio-monitor/server
git commit -m "feat(server): the day roll-up records schedule compliance for checked policies"
```

---

### Task 4: Schedule endpoints and the digest block

**Files:**
- Create: `oxeio-monitor/server/src/schedule/schedule.controller.ts`, `oxeio-monitor/server/src/schedule/schedule.digest.ts`
- Modify: `schedule/schedule.module.ts` (controller), `schedule/schedule.service.ts` (`month`, `people`, `breachesOn`)
- Modify: `oxeio-monitor/server/src/digest/digest.module.ts` (import our module), `digest/digest.service.ts` (append the block)
- Test: `oxeio-monitor/server/test/schedule.digest.spec.ts`, `oxeio-monitor/server/test/schedule.e2e.spec.ts` (endpoint cases)

**Interfaces:**
- Consumes: `monthTotals` (Task 1).
- Produces:
  - `GET /api/v1/schedule/people` (owner, manager) → `{ id: number; fullName: string }[]` — active staff on a policy with `scheduleEnforced`
  - `GET /api/v1/schedule?employeeId=<id>&month=YYYY-MM` (owner, manager) → `ScheduleMonthView`:
    `{ employee: { id; fullName }; days: { date: string; arrivedMin: number | null; leftMin: number | null; breakStartMin: number | null; breakMin: number; lateMin: number; earlyLeaveMin: number; balanceMin: number; breaches: Breach[]; final: boolean }[]; totals: ReturnType<typeof monthTotals>; requiredBreakMin: number | null }`
  - `ScheduleService.breachesOn(workDate: Date): Promise<DigestBreach[]>`
  - `scheduleDigestLines(rows: readonly DigestBreach[]): string[]` with `interface DigestBreach { fullName: string; breaches: Breach[]; lateMin: number; earlyLeaveMin: number; breakMin: number; requiredBreakMin: number }`

- [ ] **Step 1: Write the failing digest test**

```ts
// oxeio-monitor/server/test/schedule.digest.spec.ts
import { describe, expect, it } from 'vitest';

import { scheduleDigestLines } from '../src/schedule/schedule.digest';

describe('scheduleDigestLines', () => {
  it('one line per person, each breach with its size', () => {
    expect(
      scheduleDigestLines([
        { fullName: 'Ana', breaches: ['late', 'break_short'], lateMin: 12, earlyLeaveMin: 0, breakMin: 40, requiredBreakMin: 60 },
        { fullName: 'Bo', breaches: ['no_show'], lateMin: 0, earlyLeaveMin: 0, breakMin: 0, requiredBreakMin: 60 },
        { fullName: 'Cy', breaches: ['early_leave', 'break_missing'], lateMin: 0, earlyLeaveMin: 25, breakMin: 0, requiredBreakMin: 60 },
      ]),
    ).toEqual([
      '• Ana — late 12 min · break 40 of 60 min',
      '• Bo — no activity on a scheduled day',
      '• Cy — left 25 min early · no break',
    ]);
  });

  it('nobody broke the schedule: no lines', () => {
    expect(scheduleDigestLines([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/schedule.digest.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the digest lines**

```ts
// oxeio-monitor/server/src/schedule/schedule.digest.ts
import type { Breach } from './schedule.rules';

export interface DigestBreach {
  fullName: string;
  breaches: Breach[];
  lateMin: number;
  earlyLeaveMin: number;
  breakMin: number;
  requiredBreakMin: number;
}

/** The daily summary's "Schedule today" lines (English, like the rest of the digest) */
export function scheduleDigestLines(rows: readonly DigestBreach[]): string[] {
  return rows.map((r) => {
    const parts = r.breaches.map((b) => {
      switch (b) {
        case 'late':
          return `late ${r.lateMin} min`;
        case 'early_leave':
          return `left ${r.earlyLeaveMin} min early`;
        case 'break_short':
          return `break ${r.breakMin} of ${r.requiredBreakMin} min`;
        case 'break_missing':
          return 'no break';
        default:
          return 'no activity on a scheduled day';
      }
    });
    return `• ${r.fullName} — ${parts.join(' · ')}`;
  });
}
```

- [ ] **Step 4: Service queries and controller**

Add to `ScheduleService`:

```ts
  /** Active staff whose policy checks a schedule — the Schedule screen's picker */
  async people(): Promise<{ id: number; fullName: string }[]> {
    return this.prisma.employee.findMany({
      where: { status: 'active', policy: { scheduleEnforced: true } },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });
  }

  async month(employeeId: number, yearMonth: string) {
    const from = new Date(`${yearMonth}-01T00:00:00.000Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, policy: { select: { breakMinutes: true, scheduleEnforced: true } } },
    });
    if (!employee) return null;
    const rows = await this.prisma.scheduleDay.findMany({
      where: { employeeId, workDate: { gte: from, lte: to } },
      orderBy: { workDate: 'asc' },
    });
    const days = rows.map((r) => ({
      date: r.workDate.toISOString().slice(0, 10),
      arrivedMin: r.arrivedMin,
      leftMin: r.leftMin,
      breakStartMin: r.breakStartMin,
      breakMin: r.breakMin,
      lateMin: r.lateMin,
      earlyLeaveMin: r.earlyLeaveMin,
      balanceMin: r.balanceMin,
      breaches: r.breaches as Breach[],
      final: r.final,
    }));
    return {
      employee: { id: employee.id, fullName: employee.fullName },
      days,
      totals: monthTotals(days),
      requiredBreakMin: employee.policy?.scheduleEnforced ? employee.policy.breakMinutes ?? 0 : null,
    };
  }

  /** Breaches recorded for a day, for the 18:30 summary */
  async breachesOn(workDate: Date): Promise<DigestBreach[]> {
    const rows = await this.prisma.scheduleDay.findMany({
      where: { workDate, NOT: { breaches: { isEmpty: true } } },
      select: {
        breaches: true,
        lateMin: true,
        earlyLeaveMin: true,
        breakMin: true,
        employee: { select: { fullName: true, policy: { select: { breakMinutes: true } } } },
      },
      orderBy: { employee: { fullName: 'asc' } },
    });
    return rows.map((r) => ({
      fullName: r.employee.fullName,
      breaches: r.breaches as Breach[],
      lateMin: r.lateMin,
      earlyLeaveMin: r.earlyLeaveMin,
      breakMin: r.breakMin,
      requiredBreakMin: r.employee.policy?.breakMinutes ?? 0,
    }));
  }
```

(imports: `monthTotals`, `type Breach` from `./schedule.rules`; `type DigestBreach` from `./schedule.digest`.)

```ts
// oxeio-monitor/server/src/schedule/schedule.controller.ts
import { BadRequestException, Controller, Get, NotFoundException, ParseIntPipe, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { Roles } from '../auth/decorators';
import { ScheduleService } from './schedule.service';

/** Who kept the schedule — owner and manager, like the rest of the team screens */
@Roles(UserRole.owner, UserRole.manager)
@Controller('schedule')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get('people')
  people() {
    return this.schedule.people();
  }

  @Get()
  async month(
    @Query('employeeId', ParseIntPipe) employeeId: number,
    @Query('month') month: string,
  ) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) {
      throw new BadRequestException("month must be in 'YYYY-MM' format");
    }
    const view = await this.schedule.month(employeeId, month);
    if (!view) throw new NotFoundException('Employee not found');
    return view;
  }
}
```

Register the controller in `schedule.module.ts` (`controllers: [ScheduleController]`).

- [ ] **Step 5: Append the block to the daily summary**

In `digest/digest.module.ts` import our schedule module (aliased if `@nestjs/schedule` is imported there). In `digest/digest.service.ts` inject `ScheduleService` and in `runOnce()`:

```ts
    const scheduleLines = scheduleDigestLines(await this.schedule.breachesOn(new Date(digest.workDate)));
    const scheduleBlock = scheduleLines.length > 0 ? `\n\nSchedule today\n${scheduleLines.join('\n')}` : '';
    const body = digestBody(digest, await this.organizationName()) + scheduleBlock;
```

and append the same `scheduleBlock` to the Telegram `plain` text before it is sent. `digest.workDate` is the `YYYY-MM-DD` work date string — check `Digest` in `digest.math.ts`; if it is a `Date`, pass it directly. In `test/digest.service.spec.ts` give the service a fake `{ breachesOn: async () => [] }` and add one case with a breach asserting the body contains `Schedule today`.

- [ ] **Step 6: Endpoint cases** — append to `test/schedule.e2e.spec.ts`:

```ts
describe('schedule endpoints', () => {
  it('the month view and its totals', async () => {
    await enforce(true).expect(200);
    const employeeId = await dayWith([['08:20', '12:00'], ['12:30', '17:00']]);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);

    const people = await owner.http.get('/api/v1/schedule/people').expect(200);
    expect(people.body.map((p: { id: number }) => p.id)).toContain(employeeId);

    const res = await owner.http.get(`/api/v1/schedule?employeeId=${employeeId}&month=2026-10`).expect(200);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.totals).toMatchObject({ late: 1, breakShort: 1 });
    expect(res.body.requiredBreakMin).toBe(60);
  });

  it('a bad month is a 400', async () => {
    await owner.http.get('/api/v1/schedule?employeeId=1&month=2026-13').expect(400);
  });
});
```

- [ ] **Step 7: Run tests**

Run: `npm test -- test/schedule.digest.spec.ts test/schedule.e2e.spec.ts test/digest.service.spec.ts test/endpoints.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A oxeio-monitor/server
git commit -m "feat(server): schedule month view and a 'Schedule today' block in the daily summary"
```

---

### Task 5: Dashboard — Schedule screen and policy fields

**Files:**
- Create: `oxeio-monitor/web/src/api/schedule.ts`
- Create: `oxeio-monitor/web/src/pages/schedule/SchedulePage.tsx`, `oxeio-monitor/web/src/pages/schedule/schedule.format.ts`
- Create: `oxeio-monitor/web/src/pages/settings/PolicyScheduleFields.tsx`
- Modify: `oxeio-monitor/web/src/components/nav.ts` (entry), `oxeio-monitor/web/src/App.tsx` (route)
- Modify: `oxeio-monitor/web/src/api/calendar.ts`, `oxeio-monitor/web/src/pages/settings/PoliciesTab.tsx`
- Modify: catalogs `web/src/i18n/locales/{pt-BR,es}/work.json`, `settings-work.json`, `shell.json` (nav label)
- Test: `oxeio-monitor/web/test/schedule-format.spec.ts`, `oxeio-monitor/web/test/nav.spec.ts` (add a case)

**Interfaces:**
- Consumes (HTTP): Task 4 endpoints; Task 3 policy fields.
- Produces: `clockOf(min: number | null): string` (`'08:20'`, `'—'` for null, `'24:00'` for 1440), `signedDuration(min: number): string` (`'+1h10'`, `'−12min'`, `'0'`), `BREACH_LABEL: Record<Breach, string>` (English keys).

- [ ] **Step 1: Write the failing tests**

```ts
// oxeio-monitor/web/test/schedule-format.spec.ts
import { describe, expect, it } from 'vitest';

import { BREACH_LABEL, clockOf, signedDuration } from '../src/pages/schedule/schedule.format';

describe('schedule formatting', () => {
  it('minutes since midnight as a clock', () => {
    expect(clockOf(500)).toBe('08:20');
    expect(clockOf(1440)).toBe('24:00');
    expect(clockOf(null)).toBe('—');
  });
  it('a signed balance', () => {
    expect(signedDuration(70)).toBe('+1h10');
    expect(signedDuration(-12)).toBe('−12min');
    expect(signedDuration(0)).toBe('0');
    expect(signedDuration(-60)).toBe('−1h00');
  });
  it('every breach has a label', () => {
    expect(Object.keys(BREACH_LABEL).sort()).toEqual(['break_missing', 'break_short', 'early_leave', 'late', 'no_show']);
  });
});
```

Append to `web/test/nav.spec.ts`:

```ts
describe('navFor — Schedule', () => {
  it('owner and manager see it; staff do not', () => {
    expect(paths(user())).toContain('/schedule');
    expect(paths(user({ role: 'manager' }))).toContain('/schedule');
    expect(paths(user({ role: 'employee' }))).not.toContain('/schedule');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run (in `oxeio-monitor/web`): `npm test -- test/schedule-format.spec.ts test/nav.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement formatting, API and nav**

```ts
// oxeio-monitor/web/src/pages/schedule/schedule.format.ts
import type { Breach } from '../../api/schedule';

export function clockOf(min: number | null): string {
  if (min === null) return '—';
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function signedDuration(min: number): string {
  if (min === 0) return '0';
  const sign = min > 0 ? '+' : '−';
  const abs = Math.abs(min);
  return abs < 60 ? `${sign}${abs}min` : `${sign}${Math.floor(abs / 60)}h${String(abs % 60).padStart(2, '0')}`;
}

/** English keys, translated where shown */
export const BREACH_LABEL: Record<Breach, string> = {
  late: 'Late',
  early_leave: 'Left early',
  break_short: 'Short break',
  break_missing: 'No break',
  no_show: 'No activity',
};
```

```ts
// oxeio-monitor/web/src/api/schedule.ts
import { api } from './client';
import { qs } from './query';

/** Schedule compliance — server `schedule/schedule.controller.ts` (owner, manager) */
export type Breach = 'late' | 'early_leave' | 'break_short' | 'break_missing' | 'no_show';

export interface ScheduleDayView {
  date: string;
  arrivedMin: number | null;
  leftMin: number | null;
  breakStartMin: number | null;
  breakMin: number;
  lateMin: number;
  earlyLeaveMin: number;
  balanceMin: number;
  breaches: Breach[];
  final: boolean;
}

export interface ScheduleMonthView {
  employee: { id: number; fullName: string };
  days: ScheduleDayView[];
  totals: { late: number; earlyLeave: number; breakShort: number; breakMissing: number; noShow: number; balanceMin: number };
  requiredBreakMin: number | null;
}

export function scheduledPeople(signal?: AbortSignal): Promise<{ id: number; fullName: string }[]> {
  return api('/schedule/people', { signal });
}

export function scheduleMonth(employeeId: number, month: string, signal?: AbortSignal): Promise<ScheduleMonthView> {
  return api<ScheduleMonthView>(`/schedule${qs({ employeeId, month })}`, { signal });
}
```

Check `qs()` in `api/query.ts` for its signature and use it the way other API files do.

In `components/nav.ts`, add after the Worklog entry:

```ts
  /** Schedule compliance: who arrived late, left early or skipped the break */
  {
    to: '/schedule',
    label: 'Schedule',
    roles: ['owner', 'manager'],
  },
```

In `App.tsx`, next to the worklog route: `{seesEveryone(user.role) && <Route path="schedule" element={<SchedulePage />} />}` (use whatever variable the file already has for "owner or manager", e.g. `mayOpenWorklog`).

- [ ] **Step 4: The page**

```tsx
// oxeio-monitor/web/src/pages/schedule/SchedulePage.tsx
import { useEffect, useState } from 'react';

import { scheduledPeople, scheduleMonth } from '../../api/schedule';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { SelectField, TextField } from '../../components/ui';
import { useT } from '../../i18n';
import { formatDateMedium, todayInWorkZone } from '../../lib/format';
import { BREACH_LABEL, clockOf, signedDuration } from './schedule.format';

/**
 * Schedule compliance for people on a policy that checks a fixed schedule:
 * arrival, leaving, the break and the day's balance. Breaches are marked;
 * the balance is information only.
 */
export function SchedulePage() {
  const t = useT();
  const people = useApi(scheduledPeople, []);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [month, setMonth] = useState(todayInWorkZone().slice(0, 7));

  useEffect(() => {
    if (employeeId === null && people.data && people.data.length > 0) setEmployeeId(people.data[0].id);
  }, [people.data, employeeId]);

  const view = useApi(
    (signal) => (employeeId === null ? Promise.resolve(null) : scheduleMonth(employeeId, month, signal)),
    [employeeId, month],
  );

  if (people.loading && !people.data) return <Loading />;
  if (people.error && !people.data) return <ErrorBox error={people.error} retry={people.reload} />;
  if (people.data?.length === 0) {
    return (
      <Page title={t('Schedule')}>
        <Empty>{t('Nobody is on a policy that checks a schedule. Switch it on in Settings → Policies.')}</Empty>
      </Page>
    );
  }

  const data = view.data;
  return (
    <Page title={t('Schedule')}>
      <div className="mb-3 flex flex-wrap gap-3">
        <SelectField
          label={t('Person')}
          value={String(employeeId ?? '')}
          onChange={(v) => setEmployeeId(Number(v))}
          options={(people.data ?? []).map((p) => ({ value: String(p.id), label: p.fullName }))}
        />
        <TextField label={t('Month')} type="month" value={month} onChange={setMonth} mono />
      </div>

      {view.error && <ErrorBox error={view.error} retry={view.reload} />}
      {data && (
        <>
          <Card title={t('This month')}>
            <div className="flex flex-wrap gap-4 p-4 text-[13px]">
              <span>{t('Late')}: <b className="num">{data.totals.late}</b></span>
              <span>{t('Left early')}: <b className="num">{data.totals.earlyLeave}</b></span>
              <span>{t('Short break')}: <b className="num">{data.totals.breakShort}</b></span>
              <span>{t('No break')}: <b className="num">{data.totals.breakMissing}</b></span>
              <span>{t('No activity')}: <b className="num">{data.totals.noShow}</b></span>
              <span>{t('Balance')}: <b className="num">{signedDuration(data.totals.balanceMin)}</b></span>
            </div>
          </Card>

          <table className="mt-3 w-full text-[13px]">
            <thead>
              <tr className="text-left text-ink-3">
                <th>{t('Day')}</th>
                <th>{t('Arrived')}</th>
                <th>{t('Break')}</th>
                <th>{t('Left')}</th>
                <th>{t('Balance')}</th>
                <th>{t('Notes')}</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.date} className={d.breaches.length > 0 ? 'text-bad' : ''}>
                  <td>{formatDateMedium(d.date)}{!d.final && ` · ${t('in progress')}`}</td>
                  <td className="num">{clockOf(d.arrivedMin)}</td>
                  <td className="num">{d.breakStartMin === null ? '—' : `${clockOf(d.breakStartMin)} · ${d.breakMin} min`}</td>
                  <td className="num">{clockOf(d.leftMin)}</td>
                  <td className="num">{signedDuration(d.balanceMin)}</td>
                  <td>{d.breaches.map((b) => t(BREACH_LABEL[b])).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Page>
  );
}
```

Before writing, check `components/Page.tsx`, `components/States.tsx` (`Empty`?), `components/Table.tsx` and `lib/format.ts` (`formatDateMedium`, `todayInWorkZone`) for the real names and props, and use the shared `Table` component instead of the raw `<table>` if the other pages do. Use the colour token the other pages use for problems (`text-bad` here is a placeholder name to replace with the real token, e.g. what `StatusDot` uses).

- [ ] **Step 5: Policy form fields**

```tsx
// oxeio-monitor/web/src/pages/settings/PolicyScheduleFields.tsx
import { CheckboxField, FullWidth, TextField } from '../../components/ui';
import { useT } from '../../i18n';

export interface ScheduleFormState {
  scheduleEnforced: boolean;
  breakWindowFrom: string;
  breakWindowTo: string;
  toleranceMarkMin: string;
  toleranceDayMin: string;
}

/**
 * "Check this schedule": the working hours above become a schedule that is
 * checked every workday (arrival, leaving, the break). The break must start
 * inside the window; tolerances are minutes ignored at each end and per day.
 */
export function PolicyScheduleFields({
  state,
  onChange,
  breakMinutes,
  onBreakMinutes,
}: {
  state: ScheduleFormState;
  onChange: (next: ScheduleFormState) => void;
  breakMinutes: string;
  onBreakMinutes: (value: string) => void;
}) {
  const t = useT();
  const set = <K extends keyof ScheduleFormState>(key: K) => (value: ScheduleFormState[K]) => onChange({ ...state, [key]: value });
  return (
    <>
      <FullWidth>
        <CheckboxField
          label={t('Check this schedule every workday (arrival, leaving, break)')}
          checked={state.scheduleEnforced}
          onChange={set('scheduleEnforced')}
        />
      </FullWidth>
      {state.scheduleEnforced && (
        <>
          <TextField label={t('Break (minutes)')} type="number" value={breakMinutes} onChange={onBreakMinutes} mono min={0} max={480} />
          <FullWidth>
            <p className="text-[11.5px] leading-relaxed text-ink-3">{t('One continuous pause of at least this long must start inside the window below.')}</p>
          </FullWidth>
          <TextField label={t('Break may start from')} type="time" value={state.breakWindowFrom} onChange={set('breakWindowFrom')} mono />
          <TextField label={t('Break may start until')} type="time" value={state.breakWindowTo} onChange={set('breakWindowTo')} mono
            hint={t('Leave both empty to allow the break anywhere in the working day.')} />
          <TextField label={t('Tolerance per clock mark (minutes)')} type="number" value={state.toleranceMarkMin} onChange={set('toleranceMarkMin')} mono min={0} max={60} />
          <TextField label={t('Tolerance per day (minutes)')} type="number" value={state.toleranceDayMin} onChange={set('toleranceDayMin')} mono min={0} max={60}
            hint={t('Minutes off at arrival and at leaving are ignored up to the first number each, and up to the second number together.')} />
        </>
      )}
    </>
  );
}
```

In `api/calendar.ts` add the five fields to `WorkPolicyView` (`scheduleEnforced: boolean; breakWindowFrom: string | null; breakWindowTo: string | null; toleranceMarkMin: number; toleranceDayMin: number;`) and as optionals to `WorkPolicyBody`.

In `PoliciesTab.tsx` `PolicyForm`: a `useState<ScheduleFormState>` initialised from the policy (`breakWindowFrom ?? ''`, tolerances `String(... ?? 0)`); render `<PolicyScheduleFields … breakMinutes={form.breakMinutes} onBreakMinutes={set('breakMinutes')} />` right after the "Working hours until" field; in `submit` send
`scheduleEnforced, breakWindowFrom: s.breakWindowFrom || null, breakWindowTo: s.breakWindowTo || null, toleranceMarkMin: Number(s.toleranceMarkMin), toleranceDayMin: Number(s.toleranceDayMin)`
and change the `breakMinutes` line to send it when `basis === 'day' || s.scheduleEnforced`. When the schedule is on and the basis is `day`, the "Break (minutes)" field already shown under the basis must not appear twice: render it only in `PolicyScheduleFields` when the schedule is on.

- [ ] **Step 6: Translations, suites, browser**

Add every new English key to `pt-BR` and `es` (nav "Schedule" → "Jornada" / "Jornada"; "Late" → "Atraso" / "Retraso"; "Left early" → "Saída antecipada" / "Salida anticipada"; "Short break" → "Intervalo curto" / "Descanso corto"; "No break" → "Sem intervalo" / "Sin descanso"; "No activity" → "Sem atividade" / "Sin actividad"; "Balance" → "Saldo" / "Saldo"; and the form strings). Add the new server messages from `scheduleProblem` to both `server.json`.

Run: `npm test && npm run typecheck && npm run lint` (web). Expected: PASS.
In the browser: enable the schedule on a policy, open Schedule, pick the person and month; a policy without the schedule shows the empty state.

- [ ] **Step 7: Commit**

```bash
git add -A oxeio-monitor/web
git commit -m "feat(web): Schedule screen and schedule fields on work policies"
```

---

### Task 6: Docs and full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Document**

- API table: `| `schedule/` | schedule compliance: the day check written by the roll-up (`schedule.rules.ts` is the rule), the Schedule screen, the "Schedule today" digest block |`
- Dashboard table: add `schedule` to the `pages/<module>/` list and `schedule` to the `api/` list.
- "Work regimes" section, after the measure paragraph: "**A fixed schedule can be checked**: with `scheduleEnforced`, the office hours, `breakMinutes`, the break window and two tolerances (per clock mark, per day) are checked every workday against the day's presence blocks. Results (`schedule_days`, minutes since local midnight) show on the Schedule screen and in the daily summary; days off, holidays and leave are not checked; the balance is information, never pay."
- Remove the schema comments that say there is no shift/lunch window: in `schema.prisma`, the `enum TargetBasis` comment "Careful: this replaces a shifts table. There is no shift window, lunch window or fixed arrival time." becomes "Hours targets. A fixed schedule, when a policy wants one checked, is `schedule_enforced` + office hours + break (src/schedule/)." (a comment-only change; no migration).

- [ ] **Step 2: Run every suite**

Run (server): `npm test && npm run typecheck && npm run lint`
Run (web): `npm test && npm run typecheck && npm run lint`
Run (in `oxeio-monitor`): `docker compose build api web`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md oxeio-monitor/server/prisma/schema.prisma
git commit -m "docs: schedule compliance"
```
