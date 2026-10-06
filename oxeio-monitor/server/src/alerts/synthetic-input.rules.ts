/**
 * **G46: catching mouse jigglers / synthetic input.** Pure rules, no I/O.
 *
 * Why it is needed: the agent measures idle with `GetLastInputInfo`, and that
 * API **does not tell real input from fake**. A ten-line script that sends
 * `SendKeys("{F15}")` every minute resets the timer forever, and nothing is
 * visible on screen. The result is "Working" all day.
 *
 * **The judgment is made on the server, not in the agent; that is the heart
 * of the design.** The agent runs on the staff member's own machine, so it
 * cannot be trusted: its code can be changed, it can be stopped, its files
 * can be touched. But the shape of **what data reached the server** cannot be
 * hidden. So the rule of suspicion lives here, out of reach of the person under suspicion.
 *
 * Careful: **a low-level keyboard hook is deliberately not used.** It could
 * detect fake keystrokes for certain by checking `LLKHF_INJECTED`, but it is a
 * keylogging mechanism and 04-Features § L explicitly forbids it. The promise
 * "What you typed is never recorded" will not be broken even to catch cheating.
 * So this looks at the **shape of behavior**, not the content of the input.
 *
 * Careful: this is **a request to take a look, not an accusation**. False
 * hints are possible (see below), so the messages also say "this happened",
 * not "this person is cheating".
 */

/** One ACTIVE segment: only the parts needed from `activity_segments` */
export interface ActiveSegment {
  startedAt: Date;
  endedAt: Date;
  /** 0-100, or `null` if absent */
  inputScore: number | null;
}

/** A foreground window, from `app_usage` */
export interface WindowSpan {
  startedAt: Date;
  endedAt: Date;
  /** process + title combined into one key; the same key = the screen did not change */
  key: string;
}

export interface SyntheticLimits {
  /**
   * **This number is the foundation of the whole rule: humans pause.**
   *
   * Nobody working for two hours straight fails to pause even once for 60
   * seconds (tea, bathroom, thinking, someone calling), so it practically
   * never happens. A jiggler **mathematically** cannot pause, because if it
   * did the machine would go idle and the jiggler would have no point.
   */
  minStretchSec: number;
  /**
   * The maximum number of distinct foreground windows over that whole period.
   *
   * Counted **with titles**, not just apps: even in the same Word, the
   * document name changes, and in a browser the tab changes. A jiggler's
   * screen is completely static.
   */
  maxWindows: number;
  /**
   * The maximum swing of `input_score` (max minus min).
   *
   * Human hands are uneven: sometimes 60, sometimes 100. A jiggler presses
   * exactly once a minute, so the score becomes **nearly constant**.
   */
  maxScoreSpread: number;
}

export const DEFAULT_SYNTHETIC_LIMITS: SyntheticLimits = {
  /**
   * Changed from 2 hours to 1 hour on 16 August, by the owner's decision: being
   * caught late means wrong hours piling up in the meantime, and that is
   * direct financial loss.
   *
   * It has a cost: an hour of unbroken work is **not unusual**, so the risk of
   * false hints went up. That is why the other two conditions (a single
   * window, an equal score) were not loosened; they are now the main filter.
   */
  minStretchSec: 60 * 60,
  maxWindows: 1,
  maxScoreSpread: 2,
};

export interface SyntheticFinding {
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  windows: number;
  /** `null` if no segment had a score */
  scoreSpread: number | null;
}

/**
 * Joins adjacent ACTIVE segments into unbroken "stretches".
 *
 * Careful: gaps of a few seconds are tolerated (`gapToleranceSec`). Segments
 * are rounded to the second, so they do not sit exactly back to back. Without
 * the tolerance every stretch would break within a few minutes and the rule
 * would **never** catch anyone: a silently useless feature.
 *
 * Careful: the tolerance must be kept **small**. If it is large it swallows
 * real idle breaks, and then real people would look "unbroken".
 */
export function mergeActive(
  segments: readonly ActiveSegment[],
  gapToleranceSec = 5,
): ActiveSegment[][] {
  const sorted = [...segments].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );

  const stretches: ActiveSegment[][] = [];
  let current: ActiveSegment[] = [];

  for (const seg of sorted) {
    if (current.length === 0) {
      current = [seg];
      continue;
    }

    const prevEnd = current[current.length - 1].endedAt.getTime();
    const gapSec = (seg.startedAt.getTime() - prevEnd) / 1000;

    // Careful: a negative gap = overlap (two devices); that also counts as "not broken"
    if (gapSec <= gapToleranceSec) current.push(seg);
    else {
      stretches.push(current);
      current = [seg];
    }
  }

  if (current.length > 0) stretches.push(current);
  return stretches;
}

/**
 * How many **distinct** foreground windows were seen in that period.
 *
 * Careful: any window that overlaps the stretch **even slightly** is counted;
 * it need not lie fully inside. Otherwise windows sitting on the boundary
 * would be dropped, the count would look lower than reality, and **innocent
 * people would fall under suspicion**.
 */
export function distinctWindows(
  from: Date,
  to: Date,
  usage: readonly WindowSpan[],
): number {
  const keys = new Set<string>();

  for (const u of usage) {
    if (u.endedAt <= from) continue;
    if (u.startedAt >= to) continue;
    keys.add(u.key);
  }

  return keys.size;
}

/**
 * Segments without a score are skipped, and if none has one the result is
 * `null`, not zero. Treating it as zero would look like "no swing at all",
 * which is one of the conditions for suspicion, so **missing information
 * would be treated as evidence**.
 */
export function scoreSpread(segments: readonly ActiveSegment[]): number | null {
  const scores = segments
    .map((s) => s.inputScore)
    .filter((s): s is number => s !== null);

  if (scores.length === 0) return null;
  return Math.max(...scores) - Math.min(...scores);
}

/**
 * **All three conditions are needed together**, and that is the real
 * strength of this rule.
 *
 * Each one alone can be defeated:
 *   - Length alone: someone can work two hours in one file
 *   - Windows alone: the screen does not change while watching a video either
 *   - Score alone: even very steady work can give equal scores
 *
 * But **all three together** paint a picture that is not human: two hours
 * without a single stop, in the same window, with the hand moving at the same rhythm.
 *
 * Careful: still not certainty. Someone who deliberately adds random pauses
 * and window switches can cheat. That is acknowledged: the goal is not "make
 * it impossible to catch" but **to make cheating hard and laborious enough**.
 */
export function findSyntheticInput(
  segments: readonly ActiveSegment[],
  usage: readonly WindowSpan[],
  limits: SyntheticLimits = DEFAULT_SYNTHETIC_LIMITS,
): SyntheticFinding[] {
  const findings: SyntheticFinding[] = [];

  for (const stretch of mergeActive(segments)) {
    const startedAt = stretch[0].startedAt;
    const endedAt = stretch[stretch.length - 1].endedAt;
    const durationSec = (endedAt.getTime() - startedAt.getTime()) / 1000;

    if (durationSec < limits.minStretchSec) continue;

    const windows = distinctWindows(startedAt, endedAt, usage);

    /**
     * **Zero means "unknown", not "did not change"**, and not knowing must
     * not be treated as evidence. If no `app_usage` arrived (an old agent, a
     * lost batch, or someone deliberately stopping that part), we get zero,
     * and treating that as "the same window" would turn **missing data into an accusation**.
     *
     * This does not open a way to cheat by deliberately stopping `app_usage`:
     * that would be an entirely separate and stronger sign (the agent was
     * touched), caught by `agent_tamper`, not by this rule. Each rule should
     * answer **one** question.
     */
    if (windows === 0) continue;
    if (windows > limits.maxWindows) continue;

    const spread = scoreSpread(stretch);
    // Careful: when the score is unknown we do not suspect; same reasoning as the `null` above
    if (spread === null || spread > limits.maxScoreSpread) continue;

    findings.push({ startedAt, endedAt, durationSec, windows, scoreSpread: spread });
  }

  return findings;
}
