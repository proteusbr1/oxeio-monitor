import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import { SyntheticInputCheck } from '../src/alerts/synthetic-input.check';
import {
  createHarness,
  resetDatabase,
  uniqueSuffix,
  type Harness,
  workNoon,
  realNow,
} from './setup/harness';

/**
 * **G46** — whether the `synthetic_input` alert really fires.
 *
 * The unit test (`synthetic-input.spec.ts`) guards **the rule**; this file
 * guards **the producer**. This is exactly where this project has repeatedly
 * had a gap — in G32 the type, label and filter all existed, only nobody
 * **raised the alert**. Writing a rule and the rule actually running are not the same.
 */
let h: Harness;
let check: SyntheticInputCheck;
let employeeId: number;
let deviceId: number;

/**
 * **Two different "now"s, and that is deliberate (G140).**
 *
 * - `workDate` comes from `workNoon()` — the fixture's working day, 12 hours
 *   from both boundaries, so it does not break when the day rolls over at midnight.
 * - `runOnce()` gets the **real clock**, because the throttle is compared with
 *   the alert's `created_at` — which comes from the **database's** `now()`.
 *
 * Once the two were merged and noon was passed in, and the test caught it at once:
 * run early in the morning, the gap between noon and the DB's `created_at` exceeded
 * the 6-hour `THROTTLE_HOURS`, so the claim "a second run raises nothing more"
 * broke. If the app clock and the database clock differ, a pinned moment cannot
 * be used — that is the only valid reason for `realNow()`.
 */
const workDate = workDateOf(workNoon());

/** A moment inside that working day (on the work-zone clock) */
const at = (hour: number, minute = 0): Date =>
  new Date(workDate.getTime() + (hour - 6) * 3_600_000 + minute * 60_000);

async function makeDevice(hostname: string): Promise<number> {
  const device = await h.prisma.device.create({
    data: {
      hostname,
      windowsUsername: 'rakib',
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
    },
  });
  return device.id;
}

/** 5-minute ACTIVE spans, filled in from `from` to `to` */
async function activeRun(
  from: Date,
  to: Date,
  score: number | null,
  device = deviceId,
): Promise<void> {
  const session = await h.prisma.workSession.create({
    data: { employeeId, deviceId: device, workDate, startedAt: from, endedAt: to },
  });

  for (let t = from.getTime(); t < to.getTime(); t += 5 * 60_000) {
    const segFrom = new Date(t);
    const segTo = new Date(Math.min(t + 5 * 60_000, to.getTime()));

    await h.prisma.activitySegment.create({
      data: {
        sessionId: session.id,
        employeeId,
        deviceId: device,
        clientUuid: randomUUID(),
        workDate,
        state: 'active',
        startedAt: segFrom,
        endedAt: segTo,
        durationSec: Math.round((segTo.getTime() - segFrom.getTime()) / 1000),
        inputScore: score,
        countsAsWork: true,
      },
    });
  }
}

async function window(
  from: Date,
  to: Date,
  processName: string,
  title: string,
  device = deviceId,
): Promise<void> {
  await h.prisma.appUsage.create({
    data: {
      employeeId,
      deviceId: device,
      clientUuid: randomUUID(),
      workDate,
      startedAt: from,
      endedAt: to,
      durationSec: Math.round((to.getTime() - from.getTime()) / 1000),
      processName,
      windowTitle: title,
    },
  });
}

const alerts = () => h.prisma.alert.findMany({ where: { type: 'synthetic_input' } });

beforeAll(async () => {
  h = await createHarness();
  check = h.app.get(SyntheticInputCheck);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);

  const employee = await h.prisma.employee.create({
    data: { empCode: `SI-${uniqueSuffix()}`, fullName: 'Belal Hossain' },
  });
  employeeId = employee.id;
  deviceId = await makeDevice('PC-SI');
});

describe('G46 — catching fake input', () => {
  /**
   * **An exact copy of the script the owner sent:** `SendKeys("{F15}")` every
   * minute, PowerShell open, no break.
   */
  it('three hours unbroken, one window — the alert fires', async () => {
    await activeRun(at(10), at(13), 98);
    await window(at(10), at(13), 'powershell.exe', 'Windows PowerShell');

    expect(await check.runOnce(realNow())).toBe(1);

    const [row] = await alerts();
    expect(row.employeeId).toBe(employeeId);
    expect(row.deviceId).toBe(deviceId);
    expect(row.severity).toBe('warning');
    expect(row.title).toContain('Belal Hossain');
  });

  /** `meta` holds the information needed to verify the incident */
  it('meta says from when to when, and within which limits', async () => {
    await activeRun(at(9), at(12), 100);
    await window(at(9), at(12), 'powershell.exe', 'Windows PowerShell');

    await check.runOnce(realNow());

    const [row] = await alerts();
    expect(row.meta).toMatchObject({
      durationSec: 3 * 3600,
      windows: 1,
      scoreSpread: 0,
      minStretchSec: 60 * 60,
    });
  });

  /**
   * **People stop.** A single break splits the stretch — and this test is
   * exactly what decides whether an innocent person falls under suspicion.
   */
  it('no alert when there is a break in the middle', async () => {
    // Both pieces are below the limit (1 hour) — one break is enough
    await activeRun(at(10), at(10, 50), 98);
    await activeRun(at(11, 10), at(12), 98);
    await window(at(10), at(12), 'powershell.exe', 'Windows PowerShell');

    expect(await check.runOnce(realNow())).toBe(0);
    expect(await alerts()).toHaveLength(0);
  });

  it('no alert when the window changes', async () => {
    await activeRun(at(10), at(13), 98);
    await window(at(10), at(11, 30), 'chrome.exe', 'Inbox');
    await window(at(11, 30), at(13), 'chrome.exe', 'Docs');

    expect(await check.runOnce(realNow())).toBe(0);
  });

  it('no alert when the hand is uneven', async () => {
    // Each span needs its own score, so two rounds of one hour each
    await activeRun(at(10), at(11), 62);
    await activeRun(at(11), at(13), 97);
    await window(at(10), at(13), 'illustrator.exe', 'poster.ai');

    expect(await check.runOnce(realNow())).toBe(0);
  });

  /**
   * **Two devices are looked at separately.** Otherwise one person's spans on
   * two PCs would merge into one long "unbroken" stretch, and an honest employee
   * working on two machines would fall under suspicion (a direct clash with G32).
   */
  it('the times of two devices are not merged', async () => {
    const second = await makeDevice('PC-SI-2');

    // Separately both are below the limit; merged they would exceed 1 hour
    await activeRun(at(10), at(10, 50), 98);
    await window(at(10), at(10, 50), 'powershell.exe', 'Windows PowerShell');
    await activeRun(at(10, 50), at(11, 40), 98, second);
    await window(at(10, 50), at(11, 40), 'powershell.exe', 'Windows PowerShell', second);

    expect(await check.runOnce(realNow())).toBe(0);
  });

  /** Without `app_usage` there is no suspicion — not knowing is not proof */
  it('no alert when there is no foreground information', async () => {
    await activeRun(at(10), at(13), 98);

    expect(await check.runOnce(realNow())).toBe(0);
  });

  it('quietly zero when there is nothing at all', async () => {
    expect(await check.runOnce(realNow())).toBe(0);
  });

  /**
   * No repeated alerts for the same incident — throttle. Otherwise one alert
   * would arrive every hour, and within days nobody would read alerts any more.
   */
  it('running twice still gives just one alert', async () => {
    await activeRun(at(10), at(13), 98);
    await window(at(10), at(13), 'powershell.exe', 'Windows PowerShell');

    await check.runOnce(realNow());
    await check.runOnce(realNow());

    expect(await alerts()).toHaveLength(1);
  });
});
