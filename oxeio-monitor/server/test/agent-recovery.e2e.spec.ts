import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { workDateOf } from '../src/agent/util/work-time';
import { AgentDownCheck } from '../src/alerts/agent-down.check';
import { AlertsService } from '../src/alerts/alerts.service';
import {
  createHarness,
  resetDatabase,
  type Harness,
} from './setup/harness';

/**
 * #1: agent_down closes itself when the agent comes back (auto-close).
 *
 * From the owner's complaint: waking up to 11 "Agent down" warnings, all
 * stale alerts from PCs that were switched off at night and started again
 * (the goodbye event never reached the server, G136).
 *
 * This file guards: when the agent starts sending data again, its open
 * agent_down gets `resolvedAt` and `openCount` drops, but the row is not
 * deleted. It stays in "Show all", and it stays clear that no human
 * acknowledged it (`acknowledgedAt` intact).
 */
let h: Harness;
let check: AgentDownCheck;
let alerts: AlertsService;
let employeeId: number;

/** A device with status 'active' and a fixed lastSeenAt; no clean-stop event */
async function seedDevice(
  lastSeenAt: Date,
  hostname = 'PC-SILENT',
): Promise<number> {
  const d = await h.prisma.device.create({
    data: {
      hostname,
      windowsUsername: 'rakib',
      employeeId,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
      status: 'active',
      lastSeenAt,
    },
  });
  return d.id;
}

/**
 * A fixed clock: the most important line in this file.
 *
 * This used to be `new Date()`, i.e. the real time when CI ran. But
 * `AgentDownCheck.runOnce()` raises alerts only during office hours
 * (`isAgentWatchOpen`: 9:00 plus a 15-minute grace). So CI was green by day
 * and red at night; on 4 September at 23:19 exactly that happened, five tests
 * at once.
 *
 * The failure was in the test, not the code: suppressing the alert is the
 * correct behaviour (it was added after six false alerts on 23 August). So
 * instead of loosening the rule, the test is pinned to a known moment.
 *
 * Wednesday was chosen on purpose: Friday is the weekly holiday, when
 * `isOfficeOpen()` would say closed anyway and the test would depend on time
 * again.
 */
const NOW = new Date('2026-09-02T05:00:00.000Z'); // Wednesday, 11:00 in Dhaka

/** Relative to `NOW`; note `harness`'s `minutesAgo` uses the real clock, so not that */
const before = (minutes: number): Date =>
  new Date(NOW.getTime() - minutes * 60_000);

const agentDownRows = () =>
  h.prisma.alert.findMany({ where: { type: 'agent_down' } });

beforeAll(async () => {
  h = await createHarness();
  // The scheduler is off under NODE_ENV=test (alerts.scheduler.ts); we call
  // runOnce/resolveReturned by hand, or a tick would move fixtures mid-test.
  check = h.app.get(AgentDownCheck);
  alerts = h.app.get(AlertsService);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
  const policy = await h.prisma.workPolicy.findFirstOrThrow();
  const emp = await h.prisma.employee.create({
    data: { empCode: 'OX-DOWN', fullName: 'Rakib Hasan', policyId: policy.id },
  });
  employeeId = emp.id;
});

/**
 * No alert when a PC of someone on leave is silent (G157).
 *
 * The gap this describe guards: the leave register arrived in R2/G130 (5
 * September), but no alert test ever read the `leaves` table. So even on a
 * leave day the owner himself approved, the "agent silent" alert went out,
 * i.e. the system complained about something it knew about itself.
 *
 * Measured in the field: on just 3 leave days, 11 false alerts (8
 * `agent_down` plus 3 `no_activity_today`).
 */
describe('G157: no agent_down on a leave day', () => {
  /** The main test of this describe */
  it('no alert even for a silent PC when on leave', async () => {
    await seedDevice(before(30));
    await h.prisma.leave.create({
      data: { employeeId, leaveDate: workDateOf(NOW), createdBy: 'test' },
    });

    expect(await check.runOnce(NOW)).toBe(0);
  });

  /**
   * The second test is the real guard: on its own, the first would stay
   * green even if the check always returned 0.
   */
  it('without leave the alert is raised as before', async () => {
    await seedDevice(before(30));

    expect(await check.runOnce(NOW)).toBe(1);
  });

  /**
   * Someone else's leave does not switch off this PC's watch: leave is one
   * person's matter, not the office's. Mixing them would let one person's
   * leave turn off the whole team's watch.
   */
  it('another employee\'s leave leaves the watch intact', async () => {
    const other = await h.prisma.employee.create({
      data: { empCode: 'OX-LV2', fullName: 'Onno Karmi' },
    });
    await seedDevice(before(30));
    await h.prisma.leave.create({
      data: { employeeId: other.id, leaveDate: workDateOf(NOW), createdBy: 'test' },
    });

    expect(await check.runOnce(NOW)).toBe(1);
  });
});

describe('agent_down: closes itself on return', () => {
  /** The main claim: silent, an alert is raised; on return it is resolved. */
  it('a silent device raises an alert, and returning resolves it', async () => {
    const now = NOW;
    const deviceId = await seedDevice(before(30));

    expect(await check.runOnce(now)).toBe(1);
    const [raised] = await agentDownRows();
    expect(raised.resolvedAt).toBeNull();
    expect((await alerts.list({})).openCount).toBe(1);

    // The agent checked in again (lastSeenAt is recent)
    await h.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: before(1) },
    });

    expect(await check.resolveReturned(now)).toBe(1);

    const [after] = await agentDownRows();
    expect(after.resolvedAt).not.toBeNull();
    expect(after.resolvedReason).toBe('agent returned');
    // Nobody has seen it: acknowledgedAt is intact, the two are separate events
    expect(after.acknowledgedAt).toBeNull();
  });

  it('on resolve openCount drops, but it stays in history under "Show all"', async () => {
    const now = NOW;
    const deviceId = await seedDevice(before(30));
    await check.runOnce(now);

    await h.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: before(1) },
    });
    await check.resolveReturned(now);

    const open = await alerts.list({});
    expect(open.openCount).toBe(0);
    expect(open.rows).toHaveLength(0); // not in the default (open) list

    const all = await alerts.list({ status: 'all' });
    expect(all.rows).toHaveLength(1); // but it is in history
  });

  it('the alert of a device that is still silent is not closed', async () => {
    const now = NOW;
    await seedDevice(before(30));
    await check.runOnce(now);

    // lastSeenAt has not changed: still silent
    expect(await check.resolveReturned(now)).toBe(0);
    const [row] = await agentDownRows();
    expect(row.resolvedAt).toBeNull();
    expect((await alerts.list({})).openCount).toBe(1);
  });

  /** It runs on every 5-minute tick, so the reason/time must not be set again the second time */
  it('idempotent: a second resolveReturned touches nothing more', async () => {
    const now = NOW;
    const deviceId = await seedDevice(before(30));
    await check.runOnce(now);
    await h.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: before(1) },
    });

    expect(await check.resolveReturned(now)).toBe(1);
    const [first] = await agentDownRows();
    const firstAt = first.resolvedAt;

    expect(await check.resolveReturned(now)).toBe(0);
    const [second] = await agentDownRows();
    expect(second.resolvedAt?.getTime()).toBe(firstAt?.getTime());
  });

  /** A revoked device is meant to be silent, so it is not closed this way */
  it('the alert of a revoked device is not closed this way', async () => {
    const now = NOW;
    const deviceId = await seedDevice(before(30));
    await check.runOnce(now);

    await h.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: before(1), status: 'revoked' },
    });

    expect(await check.resolveReturned(now)).toBe(0);
    expect((await alerts.list({})).openCount).toBe(1);
  });
});
