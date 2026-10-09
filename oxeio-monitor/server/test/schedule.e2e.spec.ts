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
