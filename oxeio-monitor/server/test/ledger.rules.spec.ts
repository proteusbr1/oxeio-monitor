import { describe, expect, it } from 'vitest';

import { statementLine } from '../src/hours-statement/ledger.rules';

/**
 * The carry-over is a running ledger: what was really worked in every earlier
 * statement (as it stands now) minus what was posted for them. Each case
 * chains statements the way the job would.
 */
describe('statementLine', () => {
  it('first statement: no carry, whole minutes rounded down', () => {
    expect(
      statementLine({
        measuredSec: 55_820,
        earlierRealSec: 0,
        earlierPostedMin: 0,
      }),
    ).toEqual({ carryInSec: 0, toPostMin: 930 });
  });

  it('leftover seconds are never lost', () => {
    // P1: 100 s → 1 min posted; P2: 0 s; P3: 30 s
    const p1 = statementLine({
      measuredSec: 100,
      earlierRealSec: 0,
      earlierPostedMin: 0,
    });
    const p2 = statementLine({
      measuredSec: 0,
      earlierRealSec: 100,
      earlierPostedMin: p1.toPostMin,
    });
    const p3 = statementLine({
      measuredSec: 30,
      earlierRealSec: 100,
      earlierPostedMin: p1.toPostMin + p2.toPostMin,
    });
    expect([p1.toPostMin, p2.toPostMin, p3.toPostMin]).toEqual([1, 0, 1]);
    expect(p3.carryInSec).toBe(40);
  });

  it('a late correction to an earlier period shows up once', () => {
    const p1 = statementLine({
      measuredSec: 36_000,
      earlierRealSec: 0,
      earlierPostedMin: 0,
    }); // 600 min
    // an hour was added to a P1 day after it was sent
    const p2 = statementLine({
      measuredSec: 7_200,
      earlierRealSec: 39_600,
      earlierPostedMin: p1.toPostMin,
    });
    expect(p2).toEqual({ carryInSec: 3_600, toPostMin: 180 });
    const p3 = statementLine({
      measuredSec: 0,
      earlierRealSec: 39_600 + 7_200,
      earlierPostedMin: p1.toPostMin + p2.toPostMin,
    });
    expect(p3).toEqual({ carryInSec: 0, toPostMin: 0 });
  });

  it('a posted value different from the proposal is corrected next time', () => {
    // 600 proposed, 590 posted
    const p2 = statementLine({
      measuredSec: 0,
      earlierRealSec: 36_000,
      earlierPostedMin: 590,
    });
    expect(p2).toEqual({ carryInSec: 600, toPostMin: 10 });
  });

  it('a correction larger than the new period gives a negative result', () => {
    const p2 = statementLine({
      measuredSec: 600,
      earlierRealSec: 36_000 - 3_600,
      earlierPostedMin: 600,
    });
    expect(p2).toEqual({ carryInSec: -3_600, toPostMin: -50 });
  });
});
