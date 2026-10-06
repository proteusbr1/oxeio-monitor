import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/dhaka-time';
import {
  createEmployeeWithCode,
  createHarness,
  dhakaNoon,
  loginReady,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  resetDatabase,
  type Harness,
  type Session,
} from './setup/harness';

/**
 * The newest screenshot per employee for today (G159).
 *
 * The bug this file guards: the board and the Worklog cards used to pull the
 * last one or two gallery pages (60-120 screenshots) and pick each employee's
 * newest from inside them. Someone whose last screenshot fell outside that
 * window (they left early, or the team is large) got the text
 * *"No screenshot yet today"* on their card.
 *
 * Field numbers: on the evening of 25 August OX-05 had 114 screenshots, yet
 * the card said there were none. The screen told a lie and no error was raised.
 *
 * Guessing by scanning pages was the wrong path; the question needs its own answer.
 */
let h: Harness;
let owner: Session;

const MINUTE = 60_000;

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

/** An employee plus their device */
async function staffWithDevice(empCode: string): Promise<{
  employeeId: number;
  deviceId: number;
}> {
  const { employeeId } = await createEmployeeWithCode(h.prisma, empCode);
  const device = await h.prisma.device.create({
    data: {
      hostname: `PC-${empCode}`,
      windowsUsername: 'u',
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
      status: 'active',
    },
  });
  return { employeeId, deviceId: device.id };
}

/** A screenshot from `minutesAgo` minutes before noon today */
async function shot(
  who: { employeeId: number; deviceId: number },
  minutesAgo: number,
  monitorIndex = 0,
): Promise<void> {
  const when = new Date(dhakaNoon().getTime() - minutesAgo * MINUTE);
  const uuid = randomUUID();

  await h.prisma.screenshot.create({
    data: {
      employeeId: who.employeeId,
      deviceId: who.deviceId,
      clientUuid: uuid,
      workDate: workDateOf(when),
      slotStart: when,
      capturedAt: when,
      monitorIndex,
      filePath: `x/${uuid}.webp`,
      thumbPath: `x/${uuid}.thumb.webp`,
    },
  });
}

const latest = async () =>
  (await owner.http.get('/api/v1/screenshots/latest').expect(200)).body as {
    date: string;
    items: { employeeId: number; capturedAt: string; monitorIndex: number }[];
  };

describe('the newest screenshot per employee for today', () => {
  /**
   * The core test of this file: an employee whose screenshots are long ago is
   * not dropped either.
   *
   * The old rule picked from a page of 60, so here one employee has 70
   * screenshots: those would fill the last page and the second employee's
   * much older screenshot would fall on no page.
   */
  it('an employee who worked early in the day is not dropped', async () => {
    const busy = await staffWithDevice('OX-B1');
    const early = await staffWithDevice('OX-E1');

    // the busy employee's 70 recent screenshots
    for (let i = 0; i < 70; i += 1) await shot(busy, i);
    // the other one has just one, from long ago
    await shot(early, 300);

    const res = await latest();
    const ids = res.items.map((i) => i.employeeId);

    expect(ids).toContain(early.employeeId);
    expect(ids).toContain(busy.employeeId);
    expect(res.items).toHaveLength(2);
  });

  /** Exactly one row per employee, otherwise it is unclear which goes on the card */
  it('one row per employee, and it is the newest one', async () => {
    const who = await staffWithDevice('OX-N1');
    await shot(who, 100);
    await shot(who, 5);
    await shot(who, 50);

    const res = await latest();

    expect(res.items).toHaveLength(1);
    const expected = new Date(dhakaNoon().getTime() - 5 * MINUTE).toISOString();
    expect(res.items[0].capturedAt).toBe(expected);
  });

  /**
   * Two screenshots from two monitors at the same moment: the newest
   * `capturedAt` then matches two rows, yet the card needs just one.
   */
  it('even for two monitors at the same moment, one row', async () => {
    const who = await staffWithDevice('OX-M2');
    await shot(who, 5, 0);
    await shot(who, 5, 1);

    const res = await latest();

    expect(res.items).toHaveLength(1);
  });

  /** Screenshots marked for deletion are not counted: the same rule as the gallery */
  it('deleted screenshots are excluded', async () => {
    const who = await staffWithDevice('OX-D2');
    await shot(who, 5);
    await h.prisma.screenshot.updateMany({
      data: { deletedAt: dhakaNoon() },
    });

    expect((await latest()).items).toHaveLength(0);
  });

  it('an empty list when there are no screenshots', async () => {
    await staffWithDevice('OX-Z1');

    const res = await latest();

    expect(res.items).toEqual([]);
    expect(res.date).not.toBe('');
  });

  /**
   * The audit is still a single row as before, not one per employee:
   * otherwise opening the board would write 12 rows and fill the *"who looked
   * at my screenshots"* ledger (I08) with junk, and the real events could no
   * longer be found.
   */
  it('writes a single row to the audit', async () => {
    const a = await staffWithDevice('OX-A9');
    const b = await staffWithDevice('OX-B9');
    await shot(a, 5);
    await shot(b, 6);

    await latest();

    const rows = await h.prisma.auditLog.count({
      where: { action: 'view_screenshot' },
    });
    expect(rows).toBe(1);
  });
});
