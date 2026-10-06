import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { RolloutAdvanceJob } from '../src/agent/rollout-advance.job';
import { ROLLOUT_SOAK_HOURS } from '../src/agent/rollout';
import { createHarness, realNow, resetDatabase, type Harness } from './setup/harness';

/**
 * H04: the rollout advances by itself, up to the pair boundary.
 *
 * Background: office staff were not receiving updates, and every single PC
 * had to be installed manually.
 *
 * The rules themselves are tested in `rollout-advance.spec.ts` (pure
 * functions, no DB). The question here is different: does the query pull
 * exactly the right rows, is the column actually read, and when the stage
 * changes does it really land in the database?
 *
 * Careful: this project has had more than ten bugs of exactly this shape: the
 * contract is written but the caller was not. Here the result would be
 * especially silent: the stage would not advance, nobody would get the
 * update, and no error would be raised.
 */
let h: Harness;
let job: RolloutAdvanceJob;

const HOUR_MS = 3600_000;

beforeAll(async () => {
  h = await createHarness();
  job = h.app.get(RolloutAdvanceJob);
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDatabase(h.prisma, h.app);
});

/**
 * The real clock, not a pinned time (a legitimate use per the test-clock
 * rule): `lastSeenAt` and `agentVersionSince` are set in the DB, and the job
 * compares them with `now`. Mixing two clocks on the two sides would make the
 * "6 hours" condition mechanically wrong.
 */
const ago = (ms: number) => new Date(realNow().getTime() - ms);

/**
 * The default release time is in the past, not `realNow()`.
 *
 * The floor of the soak clock is now `stage_changed_at` (below), so a
 * "just published" version never advances, which is correct. But in reality a
 * build a device has been running for six hours was published at least six
 * hours earlier. So the fixture's default assumes that reality; for cases where
 * the stage just changed, the caller can pass `realNow()` itself.
 */
async function publish(
  version: string,
  stage: 'canary' | 'partial' | 'all' | 'halted',
  releasedAt = new Date(realNow().getTime() - (ROLLOUT_SOAK_HOURS + 2) * 3600_000),
): Promise<void> {
  await h.prisma.agentVersion.create({
    data: {
      version,
      msiPath: `updates/oXeioAgent-${version}.msi`,
      sha256: 'a'.repeat(64),
      rolloutStage: stage,
      releasedAt,
      /**
       * The soak clock's floor is also `releasedAt`.
       *
       * The default is `now()`, i.e. the real moment the row is created. The
       * fixture sets `releasedAt` in the past and runs the job with a future
       * `now`, so without setting the floor every test would look as if the
       * stage "just changed" and the job would never advance. Publishing is
       * also a stage change, so the two being equal is correct.
       */
      stageChangedAt: releasedAt,
    },
  });
}

async function device(opts: {
  tag: string;
  agentVersion?: string | null;
  sinceMs?: number | null;
  seenMs?: number | null;
  status?: 'active' | 'revoked';
}): Promise<number> {
  const d = await h.prisma.device.create({
    data: {
      hostname: `PC-${opts.tag}`,
      windowsUsername: `user-${opts.tag}`,
      machineGuid: randomUUID(),
      tokenHash: randomUUID(),
      status: opts.status ?? 'active',
      agentVersion: opts.agentVersion ?? null,
      agentVersionSince: opts.sinceMs == null ? null : ago(opts.sinceMs),
      lastSeenAt: opts.seenMs == null ? null : ago(opts.seenMs),
    },
  });
  return d.id;
}

/** On this build for more than six hours, and just responded */
const proven = (tag: string, version: string) =>
  device({
    tag,
    agentVersion: version,
    sinceMs: (ROLLOUT_SOAK_HOURS + 1) * HOUR_MS,
    seenMs: 60_000,
  });

const stageOf = async (version: string) =>
  (await h.prisma.agentVersion.findUniqueOrThrow({ where: { version } }))
    .rolloutStage;

describe('the rollout advances by itself', () => {
  it('a healthy canary: the stage moves up to partial', async () => {
    await publish('0.4.11', 'canary');
    await proven('a', '0.4.11');

    const result = await job.runOnce();

    expect(result).toMatchObject({ version: '0.4.11', from: 'canary', to: 'partial' });
    expect(await stageOf('0.4.11')).toBe('partial');
  });

  it('partial: next stage is all', async () => {
    await publish('0.4.11', 'partial');
    await proven('a', '0.4.11');

    await job.runOnce();

    expect(await stageOf('0.4.11')).toBe('all');
  });

  /**
   * One stage per tick: it does not jump straight from canary to all.
   *
   * A jump would leave the partial stage meaningless and lose the chance to
   * stop and look at 50%.
   */
  it('one stage per tick: no canary to all jump', async () => {
    await publish('0.4.11', 'canary');
    await proven('a', '0.4.11');

    await job.runOnce();
    expect(await stageOf('0.4.11')).toBe('partial');
  });

  /**
   * The most important test in this file.
   *
   * `halted` means the owner pressed the emergency brake, usually because the
   * build broke something in the field. If a machine could open it, the broken
   * build would go to every other PC by itself and the owner would have no way
   * to stop it. The risk is new: before, a stage only advanced by a human click.
   */
  it('`halted` never opens, even with healthy machines', async () => {
    await publish('0.4.11', 'halted');
    await proven('a', '0.4.11');

    const result = await job.runOnce();

    expect(result.to).toBeNull();
    expect(await stageOf('0.4.11')).toBe('halted');
  });

  /**
   * If nobody installs it, the stage does not advance: that is the whole
   * point of canary.
   *
   * If the condition were "six hours after release" this test would fail: the
   * version was released long ago, yet not a single machine is running it.
   */
  it('no machine is on this build: even an old release does not advance', async () => {
    await publish('0.4.11', 'canary', ago(30 * HOUR_MS));
    await device({ tag: 'old', agentVersion: '0.4.10', sinceMs: 40 * HOUR_MS, seenMs: 60_000 });

    await job.runOnce();

    expect(await stageOf('0.4.11')).toBe('canary');
  });

  /**
   * A broken build does not spread by itself.
   *
   * The machine has been on this build for over six hours, but has gone
   * silent, exactly what would happen if the new build crashed the agent. With
   * soak alone this would count as "proof" and the worst build would reach
   * everyone.
   */
  it('the agent has gone silent: the stage does not advance', async () => {
    await publish('0.4.11', 'canary');
    await device({
      tag: 'dead',
      agentVersion: '0.4.11',
      sinceMs: (ROLLOUT_SOAK_HOURS + 2) * HOUR_MS,
      seenMs: 5 * HOUR_MS,
    });

    await job.runOnce();

    expect(await stageOf('0.4.11')).toBe('canary');
  });

  it('just installed: waits', async () => {
    await publish('0.4.11', 'canary');
    await device({
      tag: 'fresh',
      agentVersion: '0.4.11',
      sinceMs: 10 * 60_000,
      seenMs: 60_000,
    });

    await job.runOnce();

    expect(await stageOf('0.4.11')).toBe('canary');
  });

  /**
   * Behaviour on migration day. In all old rows `agent_version_since` is
   * empty; treating "unknown" as "running for a long time" would send the
   * current version to everyone in one jump on that very day, with nobody doing anything.
   */
  it('`agent_version_since` empty: not proof', async () => {
    await publish('0.4.11', 'canary');
    await device({ tag: 'unknown', agentVersion: '0.4.11', sinceMs: null, seenMs: 60_000 });

    await job.runOnce();

    expect(await stageOf('0.4.11')).toBe('canary');
  });

  /** The heartbeat of a revoked PC is not proof */
  it('a revoked device gives no proof', async () => {
    await publish('0.4.11', 'canary');
    await device({
      tag: 'revoked',
      agentVersion: '0.4.11',
      sinceMs: (ROLLOUT_SOAK_HOURS + 1) * HOUR_MS,
      seenMs: 60_000,
      status: 'revoked',
    });

    await job.runOnce();

    expect(await stageOf('0.4.11')).toBe('canary');
  });

  /**
   * The job picks exactly the version `offerFor()` hands out: the newest
   * non-halted one. Advancing an old one would be silent and pointless:
   * nobody is offered it.
   */
  it('old versions are not touched', async () => {
    await publish('0.4.10', 'canary', ago(40 * HOUR_MS));
    await publish('0.4.11', 'canary', ago(20 * HOUR_MS));
    await proven('a', '0.4.11');

    await job.runOnce();

    expect(await stageOf('0.4.11')).toBe('partial');
    expect(await stageOf('0.4.10')).toBe('canary');
  });

  /**
   * It is written to the ledger, and that is not optional. Changing a stage
   * used to always be a human's job, so the ledger had a name. If a machine
   * did it, the ledger would be blank, and someone would see "7% yesterday,
   * 100% today" with no answer to who or what did it.
   *
   * A separate action, not `change_agent_rollout`: "a human decided" and "the
   * condition was met" are two different responsibilities.
   */
  it('the audit log records it separately, with userId empty', async () => {
    await publish('0.4.11', 'canary');
    await proven('a', '0.4.11');

    await job.runOnce();

    const row = await h.prisma.auditLog.findFirstOrThrow({
      where: { action: 'agent_version.rollout_auto' },
    });

    expect(row.userId).toBeNull();
    expect(row.targetId).toBe('0.4.11');
    expect(row.meta).toMatchObject({ from: 'canary', to: 'partial' });
  });

  /**
   * What happens the day after migration, and why a backfill was needed.
   *
   * The column is filled only when the version changes. But the 12 PCs now
   * running 0.4.9/0.4.10 will never change version, so the cell would stay
   * NULL forever, the job would never find proof, and the current version would
   * stay stuck in canary forever. That is, the very problem being fixed would
   * survive the migration in new packaging.
   *
   * So the migration does an `UPDATE ... SET now()`: the clock starts at
   * deploy. The value is not the real start time but a lower bound, and the
   * error is on the safe side: it must wait the six hours, never less.
   *
   * This test guards the behaviour of the backfill, not the SQL: right after
   * deploy (clock just started) nothing happens, and after six hours exactly
   * one stage.
   */
  it('after the backfill: not at once, one stage after six hours', async () => {
    await publish('0.4.10', 'canary');

    // the moment of deploy: the clock has just been set
    const id = await device({
      tag: 'backfilled',
      agentVersion: '0.4.10',
      sinceMs: 1000,
      seenMs: 60_000,
    });

    await job.runOnce();
    expect(await stageOf('0.4.10')).toBe('canary');

    // six hours passed: shown by moving the clock back
    await h.prisma.device.update({
      where: { id },
      data: { agentVersionSince: ago((ROLLOUT_SOAK_HOURS + 1) * HOUR_MS) },
    });

    await job.runOnce();
    expect(await stageOf('0.4.10')).toBe('partial');
  });

  it('with no version published at all, it returns quietly', async () => {
    const result = await job.runOnce();
    expect(result).toMatchObject({ version: null, to: null, skipped: false });
  });
});
