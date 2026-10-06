import { describe, expect, it } from 'vitest';

import {
  isNewer,
  isOfferedTo,
  pilotNeededFor,
  rolloutBucket,
} from '../src/agent/rollout';

/**
 * H04: staged rollout.
 *
 * A mistake in these rules is found on the office's 15 PCs, by which time it
 * is too late: G58 (docs/08-Gap-Analysis.md) showed that once a bad MSI has
 * been delivered, a new MSI cannot fix it; someone has to go by hand.
 */

// like the office's 15 machines
const FLEET = Array.from({ length: 15 }, (_, i) => `machine-guid-${i}`);

const offered = (stage: 'canary' | 'partial' | 'all' | 'halted', v: string) =>
  FLEET.filter((g) => isOfferedTo(stage, g, v));

describe('rollout: the stages', () => {
  it('nobody gets it on halted', () => {
    expect(offered('halted', '1.2.0')).toHaveLength(0);
  });

  it('everyone gets it on all', () => {
    expect(offered('all', '1.2.0')).toHaveLength(FLEET.length);
  });

  /**
   * With 15 devices "10%" means 1.5, rounded to 0 or 2. Canary is by
   * definition a handful, so the number is chosen so that in practice 1-2 fall in.
   */
  it('canary has very few machines: neither zero nor everyone', () => {
    // checked over several versions, because the bucket also depends on the version
    const counts = ['1.2.0', '1.3.0', '2.0.0', '2.1.0'].map(
      (v) => offered('canary', v).length,
    );

    expect(Math.max(...counts)).toBeLessThanOrEqual(4);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('partial is more than canary and fewer than all', () => {
    const v = '1.2.0';
    expect(offered('partial', v).length).toBeGreaterThanOrEqual(
      offered('canary', v).length,
    );
    expect(offered('partial', v).length).toBeLessThan(FLEET.length);
  });

  /** Whoever got canary also gets partial, otherwise the update would go backwards */
  it('nobody loses the update when the stage rises', () => {
    const v = '1.2.0';
    for (const g of offered('canary', v)) {
      expect(isOfferedTo('partial', g, v), g).toBe(true);
      expect(isOfferedTo('all', g, v), g).toBe(true);
    }
  });
});

describe('rollout: buckets', () => {
  it('the same machine and version always give the same answer', () => {
    // If random, every heartbeat would get a different answer and there
    // would be no such thing as canary
    const a = rolloutBucket('guid-x', '1.2.0');
    const b = rolloutBucket('guid-x', '1.2.0');

    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });

  /**
   * Without mixing the version into the bucket, the same unlucky machine would
   * be the guinea pig for every update forever, and one staff member's PC would
   * break again and again.
   */
  it('when the version changes, the guinea pig changes too', () => {
    const first = offered('canary', '1.2.0').join();
    const later = ['1.3.0', '1.4.0', '2.0.0'].map((v) =>
      offered('canary', v).join(),
    );

    expect(later.some((set) => set !== first)).toBe(true);
  });
});

describe('rollout: version comparison', () => {
  it.each([
    ['1.10.0', '1.9.0', true],
    ['1.9.0', '1.10.0', false],
    ['2.0.0', '1.99.99', true],
    ['1.2.3', '1.2.3', false],
    ['1.2', '1.2.0', false],
    ['1.2.1', '1.2', true],
  ])('%s > %s → %s', (a, b, expected) => {
    expect(isNewer(a, b)).toBe(expected);
  });

  /** String comparison says '1.10.0' < '1.9.0': the classic trap */
  it('does not fall into the string-comparison trap', () => {
    expect('1.10.0' > '1.9.0').toBe(false);
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
  });
});
/**
 * A chosen PC (pilot).
 *
 * The gap is in the design: the bucket is decided per machine, not per
 * person, so the PC where a bug was found could not be the first to test the
 * fix. Measured in the field: OX-05's bucket is 86, while canary is 7 and
 * partial is 50. The owner asked that OX-05 get the update first.
 */
describe('rollout: a chosen PC', () => {
  /** Bucket above 50, so it falls in neither canary nor partial */
  const outsider = FLEET.find(
    (g) => rolloutBucket(g, '1.0.0') >= 50,
  ) as string;

  it('a pilot gets the offer even when outside the bucket', () => {
    expect(isOfferedTo('canary', outsider, '1.0.0')).toBe(false);
    expect(isOfferedTo('canary', outsider, '1.0.0', true)).toBe(true);
    expect(isOfferedTo('partial', outsider, '1.0.0', true)).toBe(true);
  });

  /**
   * The most important claim: a halted build does not go to the pilot either.
   * Otherwise, after stopping a bad update, it would keep going to exactly the
   * machine we are watching most closely, and there is no automatic rollback (G69).
   */
  it('a pilot does not get it on halted either', () => {
    expect(isOfferedTo('halted', outsider, '1.0.0', true)).toBe(false);
  });

  it('without the pilot flag, the old behaviour is unchanged', () => {
    for (const guid of FLEET) {
      expect(isOfferedTo('canary', guid, '1.0.0', false)).toBe(
        isOfferedTo('canary', guid, '1.0.0'),
      );
    }
  });

  it('everyone gets it on all, pilot or not', () => {
    expect(isOfferedTo('all', outsider, '1.0.0')).toBe(true);
    expect(isOfferedTo('all', outsider, '1.0.0', true)).toBe(true);
  });
});


/**
 * If canary's bucket is empty, the version would stay stuck forever (G168).
 *
 * The bucket is per machine, and the office has only nine distinct
 * `machine_guid`s (the Windows image was cloned: 12 PCs, 9 GUIDs). 7% of nine
 * machines is 0.63 on average, so very often nobody falls in the bucket.
 *
 * If nobody is offered the update, nobody installs it, so `RolloutAdvanceJob`
 * gets no proof, the stage does not advance, and the version stays in canary
 * forever: exactly the deadlock the whole job was written to fix.
 *
 * Measured, not theory: with the office's real nine GUIDs over 200 possible
 * version numbers, the bucket was empty for 101 of them (50%).
 */
describe('G168: picking one person when the bucket is empty', () => {
  const now = new Date('2026-09-07T04:00:00Z');
  const fresh = new Date(now.getTime() - 60 * 60 * 1000);
  const stale = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  const cand = (id: number, lastSeenAt: Date | null = fresh) => ({
    id,
    machineGuid: `machine-guid-${id}`,
    lastSeenAt,
  });

  /** A version in which none of those machines falls in canary */
  const versionWithEmptyCanary = (guids: readonly string[]): string => {
    for (let i = 0; i < 500; i += 1) {
      const v = `9.0.${i}`;
      if (guids.every((g) => !isOfferedTo('canary', g, v))) return v;
    }
    throw new Error('no version with an empty canary bucket');
  };

  /** A version in which at least one falls in canary */
  const versionWithSomeoneInCanary = (guids: readonly string[]): string => {
    for (let i = 0; i < 500; i += 1) {
      const v = `9.0.${i}`;
      if (guids.some((g) => isOfferedTo('canary', g, v))) return v;
    }
    throw new Error('no version with a filled canary bucket');
  };

  const people = [cand(1), cand(2), cand(3), cand(4), cand(5)];
  const guids = people.map((p) => p.machineGuid);

  /** The core claim of this block */
  it('when the bucket is empty, one pilot is returned', () => {
    const v = versionWithEmptyCanary(guids);
    const picked = pilotNeededFor('canary', people, v, now);

    expect(picked).not.toBeNull();
    expect(guids).toHaveLength(5);
    expect(people.some((p) => p.id === picked)).toBe(true);
  });

  /** If someone falls in anyway, no intervention: the rule is working by itself */
  it('when someone falls in the bucket, nothing is done', () => {
    const v = versionWithSomeoneInCanary(guids);

    expect(pilotNeededFor('canary', people, v, now)).toBeNull();
  });

  /**
   * Everyone already gets it on `all`, and `halted` means deliberately nobody:
   * the emergency brake. A pilot would be wrong in both, and the second is
   * directly dangerous: after stopping, a bad build would still go to one machine.
   */
  it('on all and halted, nothing is done in either', () => {
    const v = versionWithEmptyCanary(guids);

    expect(pilotNeededFor('all', people, v, now)).toBeNull();
    expect(pilotNeededFor('halted', people, v, now)).toBeNull();
  });

  /**
   * Live machines first: a PC that has not responded in a day cannot give any
   * proof, and picking it would leave the deadlock in place.
   */
  it('a machine silent for a long time is not picked', () => {
    const v = versionWithEmptyCanary(guids);
    const mixed = [cand(1, stale), cand(2, stale), cand(3, fresh)];

    // number 3 is the only live one, whatever the bucket numbers
    expect(pilotNeededFor('canary', mixed, versionWithEmptyCanary(
      mixed.map((m) => m.machineGuid),
    ), now)).toBe(3);
    expect(v).toBeTruthy();
  });

  /** If nobody is alive, pick from everyone: better than not picking */
  it('even if nobody is alive, one is picked', () => {
    const dead = [cand(1, stale), cand(2, stale), cand(3, null)];
    const v = versionWithEmptyCanary(dead.map((d) => d.machineGuid));

    expect(pilotNeededFor('canary', dead, v, now)).not.toBeNull();
  });

  /**
   * The pick is deterministic: the same input always gives the same answer. If
   * random, a different person would be the guinea pig at every release, and
   * there would be no answer to why that machine was chosen.
   */
  it('the same input always gives the same answer', () => {
    const v = versionWithEmptyCanary(guids);
    const once = pilotNeededFor('canary', people, v, now);

    for (let i = 0; i < 5; i += 1) {
      expect(pilotNeededFor('canary', people, v, now)).toBe(once);
    }
  });

  /** The one picked has the lowest bucket number */
  it('the one with the lowest bucket number is chosen', () => {
    const v = versionWithEmptyCanary(guids);
    const picked = pilotNeededFor('canary', people, v, now);

    const lowest = Math.min(...guids.map((g) => rolloutBucket(g, v)));
    const chosen = people.find((p) => p.id === picked)!;

    expect(rolloutBucket(chosen.machineGuid, v)).toBe(lowest);
  });

  it('null when there are no devices at all', () => {
    expect(pilotNeededFor('canary', [], '9.9.9', now)).toBeNull();
  });
});
