import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import { SummaryService } from '../src/summary/summary.service';
import {
  createEmployeeWithCode,
  createHarness,
  workNoon,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * The "work started" mark is set at the real instant (6 September 2026, G163).
 *
 * The bug this file guards: when `claimDesigns()` set "work started" on a
 * target it called `markStartedByJobNumbers(..., workDate)`, which put the
 * work-day label into the `now: Date` slot. The label is UTC midnight, which
 * is really 6 AM Dhaka time. So every target's `started_at` landed on that
 * single instant.
 *
 * Field numbers: in all 711 of the 711 rows with `started_at`, the clock was
 * exactly `06:00:00` — one single distinct time in total. And every one was
 * before its own `assigned_at`, because distribution runs at 8 AM. The screen
 * showed "Started 5 hours ago" the very second the job was opened.
 *
 * The number never had to be guessed: `app_usage.started_at` holds exactly
 * the instant the number was first seen in a title.
 *
 * This file has no pinned dates (G140) — every fixture is relative to
 * "today", and hours within the day are placed with `atDhakaHour()`.
 */
let h: Harness;
let summary: SummaryService;

const HOUR_MS = 3600_000;
/** Dhaka is UTC+6 — subtract this to go from the label to the real instant */
const WORK_OFFSET_MS = 6 * HOUR_MS;

const JOB = 1_000_042;

beforeAll(async () => {
  h = await createHarness();
  summary = h.app.get(SummaryService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

const today = () => workDateOf(workNoon());

/**
 * The real instant of a given hour on that Dhaka day.
 *
 * `dayLabel` is a label — the Dhaka day written as UTC midnight. That day's
 * Dhaka midnight starts 6 hours before the label. Mixing up the two is what
 * caused G163.
 */
const atWorkHour = (dayLabel: Date, hour: number): Date =>
  new Date(dayLabel.getTime() - WORK_OFFSET_MS + hour * HOUR_MS);

async function designerWithDevice(): Promise<{
  employeeId: number;
  deviceId: number;
}> {
  const { employeeId } = await createEmployeeWithCode(h.prisma, 'OX-DS1');

  await h.prisma.employee.update({
    where: { id: employeeId },
    data: { staffType: 'designer' },
  });

  const device = await h.prisma.device.create({
    data: {
      hostname: 'PC-DS1',
      windowsUsername: 'ds1',
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
      status: 'active',
    },
  });

  return { employeeId, deviceId: device.id };
}

/** A target assigned to that designer */
async function assignedTarget(employeeId: number, assignedAt: Date): Promise<void> {
  const owner = await h.prisma.user.findFirstOrThrow();

  await h.prisma.designTarget.create({
    data: {
      asin: 'B000000042',
      jobNumber: JOB,
      status: 'assigned',
      assignedToId: employeeId,
      assignedAt,
      addedById: owner.id,
    },
  });
}

/** An `app_usage` row with the number in the title */
async function sawFile(
  who: { employeeId: number; deviceId: number },
  workDate: Date,
  startedAt: Date,
  minutes = 30,
): Promise<void> {
  await h.prisma.appUsage.create({
    data: {
      employeeId: who.employeeId,
      deviceId: who.deviceId,
      clientUuid: randomUUID(),
      workDate,
      startedAt,
      endedAt: new Date(startedAt.getTime() + minutes * 60_000),
      durationSec: minutes * 60,
      processName: 'Illustrator.exe',
      windowTitle: `${JOB}-Funny Cat T-Shirt.ai @ 54 %`,
    },
  });
}

const targetRow = () => h.prisma.designTarget.findFirstOrThrow();

describe('G163 — "work started" is set at the real instant', () => {
  /**
   * The main test of this file.
   *
   * The old code set `day` (the label) here — i.e. 6 AM Dhaka time, although
   * the file was opened at 11 AM.
   */
  it('the instant the file was first opened is what gets set', async () => {
    const who = await designerWithDevice();
    const day = today();
    const openedAt = atWorkHour(day, 11);

    await assignedTarget(who.employeeId, atWorkHour(day, 8));
    await sawFile(who, day, openedAt);

    await summary.refreshDate(day, workNoon());

    const after = await targetRow();
    expect(after.startedAt?.toISOString()).toBe(openedAt.toISOString());
  });

  /**
   * The bug's own fingerprint: "started" is never before "assigned".
   *
   * In the field all 711 of 711 broke this rule: distribution at 8 AM, mark
   * set at 6 AM. This one claim catches the whole class of mistake.
   */
  it('"started" is never before "assigned"', async () => {
    const who = await designerWithDevice();
    const day = today();
    const assignedAt = atWorkHour(day, 8);

    await assignedTarget(who.employeeId, assignedAt);
    await sawFile(who, day, atWorkHour(day, 9.5));

    await summary.refreshDate(day, workNoon());

    const after = await targetRow();
    expect(after.startedAt).not.toBeNull();
    expect(after.startedAt!.getTime()).toBeGreaterThanOrEqual(assignedAt.getTime());
  });

  /**
   * Not 6 AM Dhaka time — the bug's exact fingerprint. Written separately
   * because even if the two above hold, someone sending the label again one
   * day would bring that value back.
   */
  it('the work-day label (6 AM Dhaka time) is not what gets set', async () => {
    const who = await designerWithDevice();
    const day = today();

    await assignedTarget(who.employeeId, atWorkHour(day, 8));
    await sawFile(who, day, atWorkHour(day, 14));

    await summary.refreshDate(day, workNoon());

    const after = await targetRow();
    expect(after.startedAt?.getTime()).not.toBe(day.getTime());
  });

  /**
   * The same file is returned to many times a day — the mark is set at the
   * first instant, not the last.
   */
  it('opened many times in a day, it is the first instant', async () => {
    const who = await designerWithDevice();
    const day = today();
    const first = atWorkHour(day, 10);

    await assignedTarget(who.employeeId, atWorkHour(day, 8));
    // Deliberately inserted in reverse order — "keep the last" would turn this red
    await sawFile(who, day, atWorkHour(day, 16));
    await sawFile(who, day, first);
    await sawFile(who, day, atWorkHour(day, 13));

    await summary.refreshDate(day, workNoon());

    expect((await targetRow()).startedAt?.toISOString()).toBe(first.toISOString());
  });

  /**
   * Recalculating an old day still gives that day's number.
   *
   * This is the trap a simple fix (`now` instead of `workDate`) would miss:
   * `drainDirty()` runs yesterday's day with today's clock, so using `now`
   * would put the 6th's time on a design from the 2nd — i.e.
   * `started_at > completed_at`, a new impossible row.
   */
  it('recalculating yesterday today still gives yesterday\'s time', async () => {
    const who = await designerWithDevice();
    const yesterday = new Date(today().getTime() - 24 * HOUR_MS);
    const openedAt = atWorkHour(yesterday, 15);

    await assignedTarget(who.employeeId, atWorkHour(yesterday, 8));
    await sawFile(who, yesterday, openedAt);

    // `now` is today's — exactly how `drainDirty()` calls it
    await summary.refreshDate(yesterday, workNoon());

    const after = await targetRow();
    expect(after.startedAt?.toISOString()).toBe(openedAt.toISOString());
    expect(workDateOf(after.startedAt!).getTime()).toBe(yesterday.getTime());
  });

  /** Once the mark is set it never moves — "when started" must not shift daily */
  it('recalculating again does not move the mark', async () => {
    const who = await designerWithDevice();
    const day = today();
    const openedAt = atWorkHour(day, 10);

    await assignedTarget(who.employeeId, atWorkHour(day, 8));
    await sawFile(who, day, openedAt);

    await summary.refreshDate(day, workNoon());
    await sawFile(who, day, atWorkHour(day, 9));
    await summary.refreshDate(day, workNoon());

    expect((await targetRow()).startedAt?.toISOString()).toBe(openedAt.toISOString());
  });
});
