import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ReportsService } from '../src/reports/reports.service';
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
