import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ScheduleService } from '../src/schedule/schedule.service';
import { SummaryService } from '../src/summary/summary.service';
import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  hashPassword,
  loginReady,
  MANAGER_EMAIL,
  MANAGER_PASSWORD,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
  workTodayIso,
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
  const res = await owner.http
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
  expect(res.status).toBe(200);
}

async function dayWith(stretches: [string, string][]) {
  const { employeeId, code } = await createEmployeeWithCode(h.prisma);
  const { deviceId } = await enrollDevice(h, code);
  const session = await h.prisma.workSession.create({
    data: { employeeId, deviceId, workDate, startedAt: local('07:00') },
  });
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
    await enforce(true);
    const employeeId = await dayWith([
      ['08:20', '12:00'],
      ['12:30', '17:00'],
    ]);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);

    const row = await h.prisma.scheduleDay.findUniqueOrThrow({
      where: { employeeId_workDate: { employeeId, workDate } },
    });
    expect(row).toMatchObject({
      arrivedMin: 500,
      leftMin: 1020,
      lateMin: 20,
      breakMin: 30,
      final: true,
    });
    expect(row.breaches).toEqual(['late', 'break_short']);
  });

  it('no schedule enforced: no rows', async () => {
    await dayWith([['08:00', '17:00']]);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(0);
  });

  it('switching it off removes the rows on the next recount', async () => {
    await enforce(true);
    await dayWith([['08:00', '17:00']]);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(1);

    await enforce(false);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(0);
  });

  it('a day of recorded leave is not checked', async () => {
    await enforce(true);
    const employeeId = await dayWith([]);
    await h.prisma.leave.create({
      data: { employeeId, leaveDate: workDate, createdBy: OWNER_EMAIL },
    });
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(0);
  });

  it('changing the schedule queues the open months for recount', async () => {
    await enforce(true);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });

  it('an invalid schedule is refused', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    const res = await owner.http
      .patch(`/api/v1/work-policies/${policy.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({
        scheduleEnforced: true,
        officeFrom: '08:00',
        officeTo: '17:00',
        breakWindowFrom: '11:00',
      });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/both ends/);
  });

  it('a break no longer than the presence gap is refused, on update and on create', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    const schedule = {
      scheduleEnforced: true,
      officeFrom: '08:00',
      officeTo: '17:00',
      breakMinutes: 20,
    };
    const res = await owner.http
      .patch(`/api/v1/work-policies/${policy.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ ...schedule, presenceGapMin: 20 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(
      /longest pause that still counts as work \(20 min\)/,
    );

    // the stored gap (15 by default) counts when the save does not send one
    await owner.http
      .patch(`/api/v1/work-policies/${policy.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ ...schedule, breakMinutes: 15 })
      .expect(400);

    const created = await owner.http
      .post('/api/v1/work-policies')
      .set('X-CSRF-Token', owner.csrf)
      .send({ name: 'Gap', ...schedule, breakMinutes: 30, presenceGapMin: 30 });
    expect(created.status).toBe(400);
    expect(JSON.stringify(created.body)).toMatch(/\(30 min\)/);
  });
});

describe('what queues a recount', () => {
  const patchPolicy = async (body: object) => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    const res = await owner.http
      .patch(`/api/v1/work-policies/${policy.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send(body);
    expect(res.status).toBe(200);
  };

  it('re-sending the same schedule queues nothing', async () => {
    await enforce(true);
    await h.prisma.summaryDirty.deleteMany();
    await enforce(true);
    expect(await h.prisma.summaryDirty.count()).toBe(0);
  });

  it('switching enforcement off queues the recount', async () => {
    await enforce(true);
    await h.prisma.summaryDirty.deleteMany();
    await enforce(false);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });

  it('a gap-only change on an active policy with an enforced schedule queues the recount', async () => {
    await enforce(true);
    await h.prisma.summaryDirty.deleteMany();
    await patchPolicy({ presenceGapMin: 30 });
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });
});

describe('moving a person to another policy', () => {
  async function secondPolicy(scheduleEnforced: boolean) {
    const { id: _id, ...base } = await h.prisma.workPolicy.findFirstOrThrow({
      orderBy: { id: 'asc' },
    });
    return h.prisma.workPolicy.create({
      data: {
        ...base,
        name: 'Second',
        scheduleEnforced,
        officeFrom: '08:00',
        officeTo: '17:00',
      },
    });
  }
  const move = (employeeId: number, policyId: number) =>
    owner.http
      .patch(`/api/v1/employees/${employeeId}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ policyId });

  it('to a policy that checks a schedule queues the open months', async () => {
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    const checked = await secondPolicy(true);
    await move(employeeId, checked.id).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });

  it('to a policy that checks nothing, as before, queues nothing', async () => {
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    const unchecked = await secondPolicy(false);
    await move(employeeId, unchecked.id).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBe(0);
  });

  it('between two checked schedules that differ only in the gap queues the open months', async () => {
    const first = await secondPolicy(true);
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    await h.prisma.employee.update({
      where: { id: employeeId },
      data: { policyId: first.id },
    });
    const wider = await h.prisma.workPolicy.create({
      data: {
        ...(({ id: _i, ...b }) => b)(first),
        name: 'Third',
        presenceGapMin: first.presenceGapMin + 15,
      },
    });
    await move(employeeId, wider.id).expect(200);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });
});

describe('schedule endpoints', () => {
  it('the month view and its totals', async () => {
    await enforce(true);
    const employeeId = await dayWith([
      ['08:20', '12:00'],
      ['12:30', '17:00'],
    ]);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);

    const people = await owner.http.get('/api/v1/schedule/people').expect(200);
    expect(people.body.map((p: { id: number }) => p.id)).toContain(employeeId);

    const res = await owner.http
      .get(`/api/v1/schedule?employeeId=${employeeId}&month=2026-10`)
      .expect(200);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.totals).toMatchObject({ late: 1, breakShort: 1 });
    expect(res.body.requiredBreakMin).toBe(60);
    // the scheduled day, for the screen's header
    expect(res.body).toMatchObject({ officeFrom: '08:00', officeTo: '17:00' });
  });

  it('an unknown employee, even one beyond the id range, is a 404', async () => {
    await owner.http
      .get('/api/v1/schedule?employeeId=999999&month=2026-10')
      .expect(404);
    await owner.http
      .get('/api/v1/schedule?employeeId=99999999999&month=2026-10')
      .expect(404);
  });

  it('a coordinator is refused with a 403', async () => {
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    await h.prisma.user.create({
      data: {
        email: 'sched-coord@test.local',
        fullName: 'Coordinator',
        passwordHash: await hashPassword('staff-password-123'),
        role: 'coordinator',
        employeeId,
        mustChangePw: false,
      },
    });
    const session = await loginReady(
      h,
      'sched-coord@test.local',
      'staff-password-123',
    );
    await session.http.get('/api/v1/schedule/people').expect(403);
    await session.http
      .get(`/api/v1/schedule?employeeId=${employeeId}&month=2026-10`)
      .expect(403);
  });

  it('a bad month is a 400', async () => {
    await owner.http
      .get('/api/v1/schedule?employeeId=1&month=2026-13')
      .expect(400);
  });
});

describe('inputs that change after the day was counted', () => {
  const dirtyDates = async () =>
    (
      await h.prisma.summaryDirty.findMany({ orderBy: { workDate: 'asc' } })
    ).map((r) => r.workDate.toISOString().slice(0, 10));

  /** a checked day with no activity at all, counted: one no_show row */
  async function countedNoShow() {
    await enforce(true);
    const employeeId = await dayWith([]);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    const row = await h.prisma.scheduleDay.findUniqueOrThrow({
      where: { employeeId_workDate: { employeeId, workDate } },
    });
    expect(row.breaches).toEqual(['no_show']);
    await h.prisma.summaryDirty.deleteMany();
    return employeeId;
  }

  it('leave added afterwards removes the no_show row on the next drain', async () => {
    const employeeId = await countedNoShow();
    await owner.http
      .post('/api/v1/leaves')
      .set('X-CSRF-Token', owner.csrf)
      .send({ employeeId, from: '2026-10-05', to: '2026-10-05', type: 'sick' })
      .expect(201);
    expect(await dirtyDates()).toEqual(['2026-10-05']);

    await h.app.get(SummaryService).drainDirty(DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(0);
  });

  it('removing that leave queues the day again', async () => {
    const employeeId = await countedNoShow();
    const leave = await h.prisma.leave.create({
      data: { employeeId, leaveDate: workDate, createdBy: OWNER_EMAIL },
    });
    await owner.http
      .delete(`/api/v1/leaves/${leave.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .expect((res) => expect(res.status).toBeLessThan(300));
    expect(await dirtyDates()).toEqual(['2026-10-05']);
  });

  it('leave for days still to come queues nothing', async () => {
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    await owner.http
      .post('/api/v1/leaves')
      .set('X-CSRF-Token', owner.csrf)
      .send({
        employeeId,
        from: '2099-01-05',
        to: '2099-01-09',
        type: 'annual',
      })
      .expect(201);
    expect(await dirtyDates()).toEqual([]);
  });

  it('a holiday added afterwards removes the row; moving or removing it queues both dates', async () => {
    await countedNoShow();
    const created = await owner.http
      .post('/api/v1/holidays')
      .set('X-CSRF-Token', owner.csrf)
      .send({ holidayDate: '2026-10-05', name: 'Founders day' })
      .expect(201);
    expect(await dirtyDates()).toEqual(['2026-10-05']);
    await h.app.get(SummaryService).drainDirty(DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(0);

    await owner.http
      .patch(`/api/v1/holidays/${created.body.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ holidayDate: '2026-10-02' })
      .expect(200);
    expect(await dirtyDates()).toEqual(['2026-10-02', '2026-10-05']);

    await h.prisma.summaryDirty.deleteMany();
    await owner.http
      .delete(`/api/v1/holidays/${created.body.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .expect(200);
    expect(await dirtyDates()).toEqual(['2026-10-02']);
  });

  it('a holiday renamed in place queues nothing', async () => {
    const holiday = await h.prisma.holiday.create({
      data: { holidayDate: workDate, name: 'Old name' },
    });
    await owner.http
      .patch(`/api/v1/holidays/${holiday.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ name: 'New name' })
      .expect(200);
    expect(await dirtyDates()).toEqual([]);
  });

  it('new weekly days off on a policy that checks a schedule queue the open months', async () => {
    await enforce(true);
    await h.prisma.summaryDirty.deleteMany();
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    const patch = (weeklyOffDays: number[]) =>
      owner.http
        .patch(`/api/v1/work-policies/${policy.id}`)
        .set('X-CSRF-Token', owner.csrf)
        .send({ weeklyOffDays })
        .expect(200);

    // the same days in another order are the same days
    await patch([...policy.weeklyOffDays].reverse());
    expect(await h.prisma.summaryDirty.count()).toBe(0);

    await patch(policy.weeklyOffDays.includes(1) ? [6, 7] : [1, 6, 7]);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });

  it('new weekly days off on a policy that checks nothing queue nothing', async () => {
    const policy = await h.prisma.workPolicy.findFirstOrThrow();
    await owner.http
      .patch(`/api/v1/work-policies/${policy.id}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({
        weeklyOffDays: policy.weeklyOffDays.includes(1) ? [6, 7] : [1, 6, 7],
      })
      .expect(200);
    expect(await h.prisma.summaryDirty.count()).toBe(0);
  });

  it('a person deactivated with an earlier last day loses the later rows on the next drain', async () => {
    const employeeId = await countedNoShow();
    // someone still active, so the day has a roll-up to run
    await createEmployeeWithCode(h.prisma, 'OX-002');
    await owner.http
      .post(`/api/v1/employees/${employeeId}/deactivate`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ leftOn: '2026-10-02', reason: 'moved away' })
      .expect((res) => expect(res.status).toBeLessThan(300));
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);

    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    expect(await h.prisma.scheduleDay.count({ where: { employeeId } })).toBe(0);
  });

  it('reactivating, or a new first day, queues the open months', async () => {
    const employeeId = await countedNoShow();
    await owner.http
      .patch(`/api/v1/employees/${employeeId}`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ joinedOn: '2026-10-06' })
      .expect(200);
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    expect(await h.prisma.scheduleDay.count()).toBe(0);

    await h.prisma.summaryDirty.deleteMany();
    await h.prisma.employee.update({
      where: { id: employeeId },
      data: { status: 'inactive', leftOn: workDate },
    });
    await owner.http
      .post(`/api/v1/employees/${employeeId}/reactivate`)
      .set('X-CSRF-Token', owner.csrf)
      .expect((res) => expect(res.status).toBeLessThan(300));
    expect(await h.prisma.summaryDirty.count()).toBeGreaterThanOrEqual(28);
  });

  it('on a policy that checks nothing, deactivating queues nothing', async () => {
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    await owner.http
      .post(`/api/v1/employees/${employeeId}/deactivate`)
      .set('X-CSRF-Token', owner.csrf)
      .send({ reason: 'moved away' })
      .expect((res) => expect(res.status).toBeLessThan(300));
    expect(await h.prisma.summaryDirty.count()).toBe(0);
  });
});

describe('the daily summary block', () => {
  it('leaves out people who are no longer active', async () => {
    await enforce(true);
    const employeeId = await dayWith([['08:20', '17:00']]);
    await h.app.get(SummaryService).refreshDate(workDate, DAY_OVER);
    const schedule = h.app.get(ScheduleService);
    expect(await schedule.breachesOn(workDate)).toHaveLength(1);

    await h.prisma.employee.update({
      where: { id: employeeId },
      data: { status: 'inactive' },
    });
    expect(await schedule.breachesOn(workDate)).toEqual([]);
  });
});

describe("today's schedule for the Live Board", () => {
  const today = new Date(`${workTodayIso()}T00:00:00.000Z`);

  async function staff(role: 'coordinator' | 'employee' | 'finance') {
    const { employeeId } = await createEmployeeWithCode(h.prisma, `T-${role}`);
    const email = `today-${role}@test.local`;
    await h.prisma.user.create({
      data: {
        email,
        fullName: role,
        passwordHash: await hashPassword('staff-password-123'),
        role,
        employeeId,
        mustChangePw: false,
      },
    });
    return loginReady(h, email, 'staff-password-123');
  }

  it("lists people on a checked schedule with today's row, sorted by name", async () => {
    await enforce(true);
    const { employeeId: zoe } = await createEmployeeWithCode(h.prisma, 'T-1');
    await h.prisma.employee.update({
      where: { id: zoe },
      data: { fullName: 'Zoe Row' },
    });
    const { employeeId: ann } = await createEmployeeWithCode(h.prisma, 'T-2');
    await h.prisma.employee.update({
      where: { id: ann },
      data: { fullName: 'Ann Norow' },
    });
    await h.prisma.scheduleDay.create({
      data: {
        employeeId: zoe,
        workDate: today,
        arrivedMin: 492,
        leftMin: 700,
        breakStartMin: 690,
        breakMin: 10,
        lateMin: 12,
        breaches: ['late'],
      },
    });
    // someone on a policy that checks nothing stays off the list
    const { id: _id, ...base } = await h.prisma.workPolicy.findFirstOrThrow();
    const free = await h.prisma.workPolicy.create({
      data: { ...base, name: 'Free', scheduleEnforced: false },
    });
    const { employeeId: other } = await createEmployeeWithCode(h.prisma, 'T-3');
    await h.prisma.employee.update({
      where: { id: other },
      data: { policyId: free.id },
    });

    const res = await owner.http.get('/api/v1/schedule/today').expect(200);
    expect(res.body.workDate).toBe(workTodayIso());
    expect(res.body.nowMin).toBeGreaterThanOrEqual(0);
    expect(res.body.nowMin).toBeLessThanOrEqual(1440);
    expect(
      res.body.people.map((p: { fullName: string }) => p.fullName),
    ).toEqual(['Ann Norow', 'Zoe Row']);
    expect(res.body.people[1]).toEqual({
      employeeId: zoe,
      fullName: 'Zoe Row',
      startMin: 480,
      endMin: 1020,
      requiredBreakMin: 60,
      breakFromMin: 660,
      breakToMin: 840,
      toleranceMarkMin: 5,
      checkedToday: true,
      arrivedMin: 492,
      leftMin: 700,
      breakStartMin: 690,
      breakMin: 10,
      lateMin: 12,
      earlyLeaveMin: 0,
      breaches: ['late'],
      final: false,
    });
    // no row yet: empty day fields
    expect(res.body.people[0]).toMatchObject({
      employeeId: ann,
      arrivedMin: null,
      leftMin: null,
      breakStartMin: null,
      breakMin: 0,
      breaches: [],
      final: false,
    });
  });

  it('nothing enforced: an empty list', async () => {
    await createEmployeeWithCode(h.prisma);
    const res = await owner.http.get('/api/v1/schedule/today').expect(200);
    expect(res.body.people).toEqual([]);
  });

  it('a day off, a holiday, leave or a day outside employment is not checked', async () => {
    await enforce(true);
    const schedule = h.app.get(ScheduleService);
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    const at = (iso: string) => new Date(`${iso}T06:00:00.000Z`); // 12:00 local

    // 2026-10-05 is a Monday: a workday
    const monday = await schedule.today(at('2026-10-05'));
    expect(monday).toMatchObject({ workDate: '2026-10-05', nowMin: 720 });
    expect(monday.people[0].checkedToday).toBe(true);
    // Friday is the policy's weekly day off
    expect(
      (await schedule.today(at('2026-10-09'))).people[0].checkedToday,
    ).toBe(false);

    await h.prisma.leave.create({
      data: { employeeId, leaveDate: workDate, createdBy: OWNER_EMAIL },
    });
    expect(
      (await schedule.today(at('2026-10-05'))).people[0].checkedToday,
    ).toBe(false);

    await h.prisma.holiday.create({
      data: { holidayDate: new Date('2026-10-06T00:00:00Z'), name: 'Holiday' },
    });
    expect(
      (await schedule.today(at('2026-10-06'))).people[0].checkedToday,
    ).toBe(false);

    // before the first day (joined 2026-01-05)
    expect(
      (await schedule.today(at('2025-12-01'))).people[0].checkedToday,
    ).toBe(false);
  });

  it('a stored row makes the day a checked one', async () => {
    await enforce(true);
    const { employeeId } = await createEmployeeWithCode(h.prisma);
    const friday = new Date('2026-10-09T00:00:00.000Z');
    await h.prisma.scheduleDay.create({
      data: { employeeId, workDate: friday, arrivedMin: 470 },
    });
    const view = await h.app
      .get(ScheduleService)
      .today(new Date('2026-10-09T06:00:00.000Z'));
    expect(view.people[0]).toMatchObject({
      checkedToday: true,
      arrivedMin: 470,
    });
  });

  it('a manager may read it; employee, coordinator and finance get a 403', async () => {
    const manager = await loginReady(h, MANAGER_EMAIL, MANAGER_PASSWORD);
    await manager.http.get('/api/v1/schedule/today').expect(200);
    for (const role of ['employee', 'coordinator', 'finance'] as const) {
      const session = await staff(role);
      await session.http.get('/api/v1/schedule/today').expect(403);
    }
  });
});
