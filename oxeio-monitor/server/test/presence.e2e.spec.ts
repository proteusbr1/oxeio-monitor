import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ProgressService } from '../src/agent/progress.service';
import { DashboardLiveService } from '../src/dashboard/dashboard.live.service';
import { ReportsService } from '../src/reports/reports.service';
import { MeService } from '../src/me/me.service';
import { SummaryService } from '../src/summary/summary.service';
import {
  createEmployeeWithCode,
  createHarness,
  enrollDevice,
  OWNER_EMAIL,
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

/** Active stretches for one person on one day, on their enrolled device */
async function addStretches(
  employeeId: number,
  workDate: Date,
  stretches: [string, string][],
) {
  const device = await h.prisma.device.findFirstOrThrow({
    where: { employeeId },
  });
  const session = await h.prisma.workSession.create({
    data: {
      employeeId,
      deviceId: device.id,
      workDate,
      startedAt: new Date(stretches[0][0]),
    },
  });
  for (const [from, to] of stretches) {
    const startedAt = new Date(from);
    const endedAt = new Date(to);
    await h.prisma.activitySegment.create({
      data: {
        sessionId: session.id,
        employeeId,
        deviceId: device.id,
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
}

const staffActor = (employeeId: number) => ({
  userId: 0,
  email: '',
  role: 'employee' as const,
  employeeId,
  mustChangePw: false,
  issuedAt: 0,
});

/** 6 October (the day after the stored day): 1h, a 10-minute pause, 30 min */
const TODAY = new Date('2026-10-06T00:00:00.000Z');
const NOW = new Date('2026-10-06T06:00:00Z');
const TODAY_STRETCHES: [string, string][] = [
  ['2026-10-06T02:00:00Z', '2026-10-06T03:00:00Z'],
  ['2026-10-06T03:10:00Z', '2026-10-06T03:40:00Z'],
];

async function personWithDay(measure: 'active' | 'presence') {
  const policy = await h.prisma.workPolicy.findFirstOrThrow();
  await h.prisma.workPolicy.update({
    where: { id: policy.id },
    data: { hoursMeasure: measure, presenceGapMin: 15 },
  });
  const { employeeId, code } = await createEmployeeWithCode(h.prisma);
  const { deviceId } = await enrollDevice(h, code);
  const workDate = new Date('2026-10-05T00:00:00.000Z');
  const session = await h.prisma.workSession.create({
    data: {
      employeeId,
      deviceId,
      workDate,
      startedAt: new Date('2026-10-05T02:00:00Z'),
    },
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
  await h.app
    .get(SummaryService)
    .refreshDate(workDate, new Date('2026-10-05T12:00:00Z'));
  return h.prisma.dailySummary.findUniqueOrThrow({
    where: { employeeId_workDate: { employeeId, workDate } },
  });
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

describe('the month roll-up counts by the policy measure', () => {
  const monthOf = (employeeId: number) =>
    h.prisma.monthlySummary.findUniqueOrThrow({
      where: { employeeId_yearMonth: { employeeId, yearMonth: '2026-10' } },
    });

  it('presence policy: the month credits presence, and keeps counting the day', async () => {
    const day = await personWithDay('presence');
    const month = await monthOf(day.employeeId);
    expect(month.creditedSec).toBe(11400);
    expect(month.workedSec).toBe(11400);
    expect(month.daysWithWork).toBe(1);
  });

  it('active policy: the month credits active time', async () => {
    const day = await personWithDay('active');
    const month = await monthOf(day.employeeId);
    expect(month.creditedSec).toBe(10800);
    expect(month.workedSec).toBe(10800);
  });

  it('an adjustment is added on top of the measured time, once', async () => {
    const day = await personWithDay('presence');
    await h.prisma.timeAdjustment.create({
      data: {
        employeeId: day.employeeId,
        workDate: day.workDate,
        deltaSec: 600,
        cause: 'agent_down',
        reason: 'test',
        createdById: (
          await h.prisma.user.findFirstOrThrow({
            where: { email: OWNER_EMAIL },
          })
        ).id,
      },
    });
    await h.app
      .get(SummaryService)
      .refreshDate(day.workDate, new Date('2026-10-05T12:00:00Z'));
    const month = await monthOf(day.employeeId);
    expect(month.adjustmentSec).toBe(600);
    expect(month.creditedSec).toBe(11400 + 600);
  });

  it('the tray counts finished days by the measure too', async () => {
    const day = await personWithDay('presence');
    const progress = await h.app
      .get(ProgressService)
      .forEmployee(day.employeeId, new Date('2026-10-06T06:00:00Z'));
    expect(progress.monthCreditedSec).toBe(11400);
    // the agent's wire field stays active time
    expect(progress.monthActiveSec).toBe(10800);
  });
});

describe('My data credits by the measure', () => {
  it('presence policy: the day row credits presence, worked stays active', async () => {
    const day = await personWithDay('presence');
    const [row] = await h.app.get(MeService).days(
      {
        userId: 0,
        email: '',
        role: 'employee',
        employeeId: day.employeeId,
        mustChangePw: false,
        issuedAt: 0,
      },
      '2026-10-05',
      '2026-10-05',
      new Date('2026-10-06T06:00:00Z'),
    );
    expect(row.workedSec).toBe(10800);
    expect(row.creditedSec).toBe(11400);
  });
});

describe('attendance shows presence beside active time', () => {
  it('both columns are filled', async () => {
    await personWithDay('presence');
    const report = await h.app
      .get(ReportsService)
      .attendance({ from: '2026-10-05', to: '2026-10-05' });
    const row = report.rows.find((r) => r.status === 'worked');
    expect(row?.workedHours).toBe(3);
    expect(row?.presenceHours).toBeCloseTo(3.17, 2);
  });
});

describe('the Live Board counts by the measure', () => {
  it('presence policy: today and the month follow presence', async () => {
    const day = await personWithDay('presence');
    await addStretches(day.employeeId, TODAY, TODAY_STRETCHES);
    const board = await h.app.get(DashboardLiveService).live(NOW);
    const card = board.cards.find((c) => c.employeeId === day.employeeId);
    // today: 08:00–09:40 joined across the 10-minute pause
    expect(card?.todayWorkedSec).toBe(6000);
    // the stored day's presence (11400) plus today's
    expect(card?.monthWorkedSec).toBe(11400 + 6000);
  });

  it('active policy: the same numbers as before (active time)', async () => {
    const day = await personWithDay('active');
    await addStretches(day.employeeId, TODAY, TODAY_STRETCHES);
    const board = await h.app.get(DashboardLiveService).live(NOW);
    const card = board.cards.find((c) => c.employeeId === day.employeeId);
    expect(card?.todayWorkedSec).toBe(5400);
    expect(card?.monthWorkedSec).toBe(10800 + 5400);
  });
});

describe('My data keeps past days as stored', () => {
  it('a measure change without a recount leaves past days alone; today is live', async () => {
    const day = await personWithDay('presence');
    await addStretches(day.employeeId, TODAY, TODAY_STRETCHES);
    await h.prisma.workPolicy.updateMany({ data: { hoursMeasure: 'active' } });
    const [today, past] = await h.app
      .get(MeService)
      .days(staffActor(day.employeeId), '2026-10-05', '2026-10-06', NOW);
    // the stored row: presence was credited when it was counted
    expect(past.workDate).toBe('2026-10-05');
    expect(past.workedSec).toBe(10800);
    expect(past.creditedSec).toBe(11400);
    // today follows the current policy (now active time)
    expect(today.workedSec).toBe(5400);
    expect(today.creditedSec).toBe(5400);
  });

  it('presence today is counted live', async () => {
    const day = await personWithDay('presence');
    await addStretches(day.employeeId, TODAY, TODAY_STRETCHES);
    const [today] = await h.app
      .get(MeService)
      .days(staffActor(day.employeeId), '2026-10-06', '2026-10-06', NOW);
    expect(today.workedSec).toBe(5400);
    expect(today.creditedSec).toBe(6000);
  });

  it('the summary names the measure and the gap', async () => {
    const day = await personWithDay('presence');
    const summary = await h.app
      .get(MeService)
      .summary(staffActor(day.employeeId), NOW);
    expect(summary.hoursMeasure).toBe('presence');
    expect(summary.presenceGapMin).toBe(15);
  });
});
