import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ReportsService } from '../src/reports/reports.service';
import { SummaryService } from '../src/summary/summary.service';
import {
  createHarness,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/**
 * G37, ADR-025: the target and salary of an employee who joined mid-month, along the whole path.
 *
 * Why unit tests are not enough: `proration.spec.ts` shows that `prorate()`
 * itself is right. But G37's real risk is not there; it is at the joints:
 * does the rollup write the number to the database, does payroll read it, and
 * since the meaning of the `expected_workdays` column changed, is anyone else
 * reading a wrong number. This project has had six bugs of exactly this shape
 * ("the contract is written, the caller was not").
 */
let h: Harness;
let owner: Session;
let summary: SummaryService;
let reports: ReportsService;

/** The test month, August 2026: Fridays 7, 14, 21, 28 -> 27 workdays */
const YEAR_MONTH = '2026-08';
const utc = (day: number) => new Date(Date.UTC(2026, 7, day));
const MONTH_WORKDAYS = 27;

const HOUR = 3600;

beforeAll(async () => {
  h = await createHarness();
  summary = h.app.get(SummaryService);
  reports = h.app.get(ReportsService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  owner = await loginReady(h, OWNER_EMAIL, OWNER_PASSWORD);
});

/** Friday off, 208h / 26 days = 8 hours: the spec's default policy */
async function makeEmployee(opts: {
  empCode: string;
  joinedOn?: Date | null;
  leftOn?: Date | null;
  monthlySalary?: number;
}): Promise<number> {
  const policy = await h.prisma.workPolicy.findFirst();

  const e = await h.prisma.employee.create({
    data: {
      empCode: opts.empCode,
      fullName: `Test ${opts.empCode}`,
      designation: 'Developer',
      status: 'active',
      joinedOn: opts.joinedOn ?? null,
      leftOn: opts.leftOn ?? null,
      monthlySalary: opts.monthlySalary ?? 20000,
      policyId: policy?.id ?? null,
    },
  });
  return e.id;
}

/**
 * Runs the rollup with a day in August, "now" at the end of the month.
 *
 * `now` = noon UTC on 31 August, which is that same day's evening in the work zone (UTC+6),
 * so `today` = 31 August. The expectation window therefore stops on 30 August
 * (today is not counted, `elapsedWindow()` in `summary.math.ts`).
 */
async function rollup(now = new Date(Date.UTC(2026, 7, 31, 12))): Promise<void> {
  await summary.refreshDate(utc(31), now);
}

/**
 * Inserts a `daily_summary` row for some day for that employee.
 *
 * Why this is needed: the expectation window starts at that employee's oldest
 * `daily_summary` row, i.e. "since when we have been watching them". If no
 * row is inserted, the rollup itself writes today's (31 August) row, and then
 * tracking start = today, so not even a finished day has been observed.
 */
function seeDays(employeeId: number, days: number[]): Promise<unknown> {
  return h.prisma.dailySummary.createMany({
    data: days.map((d) => ({ employeeId, workDate: utc(d) })),
  });
}

/**
 * The agent really sent something: a `work_sessions` row is now the only proof of
 * "since when we have been watching them" (G120).
 *
 * Before, `seeDays()` did this job, because the tracking start came from
 * `daily_summary`. But in that table `refreshDate()` writes a row for everyone,
 * with or without data, so it measured "the server is running", not "we have observed".
 */
async function seeSessions(employeeId: number, days: number[]): Promise<void> {
  const device = await h.prisma.device.create({
    data: {
      hostname: `PC-${employeeId}`,
      windowsUsername: `user${employeeId}`,
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
    },
  });
  await h.prisma.workSession.createMany({
    data: days.map((d) => ({
      employeeId,
      deviceId: device.id,
      workDate: utc(d),
      startedAt: new Date(Date.UTC(2026, 7, d, 4, 0)),
    })),
  });
}

/** The list of days from `from` to `to` (both inclusive) */
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const monthRow = (employeeId: number) =>
  h.prisma.monthlySummary.findUniqueOrThrow({
    where: { employeeId_yearMonth: { employeeId, yearMonth: YEAR_MONTH } },
  });

describe('rollup: prorated target in monthly_summary', () => {
  it('a full month gives target = 27 x 8 = 216 hours, not a flat 208', async () => {
    const id = await makeEmployee({ empCode: 'PR-FULL' });
    await rollup();

    const row = await monthRow(id);

    expect(row.targetSec).toBe(216 * HOUR);
    expect(row.expectedWorkdays).toBe(MONTH_WORKDAYS);
    expect(row.monthWorkdays).toBe(MONTH_WORKDAYS);
  });

  /** The owner's example: "if someone joins on the 15th, 15 days of salary" */
  it('joining on 17 August gives a target of their own workdays x 8', async () => {
    const id = await makeEmployee({ empCode: 'PR-MID', joinedOn: utc(17) });
    await rollup();

    const row = await monthRow(id);

    // 17-31 August, minus Fridays the 21st and 28th = 13 days
    expect(row.expectedWorkdays).toBe(13);
    expect(row.targetSec).toBe(13 * 8 * HOUR);

    // D is in a separate column: the denominator of the payroll fraction
    expect(row.monthWorkdays).toBe(MONTH_WORKDAYS);
  });

  it('joining after the month gives target zero, and not "target met"', async () => {
    const id = await makeEmployee({ empCode: 'PR-LATE', joinedOn: new Date(Date.UTC(2026, 8, 10)) });
    await rollup();

    const row = await monthRow(id);

    expect(row.expectedWorkdays).toBe(0);
    expect(row.targetSec).toBe(0);
    /**
     * This is the subtle condition here: `credited >= target` means `0 >= 0`,
     * so someone who was not there at all that month would show "target met"
     * and a time would be set in `target_met_at`. Nothing worth calling an achievement happened.
     */
    expect(row.targetMet).toBe(false);
    expect(row.targetMetAt).toBeNull();
  });

  /**
   * The number has changed, from 13 to 0, and that is now correct.
   *
   * This test used to claim `workdaysElapsed === 13` and
   * `expectedSec === targetSec`, i.e. that for someone who joined on the 17th
   * the full 104 hours were being demanded on 31 August. But in this scenario
   * they have no `daily_summary` row at all: `rollup()` itself writes the
   * 31st's row for the first time. So we never observed them on those 13 days.
   *
   * A missing observation must not be counted as a failure (the central
   * principle of this project). The expectation for unobserved days is 0, so
   * pace is 0 too: not "they are behind", but "we do not know".
   *
   * The target (`target_sec`) stays intact: it is the contract number, and
   * payroll deductions come from it. This change touches only pace/expected.
   */
  it('someone not yet observed on even one finished day has an expectation of 0', async () => {
    const id = await makeEmployee({ empCode: 'PR-ELAPSED', joinedOn: utc(17) });
    await rollup();

    const row = await monthRow(id);

    expect(row.workdaysElapsed).toBe(0);
    expect(row.expectedSec).toBe(0);
    expect(row.paceSec).toBe(0);
    // yet the target is still their own 13 workdays as before
    expect(row.targetSec).toBe(13 * 8 * HOUR);
  });

  /**
   * Counted from tracking start, excluding today.
   *
   * One single row (17 August) is enough: the window start is decided by its
   * oldest row, not by how many rows there are. The missing rows for 18-30 are
   * not "unobserved days": the agent was installed, so they are genuine zero days.
   */
  it('workdays after tracking start are counted, excluding today', async () => {
    const id = await makeEmployee({ empCode: 'PR-SEEN', joinedOn: utc(17) });
    await seeDays(id, [17]);
    // G120: tracking start now comes from the session, not from an empty daily row
    await seeSessions(id, [17]);
    await rollup();

    const row = await monthRow(id);

    // 17-30 August (the 31st is today, excluded), minus Fridays the 21st and 28th = 12 days
    expect(row.workdaysElapsed).toBe(12);
    expect(row.expectedSec).toBe(96 * HOUR);
    // exactly 12/13 of the 13-day target: the last day has not finished yet
    expect(row.expectedSec).toBe(Math.round((row.targetSec * 12) / 13));
  });

  /**
   * Once the month is over, the expectation lands exactly on the target: no
   * more, no less. Otherwise someone who worked perfectly all month would show
   * "behind" at the end, and this feature's whole purpose is trust.
   */
  it('when the month is over, expectation = the full target', async () => {
    const id = await makeEmployee({ empCode: 'PR-CLOSED', joinedOn: utc(17) });
    await seeDays(id, [17]);
    await seeSessions(id, [17]);

    // "now" is 1 September: even the last day of August is now before yesterday
    await rollup(new Date(Date.UTC(2026, 8, 1, 12)));

    const row = await monthRow(id);

    expect(row.workdaysElapsed).toBe(13);
    expect(row.expectedSec).toBe(row.targetSec);
  });
});

describe('payroll: salary is prorated too', () => {
  const payroll = () =>
    owner.http.get(`/api/v1/payroll?month=${YEAR_MONTH}`).expect(200);

  const rowFor = (body: { rows: { empCode: string }[] }, code: string) =>
    body.rows.find((r) => r.empCode === code) as unknown as Record<string, string>;

  /**
   * Prorated base = salary x d / D. 20,000 x 13 / 27 = 9,629.63.
   *
   * The expectation of this test changed, and the change is deliberate. It
   * used to say `deduction = 9,629.63` and `payable = 0.00`, i.e. someone with
   * no data at all had their entire prorated salary deducted. The owner's
   * decision: no deduction for unobserved days.
   *
   * This employee has no `daily_summary` row at all (today is outside the
   * window), so the observed part is 0, the shortfall is 0, the deduction is 0.
   * The prorated base is now visible in `payable`, and that is the real point of this test.
   */
  it('prorated base = salary x d / D', async () => {
    await makeEmployee({ empCode: 'PR-PAY', joinedOn: utc(17), monthlySalary: 20000 });
    await rollup();

    const row = rowFor((await payroll()).body, 'PR-PAY');

    // 20,000 x 13 / 27 = 9,629.63: this is their base for the month
    expect(row.payable).toBe('9629.63');
    // nothing was observed, so there is no shortfall to claim either
    expect(row.deduction).toBe('0.00');
    expect(row.observedTargetHours).toBe('0.00');
  });

  /**
   * A direct form of the owner's example: "if someone joins on the 15th, 15
   * days of salary". Meeting their own full target (13 x 8 = 104h) means no
   * deduction, and payable is exactly the prorated salary.
   */
  it('meeting their own full target gets the whole prorated salary', async () => {
    const id = await makeEmployee({
      empCode: 'PR-WORKED',
      joinedOn: utc(17),
      monthlySalary: 20000,
    });

    // The 31st is excluded: `refreshDate(31)` rewrites that day's row from
    // segments, so anything written here would be erased.
    const workdays = [17, 18, 19, 20, 24, 25, 26, 27, 30];
    await h.prisma.dailySummary.createMany({
      data: workdays.map((day) => ({
        employeeId: id,
        workDate: utc(day),
        workedSec: 8 * HOUR,
        creditedSec: 8 * HOUR,
      })),
    });

    // 9 days x 8h = 72h; the other 4 days' 32h come from the owner's adjustment
    await h.prisma.dailySummary.update({
      where: { employeeId_workDate: { employeeId: id, workDate: utc(17) } },
      data: { adjustmentSec: 32 * HOUR },
    });

    await rollup();

    const month = await monthRow(id);
    expect(month.creditedSec).toBe(104 * HOUR);
    expect(month.targetSec).toBe(104 * HOUR);

    const row = rowFor((await payroll()).body, 'PR-WORKED');
    expect(row.deduction).toBe('0.00');
    expect(row.payable).toBe('9629.63');
  });

  /**
   * The most important test in this file, along the whole path.
   *
   * The fairness claim of ADR-025 is this equality: since both salary and
   * target are prorated, the hourly rate is independent of d. If only the
   * target were prorated, the rate of someone who joined on the 17th would
   * double, and a single number would not reveal it, only putting the two
   * people's rates side by side.
   */
  it('hourly rate: same for a 17th joiner and a full-month employee', async () => {
    await makeEmployee({ empCode: 'PR-A', monthlySalary: 20000 });
    await makeEmployee({ empCode: 'PR-B', joinedOn: utc(17), monthlySalary: 20000 });
    await rollup();

    const res = await payroll();

    expect(rowFor(res.body, 'PR-B').hourlyRate).toBe(rowFor(res.body, 'PR-A').hourlyRate);
    // 20000 / (27 x 8) = 92.59
    expect(rowFor(res.body, 'PR-A').hourlyRate).toBe('92.59');
  });

  it('joining after the month gives payable zero for that month', async () => {
    await makeEmployee({
      empCode: 'PR-NONE',
      joinedOn: new Date(Date.UTC(2026, 8, 10)),
      monthlySalary: 20000,
    });
    await rollup();

    const res = await payroll();
    expect(rowFor(res.body, 'PR-NONE').payable).toBe('0.00');
  });
});

/**
 * G117: the report's target also counts office days.
 *
 * The owner's rule: 8 hours a day, excluding holidays and Fridays, and
 * *"maser hisab na kore office day hisab koro"*।
 *
 * Why these tests are needed separately: before, there was not a single
 * assertion on this number in the whole repo, only empty `{}` fixtures in
 * three places. So even if `meta` returned a flat 208, everything would stay
 * green, and that is exactly what happened.
 *
 * Each claim matches `monthly_summary.target_sec` as well as the constant:
 * matching only the constant would stay green even if the two drifted apart
 * again, and G117 would silently come back.
 */
/**
 * No deduction for days that were not observed (the owner's decision, 6
 * September 2026).
 *
 * A bug found in the field. Payroll measured the shortfall against the full
 * `target_sec`, yet `credited_sec` only comes from days when the system was
 * running. In August 2026 tracking started on the 13th-15th, so nearly half
 * the month was unobserved, yet those days were deducted from salary as
 * shortfall. The deductions of 12 people came to 79,788.00, of which 61,280.00
 * was for unobserved days.
 *
 * The correct number was sitting in the same row (`monthly_summary.expected_sec`,
 * 112-120 hours); payroll just did not read it.
 *
 * This describe guards the joint: does the rollup write the number, and does
 * payroll read it.
 */
describe('no deduction for unobserved days', () => {
  const payroll = () =>
    owner.http.get(`/api/v1/payroll?month=${YEAR_MONTH}`).expect(200);

  const rowOf = async (code: string) =>
    (await payroll()).body.rows.find(
      (r: { empCode: string }) => r.empCode === code,
    ) as Record<string, string | number>;

  /**
   * The most valuable test in this file: the real shape of August.
   *
   * The employee was there the whole month, but we started watching on the
   * 13th. Workdays from 13-30 August number 15 (excluding Fridays the 14th,
   * 21st, 28th), while the month has 27. So the shortfall is asked against 120 hours, not 216.
   */
  it('observation starting on the 13th: shortfall against 120 hours, not 216', async () => {
    const id = await makeEmployee({ empCode: 'OB-HALF', monthlySalary: 20000 });
    const days = range(13, 30);
    await seeSessions(id, days);
    await seeDays(id, days);
    await rollup();

    const month = await monthRow(id);
    expect(month.targetSec).toBe(216 * 3600);
    expect(month.observedWorkdays).toBe(15);

    const row = await rowOf('OB-HALF');
    expect(row.observedTargetHours).toBe('120.00');
    expect(row.shortfallHours).toBe('120.00');

    // 20,000 x 120 / 216 = 11,111.11: not the full salary
    expect(row.deduction).toBe('11111.11');
    expect(row.payable).toBe('8888.89');
  });

  /**
   * What the old behaviour was, so that anyone bringing it back notices the
   * difference. The same employee observed the whole month has a shortfall of
   * 216 hours, and the deduction is the full salary.
   */
  it('with the whole month observed, the full target is certainly used', async () => {
    const id = await makeEmployee({ empCode: 'OB-FULL', monthlySalary: 20000 });
    const days = range(1, 30);
    await seeSessions(id, days);
    await seeDays(id, days);
    await rollup();

    expect((await monthRow(id)).observedWorkdays).toBe(26);

    const row = await rowOf('OB-FULL');
    // 1-30 August has 26 workdays (excluding Fridays 7, 14, 21, 28); the 31st is today
    expect(row.observedTargetHours).toBe('208.00');
    expect(row.deduction).toBe('19259.26');
  });

  /**
   * G109: a gap in the middle of the window is no longer a shortfall either.
   *
   * This used to be deliberately left open (the owner dropped it on 23
   * August), because `elapsedWorkdays()` trimmed only the two ends of the
   * window and counted the days inside by the calendar. Now on the payroll
   * path that is closed too: no row means we were not counting that day.
   *
   * G109 is still open on the other screens: the tray, Live Board and Monthly
   * still read `expected_sec`, which is counted by the calendar.
   */
  it('days when the server was down in the middle are no longer a shortfall', async () => {
    const id = await makeEmployee({ empCode: 'OB-GAP', monthlySalary: 20000 });
    // No rows for 17-20 August: three workdays out of the four days (including Thursday the 20th)
    const days = [...range(13, 16), ...range(21, 30)];
    await seeSessions(id, days);
    await seeDays(id, days);
    await rollup();

    const month = await monthRow(id);

    // 13-30 has 15 workdays; of these 17, 18, 19, 20 are all workdays -> 11
    expect(month.observedWorkdays).toBe(11);
    // the calendar-based number is still 15: two different questions
    expect(month.workdaysElapsed).toBe(15);

    const row = await rowOf('OB-GAP');
    expect(row.observedTargetHours).toBe('88.00');
  });

  /**
   * R21: the deposit and net payable really go on the wire.
   *
   * The server sent both from day one, but the screen never even declared
   * them, so the sheet the owner used to pay from showed gross. This test pins
   * the server side; the screen side is the two columns in `PayrollTab.tsx`.
   */
  it('the sheet row has both the deposit and net payable', async () => {
    const id = await makeEmployee({ empCode: 'OB-DEP', monthlySalary: 20000 });
    const days = range(1, 30);
    await seeSessions(id, days);
    await seeDays(id, days);
    await rollup();

    const row = await rowOf('OB-DEP');

    expect(row).toHaveProperty('securityDeposit');
    expect(row).toHaveProperty('netPayable');
    // net = payable - instalment; with no instalment the two are equal
    expect(row.netPayable).toBe(row.payable);
  });
});

describe('G117: the report target counts office days, not a flat 208', () => {
  const monthTarget = async (employeeId: number): Promise<number> => {
    const r = await reports.attendance({ from: '2026-08-01', to: '2026-08-31' });
    return r.meta.targetHoursInRange[employeeId];
  };

  it('a full month gives 216 hours, exactly the same as monthly_summary', async () => {
    const id = await makeEmployee({ empCode: 'G117-FULL' });
    await rollup();

    // 27 office days x 8h. With the policy's flat 208 this very claim would break.
    expect(await monthTarget(id)).toBe(216);

    // the real guard: whether the two numbers counted by two paths are equal
    expect(await monthTarget(id)).toBe((await monthRow(id)).targetSec / HOUR);
  });

  it('joining on 17 August counts only their own 13 office days', async () => {
    const id = await makeEmployee({ empCode: 'G117-MID', joinedOn: utc(17) });
    await rollup();

    expect(await monthTarget(id)).toBe(13 * 8);
    expect(await monthTarget(id)).toBe((await monthRow(id)).targetSec / HOUR);
  });

  /**
   * This is the real proof of "by office days, not by month".
   *
   * 1-10 August is 10 days, of which the 7th is a Friday: 9 office days = 72h.
   * The old code said 208 here too, because the number did not look at the range.
   */
  it('half a month gives half a month\'s target: 9 office days = 72 hours', async () => {
    const id = await makeEmployee({ empCode: 'G117-HALF' });
    await rollup();

    const r = await reports.attendance({ from: '2026-08-01', to: '2026-08-10' });
    expect(r.meta.targetHoursInRange[id]).toBe(72);
  });

  /**
   * R2: paid-leave days are excluded from the target, otherwise the leave
   * itself would become a shortfall. 3 and 4 August (Monday, Tuesday) are both
   * office days, so 216 - 16 = 200.
   */
  it('leave days are excluded too, and it matches the tray number', async () => {
    const id = await makeEmployee({ empCode: 'G117-LEAVE' });
    // `created_by` is mandatory: who set the leave must be in the ledger
    await h.prisma.leave.createMany({
      data: [
        { employeeId: id, leaveDate: utc(3), type: 'casual', createdBy: OWNER_EMAIL },
        { employeeId: id, leaveDate: utc(4), type: 'casual', createdBy: OWNER_EMAIL },
      ],
    });
    await rollup();

    expect(await monthTarget(id)).toBe(200);
    expect(await monthTarget(id)).toBe((await monthRow(id)).targetSec / HOUR);
  });

  /**
   * Someone who was not an employee in that range is not in the report at
   * all, so the cell is `undefined`, not 0. The difference is real: 0 means
   * "no office days", and `undefined` means "no row for them on this paper".
   *
   * Yet 0 is reachable, when the whole range is spent on leave. It was not
   * before (a flat 208 was never 0), so the web shows "No target" instead of
   * "0h 0m, 0%" (`HeatGrid.tsx`).
   */
  it('joining next month means not on this paper at all: absent, not 0', async () => {
    const id = await makeEmployee({
      empCode: 'G117-LATE',
      joinedOn: new Date(Date.UTC(2026, 8, 10)),
    });
    await rollup();

    const r = await reports.attendance({ from: '2026-08-01', to: '2026-08-31' });
    expect(r.meta.targetHoursInRange[id]).toBeUndefined();
    expect(r.rows.some((row) => row.employeeId === id)).toBe(false);
  });
});

/**
 * G120: "since when we have been watching" now goes by `work_sessions`.
 *
 * The bug this catches: `refreshDate()` writes a `daily_summary` row for
 * every active employee, with or without data. So if an employee was created
 * on the 1st, "watching" was counted from that day, and even if the agent was
 * installed on the 17th the days in between stayed a full shortfall.
 *
 * Unit tests cannot catch this: there `trackingStartedOn` is set by hand. The
 * gap was in which table the number comes from, and that can only be tested
 * with the database.
 */
describe('G120: tracking start: a real session, not an empty row', () => {
  /**
   * `workdaysElapsed`, not `expectedWorkdays`: they are two different things,
   * and the first time I read the wrong one (CI caught it).
   *
   * `expectedWorkdays` is `prorate()`'s d, i.e. their own workdays, and has
   * nothing to do with tracking start. The window goes into `workdaysElapsed`,
   * and `expectedSec` comes from there.
   */
  const elapsed = async (employeeId: number): Promise<number> =>
    (await monthRow(employeeId)).workdaysElapsed;

  /**
   * The real reproduction. Empty `daily_summary` rows exist for 1-16 August
   * (exactly what `refreshDate()` writes), but the agent's first session is on the 17th.
   *
   * With the old code tracking start was 1 August, so the expectation window
   * opened across the whole month. Now it opens from the 17th.
   */
  it('with empty rows piled up, days before the agent was installed are not counted', async () => {
    const id = await makeEmployee({ empCode: 'G120-LATE' });
    await seeDays(id, Array.from({ length: 16 }, (_, i) => i + 1));
    await seeSessions(id, [17]);
    await rollup();

    // 17-30 August (excluding today the 31st), minus Fridays the 21st and 28th = 12 days
    expect(await elapsed(id)).toBe(12);
  });

  /**
   * The guard for the other direction. If someone has no session at all, the
   * helper returns nothing, and the caller then passes `today`: window empty, expectation 0.
   *
   * If someone mistakenly writes `?? null`, this very test breaks: `null`
   * means "no limit", so the expectation would become the whole month's.
   */
  it('the agent never sent anything: expectation 0, not the whole month', async () => {
    const id = await makeEmployee({ empCode: 'G120-NEVER' });
    await seeDays(id, [1, 2, 3, 4, 5]);
    await rollup();

    expect(await elapsed(id)).toBe(0);

    // the target is intact: this fix touches no money calculation
    expect((await monthRow(id)).targetSec).toBe(216 * HOUR);
  });

  /** With a session the number is fixed: it does not move even if the rollup is run twice */
  it('running the rollup twice does not move the tracking start', async () => {
    const id = await makeEmployee({ empCode: 'G120-STABLE' });
    await seeSessions(id, [17, 18, 19]);

    await rollup();
    const first = await elapsed(id);
    await rollup();

    expect(await elapsed(id)).toBe(first);
  });
});

/**
 * G108: the assumption `d / D` stands on is written on the payroll itself
 * (4 September 2026).
 *
 * Lunar holiday dates move after the moon is sighted. When they move, that
 * month's workdays change, i.e. the denominator D changes, and with it every
 * employee's prorated salary. Until now this uncertainty lived only on the
 * holiday itself; whoever opened payroll and released salary did not know the
 * number could still move.
 *
 * An e2e is needed here because the risk is not in the arithmetic but at the
 * joint: does `sheet()` read the month's holiday rows at all, and does it put
 * what it reads into the response.
 */
describe('G108: payroll says which dates are not final yet', () => {
  const payrollBody = async () =>
    (await owner.http.get(`/api/v1/payroll?month=${YEAR_MONTH}`).expect(200))
      .body as { approximateHolidayDates: string[] };

  /** Wednesday 26 August: not a Friday, so this really takes away a workday */
  const addHoliday = (day: number, name: string, approximate = false) =>
    h.prisma.holiday.create({ data: { holidayDate: utc(day), name, approximate } });

  it('with an approximate holiday, the date goes into the response', async () => {
    await makeEmployee({ empCode: 'G108-PAY' });
    await addHoliday(26, 'Harvest Festival', true);
    await rollup();

    expect((await payrollBody()).approximateHolidayDates).toEqual(['2026-08-26']);
  });

  it('a confirmed holiday stays quiet: warning on every holiday is worthless', async () => {
    await makeEmployee({ empCode: 'G108-FIXED' });
    await addHoliday(26, 'National Day');
    await rollup();

    expect((await payrollBody()).approximateHolidayDates).toEqual([]);
  });

  it('with no holiday at all it is empty, not `undefined`', async () => {
    // With `undefined` the web would break reading `.length`, and it would
    // break in exactly the month with no holiday, i.e. not in testing.
    await makeEmployee({ empCode: 'G108-NONE' });
    await rollup();

    expect((await payrollBody()).approximateHolidayDates).toEqual([]);
  });

  /**
   * Whether the warning really speaks about that money.
   *
   * Checking only "the date is in the list" would stay green even if the
   * holiday were not counted at all. So here two things are checked together
   * in the same month: the date appears in the warning, and the same date
   * really took away a workday (27 -> 26), changing the prorated base. Both
   * come from one row: "one number, one definition".
   */
  it('the holiday named in the warning is the one that reduces D', async () => {
    await makeEmployee({ empCode: 'G108-D', monthlySalary: 20000 });
    await addHoliday(26, 'Harvest Festival', true);
    await rollup();

    const body = (await owner.http
      .get(`/api/v1/payroll?month=${YEAR_MONTH}`)
      .expect(200)).body as {
      approximateHolidayDates: string[];
      rows: { empCode: string; hourlyRate: string }[];
    };

    expect(body.approximateHolidayDates).toEqual(['2026-08-26']);

    // 26 workdays, not 27 -> 20000 / (26 x 8) = 96.15 (with 27 it would be 92.59)
    const row = body.rows.find((r) => r.empCode === 'G108-D')!;
    expect(row.hourlyRate).toBe('96.15');
  });

  /**
   * Pulling in a holiday from outside the month would show September's
   * uncertainty on August's paper, though it does not touch August's D at all.
   */
  it('another month\'s approximate holiday does not come into this month\'s paper', async () => {
    await makeEmployee({ empCode: 'G108-OTHER' });
    await h.prisma.holiday.create({
      data: {
        holidayDate: new Date(Date.UTC(2026, 8, 15)),
        name: 'Next month',
        approximate: true,
      },
    });
    await rollup();

    expect((await payrollBody()).approximateHolidayDates).toEqual([]);
  });
});

/**
 * G110, G111: the report's `meta` tells two states apart (5 September 2026).
 *
 * Both are the same kind of fault: no number is wrong, but one state passes
 * as the other.
 *   - G111: someone not yet observed on even one finished workday has an
 *     expectation of 0, so a shortfall of 0 too: on screen exactly like "target met".
 *   - G110: the days before tracking started got a reddish tint of "nothing
 *     happened on a workday" in the heatmap.
 *
 * An e2e is needed because the risk is not in the arithmetic but at the
 * joint: does `context()` fill the two cells, and does `meta` pick them up.
 */
describe('G110, G111: "observed" and "since when" in meta', () => {
  const metaOf = async () =>
    (await reports.attendance({ from: '2026-08-01', to: '2026-08-31' })).meta;

  it('not one finished day observed: `observed` is false', async () => {
    // No session, so tracking start = today (31 August), and the window is empty
    const id = await makeEmployee({ empCode: 'G111-NEW' });
    await rollup();

    expect((await metaOf()).observed[id]).toBe(false);
  });

  it('a finished day observed: `observed` is true', async () => {
    const id = await makeEmployee({ empCode: 'G111-SEEN' });
    await seeSessions(id, [17, 18, 19]);
    await rollup();

    expect((await metaOf()).observed[id]).toBe(true);
  });

  /**
   * The most important test of this file's G111 part: the two are tied to one formula.
   *
   * The flag and the expectation can never say two things, and that is not
   * coincidence: both come out of the same window (`elapsedWindow`). If they
   * were counted by a separate query or a separate rule, one day the page
   * would write "not observed yet" while showing a 120-hour shortfall beside
   * it: the same row contradicting itself.
   *
   * If someone later builds the flag from somewhere else (say, by counting
   * `daily_summary` rows), this very equality will break.
   */
  it('`observed` false <=> expectation 0: both from the same window', async () => {
    const seen = await makeEmployee({ empCode: 'G111-A' });
    await seeSessions(seen, [17, 18]);

    // the agent never sent anything
    const unseen = await makeEmployee({ empCode: 'G111-B' });
    await rollup();

    const meta = await metaOf();

    expect(meta.observed[seen]).toBe(true);
    expect(meta.expectedHours[seen]).toBeGreaterThan(0);

    expect(meta.observed[unseen]).toBe(false);
    expect(meta.expectedHours[unseen]).toBe(0);

    // But the target is intact for both: the window does not touch the target,
    // and that is exactly why an unobserved person's whole target drops out of the team sum.
    expect(meta.targetHoursInRange[unseen]).toBe(216);
  });

  it('G110: the tracking start date goes into meta', async () => {
    const id = await makeEmployee({ empCode: 'G110-DATE' });
    await seeSessions(id, [13, 14, 17]);
    await rollup();

    // the oldest session's day: 13 August, exactly as it happened on this installation
    expect((await metaOf()).trackedFrom[id]).toBe('2026-08-13');
  });

  it('G110: when nothing was ever sent, the date is `null`', async () => {
    // Not 0 and not today's date: `null` means "no information", and the page
    // then draws every workday of the month as unobserved. Putting today's
    // date would make the page claim we are watching from today, though there
    // is not a single session.
    const id = await makeEmployee({ empCode: 'G110-NEVER' });
    await rollup();

    expect((await metaOf()).trackedFrom[id]).toBeNull();
  });

  /**
   * The date does not change the expectation: this is G110's whole risk.
   *
   * The only purpose of sending the date is drawing. If someone one day uses
   * it to count the expectation again, the "excluding today" rule would be
   * written a second time, and that is exactly how the earlier bug was born.
   * Here it is checked: both the date and the expectation are present, and the
   * expectation is the window's number, not counted from the date.
   */
  it('observed from 13 August: expectation runs 13th to 30th, not from the 1st', async () => {
    const id = await makeEmployee({ empCode: 'G110-EXP' });
    await seeSessions(id, [13]);
    await rollup();

    const meta = await metaOf();

    expect(meta.trackedFrom[id]).toBe('2026-08-13');
    /**
     * 13-31 August has 16 workdays (excluding Fridays 14, 21, 28) x 8h = 128.
     *
     * The window's right end is yesterday, and August 2026 is now entirely in
     * the past, so the month falls wholly inside and the number will never
     * move again (G140: the spec's number cannot change with the calendar).
     * The real claim is not the number: it was not counted from 1 August.
     * Counting the whole month would give 216, i.e. a phantom shortfall of 88 hours.
     */
    expect(meta.expectedHours[id]).toBe(128);
    expect(meta.expectedHours[id]).toBeLessThan(216);
    // the whole month's target is intact: the window does not touch the target
    expect(meta.targetHoursInRange[id]).toBe(216);
  });
});

/**
 * G130 (R2): leave is written on the report row too (5 September 2026).
 *
 * Leave reached the numbers long ago (see `leave.spec.ts` above and this
 * file's target tests): nobody shows "behind" for leave any more. But the row
 * looked exactly like a workday with zero hours, and to learn the reason you
 * had to go to Settings > Leave.
 *
 * An e2e is needed because the risk is at the joint: does `context()` fill the
 * flag, and does the row pick it up.
 */
describe('G130: "On leave" on the report row', () => {
  const rowsOf = async (empId: number) =>
    (await reports.attendance({ from: '2026-08-01', to: '2026-08-31' })).rows
      .filter((r) => r.employeeId === empId);

  /** Thursday 20 August: a workday, so the leave really takes away some target */
  const takeLeave = (employeeId: number, day: number) =>
    h.prisma.leave.create({
      data: { employeeId, leaveDate: utc(day), createdBy: 'test@oxeio' },
    });

  it('the flag is set on the leave day\'s row and not on other days', async () => {
    const id = await makeEmployee({ empCode: 'G130-ROW' });
    await takeLeave(id, 20);
    await rollup();

    const rows = await rowsOf(id);
    const onLeaveDay = rows.find((r) => r.date === '2026-08-20')!;
    const normalDay = rows.find((r) => r.date === '2026-08-19')!;

    expect(onLeaveDay.onLeave).toBe(true);
    expect(normalDay.onLeave).toBe(false);
  });

  /**
   * One set, two uses: this is the real guard.
   *
   * If the badge came from a separate query, one day the row would say
   * "On leave" without the target being cut (or the reverse): the paper would
   * contradict itself. Here it is checked that both come from the same row:
   * the flag is set and that day's target is 0.
   */
  it('the day with the flag has target 0 on that same day', async () => {
    const id = await makeEmployee({ empCode: 'G130-TARGET' });
    await takeLeave(id, 20);
    await rollup();

    const rows = await rowsOf(id);

    expect(rows.find((r) => r.date === '2026-08-20')).toMatchObject({
      onLeave: true,
      targetHours: 0,
      dayType: 'workday',
    });
    // the next day is intact: the leave did not spread
    expect(rows.find((r) => r.date === '2026-08-19')).toMatchObject({
      onLeave: false,
      targetHours: 8,
    });
  });

  /**
   * Nothing is written to `daily_summary`; the `leaves` table is read
   * directly, and that is right: when a leave is deleted the badge goes
   * immediately, without waiting for the next rollup. This is checked without running the rollup.
   */
  it('deleting a leave removes the badge immediately, without a rollup', async () => {
    const id = await makeEmployee({ empCode: 'G130-DELETE' });
    const leave = await takeLeave(id, 20);
    await rollup();

    expect((await rowsOf(id)).find((r) => r.date === '2026-08-20')!.onLeave).toBe(
      true,
    );

    await h.prisma.leave.delete({ where: { id: leave.id } });

    expect((await rowsOf(id)).find((r) => r.date === '2026-08-20')!.onLeave).toBe(
      false,
    );
  });
});
