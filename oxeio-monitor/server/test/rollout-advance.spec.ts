import { describe, expect, it } from 'vitest';

import {
  isProvenBy,
  isOfferedTo,
  nextStage,
  ROLLOUT_FRESH_MINUTES,
  ROLLOUT_SOAK_HOURS,
  stageToAdvanceTo,
  type DeviceProof,
} from '../src/agent/rollout';

/**
 * H04: the rules for the rollout advancing by itself.
 *
 * Background: office staff were not receiving updates, and every single PC
 * had to be installed manually.
 *
 * The cause was not a bug but a missing step. Buckets, percentages, pilot,
 * emergency brake: the whole machinery for staged rollout existed, but the
 * only way to change `canary -> partial -> all` was a manual click. If nobody
 * clicked, a new version sat at 7% forever, so 11 of the 12 PCs were never
 * even offered it.
 *
 * The real job of this file is not to guard the new behaviour but to check
 * that the old safety features are intact. If automating means the emergency
 * brake can be released, or a broken build can spread by itself, the problem
 * is much bigger than before.
 */

const HOUR_MS = 3600_000;
const NOW = new Date('2026-09-05T12:00:00.000Z');

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR_MS);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** A healthy canary machine: running for over six hours, just responded */
function healthy(over: Partial<DeviceProof> = {}): DeviceProof {
  return {
    versionSince: hoursAgo(ROLLOUT_SOAK_HOURS + 1),
    lastSeenAt: minutesAgo(1),
    ...over,
  };
}

describe('nextStage: the emergency brake is not in the hands of anything automatic', () => {
  it('canary → partial → all', () => {
    expect(nextStage('canary')).toBe('partial');
    expect(nextStage('partial')).toBe('all');
  });

  it('`all` is the last stage: nothing to advance to', () => {
    expect(nextStage('all')).toBeNull();
  });

  /**
   * The most important test in this file.
   *
   * `halted` means the owner pressed the emergency brake, usually because the
   * build broke something in the field. If anything automatic could release it,
   * the brake would no longer be a brake, and the broken build would go to every
   * other PC by itself. The risk did not exist before, because stages only
   * advanced by a human click.
   */
  it('there is no way out of `halted`', () => {
    expect(nextStage('halted')).toBeNull();
  });
});

describe('isProvenBy: is a machine really giving proof', () => {
  it('running for six hours and still responding: proof', () => {
    expect(isProvenBy(healthy(), NOW)).toBe(true);
  });

  it('just installed: nothing is proven yet', () => {
    // A build installed five minutes ago says nothing; that is the whole point of soak
    expect(isProvenBy(healthy({ versionSince: minutesAgo(5) }), NOW)).toBe(false);
  });

  /**
   * This is the real test, and the one most easily left out.
   *
   * If the condition were only "running for six hours", a machine with a dead
   * agent would count as proof too: the very build that killed the agent would
   * reach everyone else by itself. A build that crashes leaves its device
   * silent, and the silence is the strongest signal.
   */
  it('six hours passed, but the agent is silent: not proof', () => {
    expect(
      isProvenBy(
        healthy({ lastSeenAt: minutesAgo(ROLLOUT_FRESH_MINUTES + 10) }),
        NOW,
      ),
    ).toBe(false);
  });

  /**
   * `null` means "unknown", and unknown cannot count as proof. This is not just
   * theory: on migration day every old row has this cell empty. Treating
   * "unknown" as "running for a long time" would send every version to `all`
   * in one jump that very day.
   */
  it('tracking start unknown: not proof', () => {
    expect(isProvenBy(healthy({ versionSince: null }), NOW)).toBe(false);
  });

  it('never responded: not proof', () => {
    expect(isProvenBy(healthy({ lastSeenAt: null }), NOW)).toBe(false);
  });

  /**
   * Exactly on the boundary it is proof; otherwise "six hours" would really
   * mean "six hours plus one tick", and combined with the job's hourly tick the
   * delay would grow by an hour.
   */
  it('proof at exactly six hours', () => {
    expect(isProvenBy(healthy({ versionSince: hoursAgo(ROLLOUT_SOAK_HOURS) }), NOW)).toBe(
      true,
    );
  });
});

describe('stageToAdvanceTo: the job only fetches rows, the decision is here', () => {
  it('healthy canary -> partial', () => {
    expect(stageToAdvanceTo('canary', [healthy()], NOW)).toBe('partial');
  });

  it('healthy partial -> all', () => {
    expect(stageToAdvanceTo('partial', [healthy()], NOW)).toBe('all');
  });

  /**
   * If nobody installs it, the stage does not advance, and this is the centre
   * of the design.
   *
   * The condition could have been "six hours after release" (`released_at`),
   * and that was the simplest. But it would erase the whole meaning of canary:
   * the stage would advance even if not one machine ran the build, so "test on
   * one PC first" would stay on paper only.
   */
  it('no machine is running this build at all: the stage does not advance', () => {
    expect(stageToAdvanceTo('canary', [], NOW)).toBeNull();
  });

  it('running, but nobody gives proof: the stage does not advance', () => {
    const tooNew = healthy({ versionSince: minutesAgo(10) });
    const silent = healthy({ lastSeenAt: minutesAgo(ROLLOUT_FRESH_MINUTES + 1) });

    expect(stageToAdvanceTo('canary', [tooNew, silent], NOW)).toBeNull();
  });

  /**
   * At least one, not all. If a PC of someone on leave is off, an "everyone"
   * condition would block the rollout forever, and the very problem being
   * fixed would come back in other packaging.
   */
  it('one machine giving proof is enough: the others may be off', () => {
    const off = healthy({ lastSeenAt: hoursAgo(20) });

    expect(stageToAdvanceTo('canary', [off, healthy(), off], NOW)).toBe('partial');
  });

  it('nothing happens on `halted` even with healthy machines', () => {
    expect(stageToAdvanceTo('halted', [healthy(), healthy()], NOW)).toBeNull();
  });

  it('nothing more to advance to from `all`', () => {
    expect(stageToAdvanceTo('all', [healthy()], NOW)).toBeNull();
  });
});

/**
 * The delivery rule and the advancing rule are two different things, and
 * they must stay different.
 *
 * This describe tests nothing new; it checks that the new code has not
 * touched the old. If someone one day edits `isOfferedTo` while automating the
 * rollout, the breakage will be caught here.
 */
/**
 * Each stage gets its own six hours.
 *
 * The bug this describe guards: soak was measured only from `versionSince`,
 * when the device installed the build. The clock was not reset when the stage
 * changed, so a machine that had passed six hours in canary would make
 * `partial -> all` happen on the very next tick too. The 50% stage was
 * effectively skipped, and the whole purpose of a staged release failed.
 *
 * Every stage adds new machines, and the risk is exactly about them, so
 * waiting afresh for the new stage is the whole point of the system.
 */
describe('the soak clock resets stage by stage', () => {
  /** The core test of this file's new behaviour */
  it('when the stage has just changed, even an old machine is no longer proof', () => {
    // the machine has been running for seven hours: enough under the old rule
    const machine = healthy();

    // but the stage changed an hour ago
    expect(isProvenBy(machine, NOW, ROLLOUT_SOAK_HOURS, ROLLOUT_FRESH_MINUTES, hoursAgo(1))).toBe(
      false,
    );
  });

  it('after six hours in the new stage it is proof again', () => {
    const machine = healthy({ versionSince: hoursAgo(20) });

    expect(
      isProvenBy(machine, NOW, ROLLOUT_SOAK_HOURS, ROLLOUT_FRESH_MINUTES, hoursAgo(ROLLOUT_SOAK_HOURS + 1)),
    ).toBe(true);
  });

  /**
   * If the stage change is old, the clock stays at the device's install time,
   * so a freshly installed machine is still not proof. Whichever of the two is
   * later is the floor.
   */
  it('even with an old stage, a freshly installed machine is not proof', () => {
    const fresh = healthy({ versionSince: hoursAgo(1) });

    expect(
      isProvenBy(fresh, NOW, ROLLOUT_SOAK_HOURS, ROLLOUT_FRESH_MINUTES, hoursAgo(100)),
    ).toBe(false);
  });

  /**
   * `stageToAdvanceTo` obeys the clock too: otherwise the pure rule would be
   * right and the job would still advance by the old behaviour. A familiar sin in this repo.
   */
  it('`stageToAdvanceTo` does not advance when the stage has just changed', () => {
    const proofs = [healthy(), healthy()];

    expect(
      stageToAdvanceTo('partial', proofs, NOW, ROLLOUT_SOAK_HOURS, hoursAgo(1)),
    ).toBeNull();
  });

  it('it advances when the stage is old enough', () => {
    const proofs = [healthy()];

    expect(
      stageToAdvanceTo('partial', proofs, NOW, ROLLOUT_SOAK_HOURS, hoursAgo(ROLLOUT_SOAK_HOURS + 1)),
    ).toBe('all');
  });

  /**
   * If the clock is unknown (`null`), the old behaviour: in old rows the column
   * may be empty, and then advancing is better than the rollout getting stuck.
   */
  it('with an unknown clock, the old behaviour', () => {
    expect(isProvenBy(healthy(), NOW, ROLLOUT_SOAK_HOURS, ROLLOUT_FRESH_MINUTES, null)).toBe(
      true,
    );
  });
});

describe('the delivery rule is intact: automating changed nothing', () => {
  const GUID = 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d';

  it('nobody gets it on `halted`, not even the pilot', () => {
    expect(isOfferedTo('halted', GUID, '0.4.11', true)).toBe(false);
  });

  it('everyone gets it on `all`', () => {
    expect(isOfferedTo('all', GUID, '0.4.11')).toBe(true);
  });

  it('the pilot gets it regardless of bucket', () => {
    expect(isOfferedTo('canary', GUID, '0.4.11', true)).toBe(true);
  });
});
