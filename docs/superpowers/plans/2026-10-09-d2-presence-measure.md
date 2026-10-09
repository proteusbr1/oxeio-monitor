# Delivery 2 — Presence measure: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A work policy can count hours as "presence" (first to last use of the computer, minus pauses longer than N minutes) instead of active keyboard/mouse time.

**Architecture:** Presence is computed in the existing pure day summary (`summarizeDay`) and stored as `daily_summary.presence_sec`; `credited_sec` becomes "the policy's measure + adjustments", so targets, pace, payroll, reports and the tray follow without changes. Changing a policy's measure marks the open months for recount through the existing `summary_dirty` queue.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), vitest; React 19, i18next.

**Spec:** `docs/superpowers/specs/2026-10-09-work-hours-and-pay-period-design.md` § 5 (and § 1a). Index and working rules: `docs/superpowers/plans/2026-10-09-work-hours-index.md`.

## Global Constraints

- Default `hoursMeasure = 'active'` and `presenceGapMin = 15`: an install that does nothing behaves exactly as before.
- `presenceGapMin` range 1–120 minutes.
- Two devices used at once never count twice: active stretches are unioned before gaps are joined.
- Closed months never change (the dirty drain already skips them).
- Generic text; screen text in `en`/`pt-BR`/`es`.
- Branch `feat/presence-measure` off `pericialmed`.

## Review Focus

1. A gap exactly equal to the threshold is joined (≤, not <) — test in Task 1.
2. Two devices active over the same minutes count once, and a gap on one device covered by the other is not a gap — test in Task 1.
3. A day with a single active stretch or none: presence equals that stretch / 0, never negative — test in Task 1.
4. Switching a policy back from presence to active restores the old credited numbers on open months — test in Task 3.
5. A policy saved without touching the measure must not queue a recount (it would churn every save) — test in Task 3.

---

### Task 1: Presence in the day summary (pure)

**Files:**
- Modify: `oxeio-monitor/server/src/summary/summary.math.ts` (`presenceSpans`, `summarizeDay` input/output)
- Test: `oxeio-monitor/server/test/presence.spec.ts`

**Interfaces:**
- Consumes: existing `Span { startedAt: Date; endedAt: Date }`, `mergeSpans`, `unionSec`, `DaySegment`, `DayInput`, `DayNumbers`.
- Produces:
  - `type HoursMeasure = 'active' | 'presence'`
  - `presenceSpans(active: readonly Span[], gapSec: number): Span[]` — merged blocks, ordered
  - `DayInput` gains optional `measure?: HoursMeasure` (default `'active'`) and `presenceGapSec?: number` (default `900`)
  - `DayNumbers` gains `presenceSec: number`; `creditedSec = (measure === 'presence' ? presenceSec : workedSec) + adjustmentSec`
  - `DEFAULT_PRESENCE_GAP_SEC = 900`

- [ ] **Step 1: Write the failing test**

```ts
// oxeio-monitor/server/test/presence.spec.ts
import { describe, expect, it } from 'vitest';

import { presenceSpans, summarizeDay, type DaySegment } from '../src/summary/summary.math';

const at = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00.000Z`);
const span = (from: string, to: string) => ({ startedAt: at(from), endedAt: at(to) });
const active = (from: string, to: string): DaySegment => ({
  ...span(from, to),
  state: 'active',
  durationSec: (at(to).getTime() - at(from).getTime()) / 1000,
});
const idle = (from: string, to: string): DaySegment => ({ ...active(from, to), state: 'idle' });

const MIN = 60;

describe('presenceSpans — active stretches joined across short pauses', () => {
  it('joins pauses up to the threshold, splits at longer ones', () => {
    const blocks = presenceSpans(
      [span('08:00', '09:00'), span('09:05', '12:00'), span('13:10', '17:00')],
      15 * MIN,
    );
    expect(blocks).toEqual([span('08:00', '12:00'), span('13:10', '17:00')]);
  });

  it('a pause exactly as long as the threshold is joined', () => {
    expect(presenceSpans([span('08:00', '09:00'), span('09:15', '10:00')], 15 * MIN)).toEqual([span('08:00', '10:00')]);
  });

  it('one minute longer is not', () => {
    expect(presenceSpans([span('08:00', '09:00'), span('09:16', '10:00')], 15 * MIN)).toHaveLength(2);
  });

  it('two devices: overlapping time counts once; one covers the other’s pause', () => {
    const blocks = presenceSpans(
      [span('08:00', '10:00'), span('09:30', '11:00'), span('10:00', '12:00')],
      0,
    );
    expect(blocks).toEqual([span('08:00', '12:00')]);
  });

  it('unordered input, no input', () => {
    expect(presenceSpans([span('13:00', '14:00'), span('08:00', '09:00')], 15 * MIN)).toEqual([span('08:00', '09:00'), span('13:00', '14:00')]);
    expect(presenceSpans([], 15 * MIN)).toEqual([]);
  });
});

describe('summarizeDay — the policy chooses the measure', () => {
  const segments = [
    active('08:00', '09:00'),
    idle('09:00', '09:10'),
    active('09:10', '12:00'),
    idle('12:00', '13:00'),
    active('13:00', '17:00'),
  ];
  const base = {
    segments,
    screenshotCount: 0,
    adjustmentSec: 600,
    productiveSpans: [],
    unproductiveSpans: [],
    isOffDay: false,
  };

  it('active (the default): credited = worked + adjustment, presence still stored', () => {
    const day = summarizeDay(base);
    expect(day.workedSec).toBe((60 + 170 + 240) * MIN);
    expect(day.presenceSec).toBe((240 + 240) * MIN); // 08:00–12:00 joined, 13:00–17:00
    expect(day.creditedSec).toBe(day.workedSec + 600);
  });

  it('presence: credited = presence + adjustment', () => {
    const day = summarizeDay({ ...base, measure: 'presence', presenceGapSec: 15 * MIN });
    expect(day.creditedSec).toBe((240 + 240) * MIN + 600);
  });

  it('presence with a threshold that bridges lunch', () => {
    const day = summarizeDay({ ...base, measure: 'presence', presenceGapSec: 60 * MIN });
    expect(day.presenceSec).toBe(9 * 60 * MIN);
  });

  it('no activity: presence 0', () => {
    expect(summarizeDay({ ...base, segments: [], measure: 'presence' }).presenceSec).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `oxeio-monitor/server`): `npm test -- test/presence.spec.ts`
Expected: FAIL — `presenceSpans` is not exported.

- [ ] **Step 3: Implement**

In `oxeio-monitor/server/src/summary/summary.math.ts`, after `unionSec()`:

```ts
/** How a policy counts hours: keyboard/mouse time, or presence (see presenceSpans) */
export type HoursMeasure = 'active' | 'presence';

/** The policy default for the longest pause that still counts as work */
export const DEFAULT_PRESENCE_GAP_SEC = 15 * 60;

/**
 * **Presence**: the day's active stretches, unioned (two devices count once),
 * then joined wherever the pause between two of them is at most `gapSec`.
 *
 * A short read, a call or a coffee keeps the block going; a longer pause
 * (lunch, a meeting away from the desk) ends it. The blocks are what a
 * schedule check reads as arrival, breaks and leaving.
 */
export function presenceSpans(active: readonly Span[], gapSec: number): Span[] {
  const merged = mergeSpans(active);
  const out: Span[] = [];
  for (const s of merged) {
    const last = out[out.length - 1];
    if (last && s.startedAt.getTime() - last.endedAt.getTime() <= gapSec * 1000) {
      if (s.endedAt > last.endedAt) out[out.length - 1] = { startedAt: last.startedAt, endedAt: s.endedAt };
    } else {
      out.push({ startedAt: s.startedAt, endedAt: s.endedAt });
    }
  }
  return out;
}
```

`mergeSpans` already drops empty spans, sorts by start and merges overlapping or touching spans into fresh `{ startedAt, endedAt }` objects, so the loop above only has to bridge the gaps.

Extend `DayInput`:

```ts
  /** The policy's measure; absent = 'active' (the original behaviour) */
  measure?: HoursMeasure;
  /** The longest pause that still counts as presence, in seconds */
  presenceGapSec?: number;
```

Extend `DayNumbers` with `presenceSec: number;` (after `workedSec`).

In `summarizeDay`, after `const workedSec = unionSec(active);`:

```ts
  const presenceSec = unionSec(presenceSpans(active, input.presenceGapSec ?? DEFAULT_PRESENCE_GAP_SEC));
  const measuredSec = (input.measure ?? 'active') === 'presence' ? presenceSec : workedSec;
```

and in the returned object add `presenceSec,` and change `creditedSec: workedSec + input.adjustmentSec,` to `creditedSec: measuredSec + input.adjustmentSec,` (keep the comment about not clamping).

- [ ] **Step 4: Run tests**

Run: `npm test -- test/presence.spec.ts test/summary.math.spec.ts`
Expected: PASS (existing summary tests unchanged: they use the default measure).

- [ ] **Step 5: Commit**

```bash
git add oxeio-monitor/server/src/summary/summary.math.ts oxeio-monitor/server/test/presence.spec.ts
git commit -m "feat(server): presence — active stretches joined across short pauses"
```

---

### Task 2: Store it — policy fields, migration, roll-up

**Files:**
- Create: `oxeio-monitor/server/prisma/migrations/20261012120000_presence_measure/migration.sql`
- Modify: `oxeio-monitor/server/prisma/schema.prisma` (`enum HoursMeasure`, `WorkPolicy.hoursMeasure`, `WorkPolicy.presenceGapMin`, `DailySummary.presenceSec`)
- Modify: `oxeio-monitor/server/src/calendar/work-regime.ts` (`MEASURE_SELECT`, `measureOf`)
- Modify: `oxeio-monitor/server/src/summary/summary.service.ts` (`EmployeePolicy`, `activeEmployees`, `summarizeDay` call)
- Test: `oxeio-monitor/server/test/presence.e2e.spec.ts`

**Interfaces:**
- Consumes: `HoursMeasure`, `DEFAULT_PRESENCE_GAP_SEC` (Task 1).
- Produces:
  - Prisma: `WorkPolicy.hoursMeasure: HoursMeasure` (default `active`), `WorkPolicy.presenceGapMin: Int` (default 15), `DailySummary.presenceSec: Int` (default 0)
  - `MEASURE_SELECT = { hoursMeasure: true, presenceGapMin: true } as const`
  - `measureOf(policy: { hoursMeasure?: HoursMeasure | null; presenceGapMin?: number | null } | null | undefined): { measure: HoursMeasure; presenceGapSec: number }`

- [ ] **Step 1: Schema and migration**

In `schema.prisma`, after `enum PayBasis`:

```prisma
/// How a work policy counts hours (src/summary/summary.math.ts)
enum HoursMeasure {
  /// keyboard/mouse time only (the original measure)
  active
  /// first to last use of the computer, minus pauses longer than presence_gap_min
  presence
}
```

In `model WorkPolicy`, after `deductShortfall`:

```prisma
  /// what counts as worked time: active input, or presence (see HoursMeasure)
  hoursMeasure       HoursMeasure @default(active) @map("hours_measure")
  /// presence: the longest pause, in minutes, that still counts as work
  presenceGapMin     Int      @default(15) @map("presence_gap_min")
```

In `model DailySummary`, after `workedSec`:

```prisma
  /// Presence: active stretches joined across pauses up to the policy's gap. Stored for every
  /// policy; it is what `credited_sec` counts only when the policy's measure is `presence`
  presenceSec     Int       @default(0) @map("presence_sec")
```

```sql
-- oxeio-monitor/server/prisma/migrations/20261012120000_presence_measure/migration.sql
-- CreateEnum
CREATE TYPE "HoursMeasure" AS ENUM ('active', 'presence');

-- AlterTable
ALTER TABLE "work_policies" ADD COLUMN     "hours_measure" "HoursMeasure" NOT NULL DEFAULT 'active',
ADD COLUMN     "presence_gap_min" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "daily_summary" ADD COLUMN     "presence_sec" INTEGER NOT NULL DEFAULT 0;
```

Run: `npx prisma generate` (in `oxeio-monitor/server`). Expected: "Generated Prisma Client".

- [ ] **Step 2: Write the failing e2e test**

```ts
// oxeio-monitor/server/test/presence.e2e.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SummaryService } from '../src/summary/summary.service';
import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  resetDatabase,
  type Harness,
} from './setup/harness';

/** The roll-up credits presence when the person's policy says so */
let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

async function personWithDay(measure: 'active' | 'presence') {
  const policy = await h.prisma.workPolicy.findFirstOrThrow();
  await h.prisma.workPolicy.update({ where: { id: policy.id }, data: { hoursMeasure: measure, presenceGapMin: 15 } });
  const { employeeId, code } = await createEmployeeWithCode(h.prisma);
  const { deviceId } = await enrollDevice(h, code);
  const workDate = new Date('2026-10-05T00:00:00.000Z');
  const session = await h.prisma.workSession.create({
    data: { employeeId, deviceId, workDate, startedAt: new Date('2026-10-05T02:00:00Z') },
  });
  // two active hours with a 10-minute pause, then a 50-minute pause, then one hour
  const stretches: [string, string][] = [
    ['2026-10-05T02:00:00Z', '2026-10-05T03:00:00Z'],
    ['2026-10-05T03:10:00Z', '2026-10-05T04:10:00Z'],
    ['2026-10-05T05:00:00Z', '2026-10-05T06:00:00Z'],
  ];
  for (const [from, to] of stretches) {
    const startedAt = new Date(from);
    const endedAt = new Date(to);
    await h.prisma.activitySegment.create({
      data: {
        sessionId: session.id,
        employeeId,
        deviceId,
        clientUuid: crypto.randomUUID(),
        workDate,
        state: 'active',
        startedAt,
        endedAt,
        durationSec: (endedAt.getTime() - startedAt.getTime()) / 1000,
        countsAsWork: true,
      },
    });
  }
  await h.app.get(SummaryService).refreshDate(workDate, new Date('2026-10-05T12:00:00Z'));
  return h.prisma.dailySummary.findUniqueOrThrow({ where: { employeeId_workDate: { employeeId, workDate } } });
}

describe('presence in the roll-up', () => {
  it('active policy: credited = active time; presence stored beside it', async () => {
    const day = await personWithDay('active');
    expect(day.workedSec).toBe(3 * 3600);
    expect(day.presenceSec).toBe(2 * 3600 + 10 * 60 + 3600);
    expect(day.creditedSec).toBe(3 * 3600);
  });

  it('presence policy: credited = presence', async () => {
    const day = await personWithDay('presence');
    expect(day.creditedSec).toBe(2 * 3600 + 10 * 60 + 3600);
  });
});
```

The instants above are in UTC; under the tests' pinned zone (`Etc/GMT-6`) they fall on work date 2026-10-05 (a Monday; the test policy's day off is Friday) between 08:00 and 12:00. `createEmployeeWithCode` puts the person on the first policy, the one updated above.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- test/presence.e2e.spec.ts`
Expected: FAIL — `presenceSec` is 0 and credited ignores the measure.

- [ ] **Step 4: Implement**

In `src/calendar/work-regime.ts` append:

```ts
import type { HoursMeasure } from '@prisma/client';
import { DEFAULT_PRESENCE_GAP_SEC } from '../summary/summary.math';

/** The fields a query must select for measureOf() */
export const MEASURE_SELECT = { hoursMeasure: true, presenceGapMin: true } as const;

/** How a policy counts hours; no policy = active time, the original measure */
export function measureOf(
  policy: { hoursMeasure?: HoursMeasure | null; presenceGapMin?: number | null } | null | undefined,
): { measure: HoursMeasure; presenceGapSec: number } {
  return {
    measure: policy?.hoursMeasure ?? 'active',
    presenceGapSec: policy?.presenceGapMin ? policy.presenceGapMin * 60 : DEFAULT_PRESENCE_GAP_SEC,
  };
}
```

(Move the `import type` line to the top of the file with the existing `TargetBasis` import. If importing `summary.math` from `calendar/` creates a cycle the linter flags, move `DEFAULT_PRESENCE_GAP_SEC` into `work-regime.ts` and import it from there in `summary.math.ts` instead.)

In `src/summary/summary.service.ts`:

1. Add to `interface EmployeePolicy`:

```ts
  /** what this person's policy credits: active time or presence */
  measure: HoursMeasure;
  presenceGapSec: number;
```

2. In `activeEmployees()`, select `policy: { select: { ...REGIME_SELECT, ...MEASURE_SELECT } }` and add `...measureOf(r.policy),` to the returned object.
3. In `refreshDate()`, pass `measure: e.measure, presenceGapSec: e.presenceGapSec,` into `summarizeDay({...})`.
4. Import `MEASURE_SELECT, measureOf` from `'../calendar/work-regime'` and `type HoursMeasure` from `'@prisma/client'`.

- [ ] **Step 5: Run tests**

Run: `npm test -- test/presence.e2e.spec.ts test/work-regime.e2e.spec.ts test/proration.e2e.spec.ts test/tray-credited.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A oxeio-monitor/server/prisma oxeio-monitor/server/src oxeio-monitor/server/test/presence.e2e.spec.ts
git commit -m "feat(server): policies can credit presence instead of active time"
```

---

### Task 3: Policy endpoints — save the measure, recount open months

**Files:**
- Create: `oxeio-monitor/server/src/summary/recount.ts`
- Modify: `oxeio-monitor/server/src/calendar/calendar.dto.ts` (create + update DTOs), `calendar/work-policies.service.ts` (create, update, `WorkPolicyView`, `toView`)
- Test: `oxeio-monitor/server/test/recount.spec.ts`, `oxeio-monitor/server/test/presence-policy.e2e.spec.ts`

**Interfaces:**
- Produces:
  - `datesToRecount(today: Date): Date[]` — every work date from the first day of the previous month through `today` (UTC-midnight `Date`s, as `summary_dirty.work_date` stores them)
  - `WorkPolicyView` gains `hoursMeasure: 'active' | 'presence'`, `presenceGapMin: number`
  - DTO fields: `hoursMeasure?: 'active' | 'presence'` (`@IsIn`), `presenceGapMin?: number` (`@IsInt @Min(1) @Max(120)`)

- [ ] **Step 1: Write the failing tests**

```ts
// oxeio-monitor/server/test/recount.spec.ts
import { describe, expect, it } from 'vitest';

import { datesToRecount } from '../src/summary/recount';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('datesToRecount — the open months after a measure change', () => {
  it('from the first of last month through today', () => {
    const dates = datesToRecount(d('2026-10-09'));
    expect(dates[0]).toEqual(d('2026-09-01'));
    expect(dates[dates.length - 1]).toEqual(d('2026-10-09'));
    expect(dates).toHaveLength(30 + 9);
  });

  it('crosses the year', () => {
    expect(datesToRecount(d('2027-01-02'))[0]).toEqual(d('2026-12-01'));
  });
});
```

```ts
// oxeio-monitor/server/test/presence-policy.e2e.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

let h: Harness;
let owner: Session;

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

const patch = (path: string, body: object) =>
  owner.http.patch(`/api/v1${path}`).set('X-CSRF-Token', owner.csrf).send(body);

describe('the measure on the policy', () => {
  it('defaults to active, 15 minutes', async () => {
    const res = await owner.http.get('/api/v1/work-policies').expect(200);
    expect(res.body.rows[0]).toMatchObject({ hoursMeasure: 'active', presenceGapMin: 15 });
  });

  it('switching to presence queues the open months for recount', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await patch(`/work-policies/${policy.id}`, { hoursMeasure: 'presence', presenceGapMin: 20 }).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });

  it('a save that does not touch the measure queues nothing', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await patch(`/work-policies/${policy.id}`, { name: 'Renamed' }).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBe(0);
  });

  it('the gap must be 1–120 minutes', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await patch(`/work-policies/${policy.id}`, { presenceGapMin: 0 }).expect(400);
    await patch(`/work-policies/${policy.id}`, { presenceGapMin: 121 }).expect(400);
  });
});
```

Check the actual list route and response shape in `calendar/work-policies.controller.ts` (`list()` returns `{ rows }`); adjust the path if the controller is mounted elsewhere.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- test/recount.spec.ts test/presence-policy.e2e.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// oxeio-monitor/server/src/summary/recount.ts
/**
 * Which days to count again after a rule that changes credited time (a
 * policy's measure): the months that may still be open — last month and this
 * one. Closed months are skipped by the dirty drain itself, so asking for
 * them is harmless; older months are closed or paid, and stay as they are.
 */
export function datesToRecount(today: Date): Date[] {
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1);
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const out: Date[] = [];
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t));
  return out;
}
```

In `calendar/calendar.dto.ts`, add to both `CreateWorkPolicyDto` and `UpdateWorkPolicyDto` (with the imports `IsIn`, `IsInt`, `Min`, `Max` if missing):

```ts
  /** what counts as worked time: 'active' input or 'presence' */
  @IsOptional() @IsIn(['active', 'presence'])
  hoursMeasure?: 'active' | 'presence';

  /** presence: the longest pause, in minutes, still counted as work */
  @IsOptional() @IsInt() @Min(1) @Max(120)
  presenceGapMin?: number;
```

In `calendar/work-policies.service.ts`:

1. `WorkPolicyView`: add `hoursMeasure: 'active' | 'presence';` and `presenceGapMin: number;`; `toView()` copies both from the row.
2. `create()`: add `...(dto.hoursMeasure === undefined ? {} : { hoursMeasure: dto.hoursMeasure }), ...(dto.presenceGapMin === undefined ? {} : { presenceGapMin: dto.presenceGapMin }),` to `data`.
3. `update()`: the same two spreads in `data`; after the update and before the audit:

```ts
    const measureChanged =
      (dto.hoursMeasure !== undefined && dto.hoursMeasure !== before.hoursMeasure) ||
      (dto.presenceGapMin !== undefined && dto.presenceGapMin !== before.presenceGapMin);
    if (measureChanged) {
      // credited time changes for everyone on this policy: count the open months again
      await this.prisma.summaryDirty.createMany({
        data: datesToRecount(workDateOf(new Date())).map((workDate) => ({ workDate })),
        skipDuplicates: true,
      });
    }
```

Imports: `datesToRecount` from `'../summary/recount'`, `workDateOf` from `'../agent/util/work-time'`. The drain (`summary-refresh.job.ts`) then recounts a batch every 15 minutes.

- [ ] **Step 4: Run tests**

Run: `npm test -- test/recount.spec.ts test/presence-policy.e2e.spec.ts test/admin-work-policy.spec.ts test/work-policy-reactivate.spec.ts test/endpoints.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A oxeio-monitor/server/src oxeio-monitor/server/test
git commit -m "feat(server): set the hours measure on a policy; open months are recounted"
```

---

### Task 4: Show it — attendance report column

**Files:**
- Modify: `oxeio-monitor/server/src/reports/reports.types.ts` (`AttendanceRow.presenceHours`), `reports/reports.attendance.service.ts` (select + row), `reports/reports.sheets.ts` (column)
- Modify: `oxeio-monitor/web/src/api/reports.ts` (row type), `oxeio-monitor/web/src/pages/reports/AttendanceTab.tsx` (column)
- Test: `oxeio-monitor/server/test/presence.e2e.spec.ts` (add a case)

**Interfaces:**
- Produces: `AttendanceRow.presenceHours: number` (hours, two decimals, like `workedHours`).

- [ ] **Step 1: Add the failing case** to `test/presence.e2e.spec.ts`:

```ts
import { ReportsService } from '../src/reports/reports.service';

describe('attendance shows presence beside active time', () => {
  it('both columns are filled', async () => {
    await personWithDay('presence');
    const report = await h.app.get(ReportsService).attendance({ from: '2026-10-05', to: '2026-10-05' });
    const row = report.rows.find((r) => r.status === 'worked');
    expect(row?.workedHours).toBe(3);
    expect(row?.presenceHours).toBeCloseTo(3.17, 2);
  });
});
```

Check `ReportsService.attendance`'s real query parameter type in `reports/dto.ts` (`ReportRangeQuery`) and pass the fields it requires.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- test/presence.e2e.spec.ts`
Expected: FAIL — `presenceHours` undefined.

- [ ] **Step 3: Implement**

- `reports.types.ts`, `AttendanceRow`: after `workedHours` add
  `/** Presence (first to last use, minus long pauses): what a presence policy credits */ presenceHours: number;`
- `reports.attendance.service.ts`: add `presenceSec: true` to the `dailySummary.findMany` select and `presenceHours: secondsToHours(summary?.presenceSec ?? 0),` after `workedHours` in the row.
- `reports.sheets.ts`, `attendanceWorkbook`: after the `Worked (hours)` column add `hours('Presence (hours)', (r: AttendanceRow) => r.presenceHours),`.
- `web/src/api/reports.ts`: add `presenceHours: number;` to the attendance row type.
- `web/src/pages/reports/AttendanceTab.tsx`: add a "Presence" column right after the worked/active column, formatted the same way as worked hours. Add `"Presence": "Presença"` (pt-BR) and `"Presence": "Presencia"` (es) to the catalog file that holds the report column names (`locales/<lang>/insight.json` — check where "Worked" is translated and use the same file).

- [ ] **Step 4: Run tests**

Run (server): `npm test -- test/presence.e2e.spec.ts test/reports.pdf.spec.ts test/reports.range.spec.ts`
Run (web): `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A oxeio-monitor/server oxeio-monitor/web
git commit -m "feat: attendance report shows presence beside active time"
```

---

### Task 5: Dashboard — the measure on the policy form

**Files:**
- Create: `oxeio-monitor/web/src/pages/settings/PolicyMeasureFields.tsx`
- Modify: `oxeio-monitor/web/src/api/calendar.ts` (`WorkPolicyView`, `WorkPolicyBody`)
- Modify: `oxeio-monitor/web/src/pages/settings/PoliciesTab.tsx` (state, submit body, render the new fields, a chip on the policy card)
- Modify: `oxeio-monitor/web/src/i18n/locales/pt-BR/settings-work.json`, `.../es/settings-work.json`
- Test: `oxeio-monitor/web/test/policy-math.spec.ts` (add cases)

**Interfaces:**
- Produces: `measureSummary(measure: 'active' | 'presence', gapMin: number): string` in `web/src/pages/settings/policy.math.ts` (English key; translated where shown); `PolicyMeasureFields` component with props `{ measure, gapMin, onMeasure, onGapMin }`.

- [ ] **Step 1: Write the failing test** (append to `web/test/policy-math.spec.ts`):

```ts
import { measureSummary } from '../src/pages/settings/policy.math';

describe('measureSummary', () => {
  it('names the measure the way the card shows it', () => {
    expect(measureSummary('active', 15)).toBe('Active time');
    expect(measureSummary('presence', 15)).toBe('Presence (pauses up to 15 min count)');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (in `oxeio-monitor/web`): `npm test -- test/policy-math.spec.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Append to `web/src/pages/settings/policy.math.ts`:

```ts
/** The policy card's one-line answer to "what counts as worked time" (an English key) */
export function measureSummary(measure: 'active' | 'presence', gapMin: number): string {
  return measure === 'presence' ? `Presence (pauses up to ${gapMin} min count)` : 'Active time';
}
```

Because the result is a translation key with a number inside, translate it with an interpolated key instead where it is displayed: show `t('Presence (pauses up to {{n}} min count)', { n: gapMin })` or `t('Active time')`; keep `measureSummary` for tests and the export.

```tsx
// oxeio-monitor/web/src/pages/settings/PolicyMeasureFields.tsx
import { FullWidth, SelectField, TextField } from '../../components/ui';
import { useT } from '../../i18n';

/**
 * What counts as worked time on this policy. "Presence" suits people paid by
 * the hour or held to a schedule: reading, a call or a short pause still
 * counts; a pause longer than the limit does not.
 */
export function PolicyMeasureFields({
  measure,
  gapMin,
  onMeasure,
  onGapMin,
}: {
  measure: 'active' | 'presence';
  gapMin: string;
  onMeasure: (value: 'active' | 'presence') => void;
  onGapMin: (value: string) => void;
}) {
  const t = useT();
  return (
    <>
      <SelectField
        label={t('What counts as worked time')}
        value={measure}
        onChange={(v) => onMeasure(v === 'presence' ? 'presence' : 'active')}
        options={[
          { value: 'active', label: t('Active time — keyboard and mouse in use') },
          { value: 'presence', label: t('Presence — first to last use, minus long pauses') },
        ]}
      />
      {measure === 'presence' ? (
        <TextField
          label={t('Longest pause that still counts (minutes)')}
          type="number"
          value={gapMin}
          onChange={onGapMin}
          mono
          min={1}
          max={120}
          hint={t('A pause up to this long (reading, a call, a coffee) counts as work; a longer one does not.')}
        />
      ) : (
        <FullWidth>
          <p className="text-[11.5px] leading-relaxed text-ink-3">
            {t('Only time with the keyboard or mouse in use counts; it stops after the idle threshold below.')}
          </p>
        </FullWidth>
      )}
    </>
  );
}
```

Match `SelectField`'s `options` type (`Option` in `components/ui.tsx`) if its fields differ from `{ value, label }`.

In `web/src/api/calendar.ts`: add `hoursMeasure: 'active' | 'presence'; presenceGapMin: number;` to `WorkPolicyView` and `hoursMeasure?: 'active' | 'presence'; presenceGapMin?: number;` to `WorkPolicyBody`.

In `PoliciesTab.tsx` `PolicyForm`:

```tsx
  const [measure, setMeasure] = useState<'active' | 'presence'>(policy?.hoursMeasure ?? 'active');
  const [gapMin, setGapMin] = useState(String(policy?.presenceGapMin ?? 15));
```

add `hoursMeasure: measure, presenceGapMin: Number(gapMin),` to `body` in `submit`, and render `<PolicyMeasureFields measure={measure} gapMin={gapMin} onMeasure={setMeasure} onGapMin={setGapMin} />` right after the target-basis fields (before "Working hours from"). On the policy card (where `officeFrom–officeTo` is shown, around line 124) add one line with the translated measure summary.

Translations (pt-BR / es) for every new key, e.g. `"What counts as worked time": "O que conta como hora trabalhada"` / `"Qué cuenta como tiempo trabajado"`, `"Active time": "Tempo ativo"` / `"Tiempo activo"`, `"Presence (pauses up to {{n}} min count)": "Presença (pausas de até {{n}} min contam)"` / `"Presencia (cuentan pausas de hasta {{n}} min)"`.

- [ ] **Step 4: Run the web suites and check in the browser**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS. In the browser: Settings → Policies → edit a policy, switch to Presence, set 20, save, reopen (values kept), the card shows the measure.

- [ ] **Step 5: Commit**

```bash
git add -A oxeio-monitor/web
git commit -m "feat(web): choose active time or presence on a work policy"
```

---

### Task 6: Docs and full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md` (section "Work regimes")

- [ ] **Step 1: Document**

Add to "Work regimes", after the paragraph about `targetSpreadOf`:

"**What counts as worked time** is also the policy's: `hoursMeasure` is `active` (keyboard/mouse time, the original measure) or `presence` (the day's active stretches joined across pauses up to `presenceGapMin`, default 15). The day roll-up stores both (`worked_sec`, `presence_sec`); `credited_sec` is the policy's measure plus adjustments, so everything that reads credited time follows. Changing the measure queues last month and this month for recount (`summary/recount.ts`); closed months stay."

- [ ] **Step 2: Run every suite**

Run (server): `npm test && npm run typecheck && npm run lint`
Run (web): `npm test && npm run typecheck && npm run lint`
Run (in `oxeio-monitor`): `docker compose build api web`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: the hours measure on work policies"
```
