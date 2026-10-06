import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import { FEATURES_SETTING_KEY } from '../src/features/features.rules';
import { FeaturesService } from '../src/features/features.service';
import { SummaryService } from '../src/summary/summary.service';
import { TASKS_SETTING_KEY } from '../src/tasks/tasks-settings.rules';
import {
  createEmployeeWithCode,
  createHarness,
  workNoon,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * Task start detection, end to end through the daily summary.
 *
 * Two things are guarded here.
 *
 * 1. **Detection is opt-in.** Window titles are read only for the apps the
 *    owner listed in Settings → Tasks, and only while Apps & websites is on.
 *    With no list (the default), an empty list, or Apps & websites off, the
 *    summary reads no title at all: `tasksStarted` is 0, nothing goes into
 *    `task_credits`, and no task gets a "started" mark.
 *
 * 2. **The "work started" mark is set at the real instant** (G163). The bug:
 *    the work-day label (UTC midnight, really 6 AM in the work zone) was put
 *    into the `now: Date` slot, so every task's `started_at` landed on that
 *    one instant, hours before it was even assigned. The number never had to
 *    be guessed: `app_usage.started_at` holds exactly the instant the number
 *    was first seen in a title.
 *
 * This file has no pinned dates (G140) — every fixture is relative to
 * "today", and hours within the day are placed with `atWorkHour()`.
 */
let h: Harness;
let summary: SummaryService;

const HOUR_MS = 3600_000;
/** The test zone is UTC+6 — subtract this to go from the label to the real instant */
const WORK_OFFSET_MS = 6 * HOUR_MS;

const NUM = 1_000_042;
const APP = 'Excel.exe';

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
 * The real instant of a given hour on that work day.
 *
 * `dayLabel` is a label — the work day written as UTC midnight. That day's
 * local midnight starts 6 hours before the label. Mixing up the two is what
 * caused G163.
 */
const atWorkHour = (dayLabel: Date, hour: number): Date =>
  new Date(dayLabel.getTime() - WORK_OFFSET_MS + hour * HOUR_MS);

async function putSetting(key: string, value: Prisma.InputJsonObject): Promise<void> {
  await h.prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

/** Settings → Tasks → start detection for these apps */
async function detectIn(apps: string[]): Promise<void> {
  await putSetting(TASKS_SETTING_KEY, { startDetection: { apps } });
}

/** Switches Apps & websites off (the row is written directly, so the cache is dropped) */
async function appTrackingOff(): Promise<void> {
  await putSetting(FEATURES_SETTING_KEY, { appTracking: false });
  h.app.get(FeaturesService).forget();
}

async function assigneeWithDevice(): Promise<{
  employeeId: number;
  deviceId: number;
}> {
  const { employeeId } = await createEmployeeWithCode(h.prisma, 'OX-TS1');

  await h.prisma.employee.update({
    where: { id: employeeId },
    data: { receivesTasks: true },
  });

  const device = await h.prisma.device.create({
    data: {
      hostname: 'PC-TS1',
      windowsUsername: 'ts1',
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
      status: 'active',
    },
  });

  return { employeeId, deviceId: device.id };
}

/** A task assigned to that person */
async function assignedTask(employeeId: number, assignedAt: Date): Promise<void> {
  const owner = await h.prisma.user.findFirstOrThrow();

  await h.prisma.task.create({
    data: {
      reference: 'REF-42',
      taskNumber: NUM,
      status: 'assigned',
      assignedToId: employeeId,
      assignedAt,
      addedById: owner.id,
    },
  });
}

/** An `app_usage` row with the number at the start of the title */
async function sawWindow(
  who: { employeeId: number; deviceId: number },
  workDate: Date,
  startedAt: Date,
  minutes = 30,
  processName = APP,
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
      processName,
      windowTitle: `${NUM} - Quarterly report.xlsx - Excel`,
    },
  });
}

const taskRow = () => h.prisma.task.findFirstOrThrow();

const startedCount = async (employeeId: number, workDate: Date): Promise<number> =>
  (
    await h.prisma.dailySummary.findUniqueOrThrow({
      where: { employeeId_workDate: { employeeId, workDate } },
    })
  ).tasksStarted;

/** One assigned task, its window seen at 11:00, and the day summarised */
async function scenario(processName = APP): Promise<{ employeeId: number; day: Date }> {
  const who = await assigneeWithDevice();
  const day = today();

  await assignedTask(who.employeeId, atWorkHour(day, 8));
  await sawWindow(who, day, atWorkHour(day, 11), 30, processName);

  await summary.refreshDate(day, workNoon());

  return { employeeId: who.employeeId, day };
}

/** Everything detection would have written is absent */
async function expectNothingDetected(employeeId: number, day: Date): Promise<void> {
  expect(await startedCount(employeeId, day)).toBe(0);
  expect(await h.prisma.taskCredit.count()).toBe(0);
  expect((await taskRow()).startedAt).toBeNull();
}

describe('start detection is off unless configured', () => {
  /** A new install: no `tasks` settings row at all */
  it('no Settings → Tasks row: no title is read, nothing is counted or marked', async () => {
    const { employeeId, day } = await scenario();

    await expectNothingDetected(employeeId, day);
  });

  it('an empty app list switches detection off', async () => {
    await detectIn([]);

    const { employeeId, day } = await scenario();

    await expectNothingDetected(employeeId, day);
  });

  /**
   * Window titles come from Apps & websites; with that module off detection
   * is inactive even though the app list is still there (it is kept for
   * when the module comes back).
   */
  it('Apps & websites off: inactive even with apps listed', async () => {
    await detectIn([APP]);
    await appTrackingOff();

    const { employeeId, day } = await scenario();

    await expectNothingDetected(employeeId, day);
  });
});

describe('start detection on', () => {
  it('a listed app: counted, credited and marked started', async () => {
    await detectIn([APP]);

    const { employeeId, day } = await scenario();

    expect(await startedCount(employeeId, day)).toBe(1);
    expect(await h.prisma.taskCredit.findMany()).toEqual([
      expect.objectContaining({ employeeId, taskNumber: String(NUM) }),
    ]);
    expect((await taskRow()).startedAt?.toISOString()).toBe(
      atWorkHour(day, 11).toISOString(),
    );
  });

  /** Windows reports process names in whatever case the file has */
  it('the process name matches case-insensitively', async () => {
    await detectIn(['excel.EXE']);

    const { employeeId, day } = await scenario('EXCEL.exe');

    expect(await startedCount(employeeId, day)).toBe(1);
    expect((await taskRow()).startedAt).not.toBeNull();
  });

  /**
   * An allowlist, not a blocklist: a title from an app that is not listed
   * (a browser tab, a chat window) never enters this calculation.
   */
  it('an app that is not listed is ignored', async () => {
    await detectIn(['WINWORD.EXE']);

    const { employeeId, day } = await scenario('chrome.exe');

    await expectNothingDetected(employeeId, day);
  });
});

describe('G163 — "work started" is set at the real instant', () => {
  beforeEach(async () => {
    await detectIn([APP]);
  });

  /**
   * The main test of this part.
   *
   * The old code set `day` (the label) here — i.e. 6 AM local time, although
   * the window was opened at 11 AM.
   */
  it('the instant the window was first in front is what gets set', async () => {
    const who = await assigneeWithDevice();
    const day = today();
    const openedAt = atWorkHour(day, 11);

    await assignedTask(who.employeeId, atWorkHour(day, 8));
    await sawWindow(who, day, openedAt);

    await summary.refreshDate(day, workNoon());

    const after = await taskRow();
    expect(after.startedAt?.toISOString()).toBe(openedAt.toISOString());
  });

  /**
   * The bug's own fingerprint: "started" is never before "assigned".
   *
   * Hand-out at 8 AM, mark set at 6 AM — this one claim catches the whole
   * class of mistake.
   */
  it('"started" is never before "assigned"', async () => {
    const who = await assigneeWithDevice();
    const day = today();
    const assignedAt = atWorkHour(day, 8);

    await assignedTask(who.employeeId, assignedAt);
    await sawWindow(who, day, atWorkHour(day, 9.5));

    await summary.refreshDate(day, workNoon());

    const after = await taskRow();
    expect(after.startedAt).not.toBeNull();
    expect(after.startedAt!.getTime()).toBeGreaterThanOrEqual(assignedAt.getTime());
  });

  /**
   * Not 6 AM local time — the bug's exact fingerprint. Written separately
   * because even if the two above hold, someone sending the label again one
   * day would bring that value back.
   */
  it('the work-day label (6 AM local time) is not what gets set', async () => {
    const who = await assigneeWithDevice();
    const day = today();

    await assignedTask(who.employeeId, atWorkHour(day, 8));
    await sawWindow(who, day, atWorkHour(day, 14));

    await summary.refreshDate(day, workNoon());

    const after = await taskRow();
    expect(after.startedAt?.getTime()).not.toBe(day.getTime());
  });

  /**
   * The same window is brought back many times a day — the mark is set at
   * the first instant, not the last.
   */
  it('in front many times in a day, it is the first instant', async () => {
    const who = await assigneeWithDevice();
    const day = today();
    const first = atWorkHour(day, 10);

    await assignedTask(who.employeeId, atWorkHour(day, 8));
    // Deliberately inserted in reverse order — "keep the last" would turn this red
    await sawWindow(who, day, atWorkHour(day, 16));
    await sawWindow(who, day, first);
    await sawWindow(who, day, atWorkHour(day, 13));

    await summary.refreshDate(day, workNoon());

    expect((await taskRow()).startedAt?.toISOString()).toBe(first.toISOString());
  });

  /**
   * Recalculating an old day still gives that day's number.
   *
   * This is the trap a simple fix (`now` instead of `workDate`) would miss:
   * `drainDirty()` runs yesterday's day with today's clock, so using `now`
   * would put today's time on a task from days ago — i.e.
   * `started_at > completed_at`, a new impossible row.
   */
  it("recalculating yesterday today still gives yesterday's time", async () => {
    const who = await assigneeWithDevice();
    const yesterday = new Date(today().getTime() - 24 * HOUR_MS);
    const openedAt = atWorkHour(yesterday, 15);

    await assignedTask(who.employeeId, atWorkHour(yesterday, 8));
    await sawWindow(who, yesterday, openedAt);

    // `now` is today's — exactly how `drainDirty()` calls it
    await summary.refreshDate(yesterday, workNoon());

    const after = await taskRow();
    expect(after.startedAt?.toISOString()).toBe(openedAt.toISOString());
    expect(workDateOf(after.startedAt!).getTime()).toBe(yesterday.getTime());
  });

  /** Once the mark is set it never moves — "when started" must not shift daily */
  it('recalculating again does not move the mark', async () => {
    const who = await assigneeWithDevice();
    const day = today();
    const openedAt = atWorkHour(day, 10);

    await assignedTask(who.employeeId, atWorkHour(day, 8));
    await sawWindow(who, day, openedAt);

    await summary.refreshDate(day, workNoon());
    await sawWindow(who, day, atWorkHour(day, 9));
    await summary.refreshDate(day, workNoon());

    expect((await taskRow()).startedAt?.toISOString()).toBe(openedAt.toISOString());
  });
});
