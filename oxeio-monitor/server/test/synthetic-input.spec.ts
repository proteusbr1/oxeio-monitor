import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SYNTHETIC_LIMITS,
  distinctWindows,
  findSyntheticInput,
  mergeActive,
  scoreSpread,
  type ActiveSegment,
  type WindowSpan,
} from '../src/alerts/synthetic-input.rules';

/**
 * **G46 — catching the mouse jiggler.**
 *
 * This file's mistakes have two sides, and both are bad:
 *   · **catching too little** makes the feature silently useless — someone can cheat all day
 *   · **catching too much** puts innocent staff under suspicion, which is worse
 *
 * So the false-positive tests matter here at least as much.
 */
const T0 = new Date('2026-08-16T03:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

/** Builds unbroken ACTIVE spans — each span is 5 minutes, and a score can be given */
function run(
  fromMin: number,
  toMin: number,
  score: number | ((i: number) => number) | null = 100,
): ActiveSegment[] {
  const out: ActiveSegment[] = [];
  for (let m = fromMin, i = 0; m < toMin; m += 5, i++) {
    out.push({
      startedAt: at(m),
      endedAt: at(m + 5),
      inputScore: typeof score === 'function' ? score(i) : score,
    });
  }
  return out;
}

const win = (fromMin: number, toMin: number, key: string): WindowSpan => ({
  startedAt: at(fromMin),
  endedAt: at(toMin),
  key,
});

describe('mergeActive', () => {
  it('adjacent spans form one stretch', () => {
    expect(mergeActive(run(0, 30))).toHaveLength(1);
  });

  /** An idle break splits the stretch — the real difference between a person and a machine */
  it('a gap makes separate stretches', () => {
    const segments = [...run(0, 30), ...run(45, 75)];

    expect(mergeActive(segments)).toHaveLength(2);
  });

  /**
   * A gap of a few seconds must be tolerated — spans are rounded to seconds,
   * so they never sit exactly back to back. Without this, every stretch would
   * break and the rule would **never** catch anyone.
   */
  it('a gap of a few seconds does not break it', () => {
    const segments: ActiveSegment[] = [
      { startedAt: at(0), endedAt: at(5), inputScore: 100 },
      { startedAt: new Date(at(5).getTime() + 3000), endedAt: at(10), inputScore: 100 },
    ];

    expect(mergeActive(segments)).toHaveLength(1);
  });

  it('still joins up correctly when the order is shuffled', () => {
    const segments = [...run(20, 40), ...run(0, 20)];

    expect(mergeActive(segments)).toHaveLength(1);
  });

  it('nothing in an empty list', () => {
    expect(mergeActive([])).toEqual([]);
  });
});

describe('distinctWindows', () => {
  const usage = [win(0, 60, 'chrome|Inbox'), win(60, 120, 'chrome|Docs')];

  it('counts different titles separately', () => {
    expect(distinctWindows(at(0), at(120), usage)).toBe(2);
  });

  /**
   * A window sitting on the boundary counts too — it need not be fully inside.
   * Otherwise the count would look low, and **innocent people would fall under suspicion**.
   */
  it('counts even when only partly matching', () => {
    expect(distinctWindows(at(30), at(90), usage)).toBe(2);
  });

  it('a window outside is not counted', () => {
    expect(distinctWindows(at(200), at(260), usage)).toBe(0);
  });

  it('the same key arriving twice counts once', () => {
    const repeated = [win(0, 30, 'ps|Windows PowerShell'), win(30, 60, 'ps|Windows PowerShell')];

    expect(distinctWindows(at(0), at(60), repeated)).toBe(1);
  });
});

describe('scoreSpread', () => {
  it('the spread between the maximum and minimum', () => {
    expect(scoreSpread(run(0, 15, (i) => [60, 90, 100][i]))).toBe(40);
  });

  it('zero when all are equal', () => {
    expect(scoreSpread(run(0, 30, 99))).toBe(0);
  });

  /**
   * `null` when there is no score — **not zero**. Treating it as zero would look
   * like "no variation", which is the suspicion condition; lack of data would be taken as proof.
   */
  it('null when there is no score', () => {
    expect(scoreSpread(run(0, 30, null))).toBeNull();
  });

  it('when some spans have no score, computes from the rest', () => {
    const segments: ActiveSegment[] = [
      { startedAt: at(0), endedAt: at(5), inputScore: null },
      { startedAt: at(5), endedAt: at(10), inputScore: 80 },
      { startedAt: at(10), endedAt: at(15), inputScore: 100 },
    ];

    expect(scoreSpread(segments)).toBe(20);
  });
});

describe('findSyntheticInput — who should be caught', () => {
  /**
   * **A copy of the real incident.** The script the owner sent does exactly
   * this: `SendKeys("{F15}")` every minute, PowerShell open, no break.
   */
  it('three hours unbroken, one window, equal score — caught', () => {
    const segments = run(0, 180, 98);
    const usage = [win(0, 180, 'powershell|Windows PowerShell')];

    const found = findSyntheticInput(segments, usage);

    expect(found).toHaveLength(1);
    expect(found[0].durationSec).toBe(180 * 60);
    expect(found[0].windows).toBe(1);
    expect(found[0].scoreSpread).toBe(0);
  });

  it('caught even with slight variation in the score', () => {
    const segments = run(0, 150, (i) => (i % 2 === 0 ? 98 : 100));

    expect(findSyntheticInput(segments, [win(0, 150, 'ps|x')])).toHaveLength(1);
  });

  /** Running twice in a day catches both separately */
  it('two stretches on the same day gives both', () => {
    const segments = [...run(0, 130, 99), ...run(200, 330, 99)];
    const usage = [win(0, 130, 'ps|x'), win(200, 330, 'ps|x')];

    expect(findSyntheticInput(segments, usage)).toHaveLength(2);
  });
});

describe('findSyntheticInput — who must not be caught', () => {
  /**
   * **The most important test.** People stop — tea, bathroom, someone calling.
   * One break splits the stretch, and neither piece reaches the limit.
   */
  it('not caught when they stop once in the middle', () => {
    const segments = [...run(0, 55, 99), ...run(70, 125, 99)];

    expect(findSyntheticInput(segments, [win(0, 125, 'ps|x')])).toHaveLength(0);
  });

  /**
   * Someone can work three hours in one file — but their hand is uneven
   * and the title changes too. So they are not caught.
   */
  it('unbroken work but an uneven hand — not caught', () => {
    const segments = run(0, 180, (i) => 60 + ((i * 7) % 40));

    expect(findSyntheticInput(segments, [win(0, 180, 'excel|budget')])).toHaveLength(0);
  });

  it('not caught when the window changes', () => {
    const usage = [win(0, 90, 'chrome|Inbox'), win(90, 180, 'chrome|Docs')];

    expect(findSyntheticInput(run(0, 180, 99), usage)).toHaveLength(0);
  });

  it('not caught when the time is short', () => {
    expect(findSyntheticInput(run(0, 45, 99), [win(0, 45, 'ps|x')])).toHaveLength(0);
  });

  /**
   * When the score is unknown, **do not suspect**. After an old agent or a
   * migration, `input_score` can be null in rows — treating lack of data as
   * proof would one day accuse the whole team at once.
   */
  it('not caught when the score is unknown', () => {
    expect(findSyntheticInput(run(0, 200, null), [win(0, 200, 'ps|x')])).toHaveLength(0);
  });

  /**
   * **An empty window means "unknown", not "unchanged".** Without `app_usage`
   * the result is empty, and treating that as "the same window" would turn
   * lack of data into an accusation.
   *
   * This opens no loophole — if someone stops `app_usage` on purpose, that is a
   * much stronger sign, and it is the job of `agent_tamper`, not of this rule.
   */
  it('not caught when there is no foreground information at all', () => {
    expect(findSyntheticInput(run(0, 200, 99), [])).toHaveLength(0);
  });

  it('nothing on an empty day', () => {
    expect(findSyntheticInput([], [])).toEqual([]);
  });
});

describe('the limits can be changed', () => {
  it('a stricter limit catches even short stretches', () => {
    const found = findSyntheticInput(run(0, 40, 99), [win(0, 40, 'ps|x')], {
      ...DEFAULT_SYNTHETIC_LIMITS,
      minStretchSec: 30 * 60,
    });

    expect(found).toHaveLength(1);
  });

  /** Changed from 2 to 1 hour — catching late means wrong hours accumulate meanwhile */
  it('the default limit is one hour', () => {
    expect(DEFAULT_SYNTHETIC_LIMITS.minStretchSec).toBe(60 * 60);
  });
});
