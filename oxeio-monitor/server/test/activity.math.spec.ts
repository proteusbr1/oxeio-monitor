import { describe, expect, it } from 'vitest';

import {
  addSeconds,
  emptyBuckets,
  foldDailyScores,
  foldTeamSites,
  foldUsage,
  normalizeDomain,
  normalizeProcess,
  parseWorkDate,
  patternProblem,
  resolveRange,
  scoreOf,
  toDateKey,
  type CategoryMeta,
  type DailyGroup,
  type TeamGroup,
  type UsageGroup,
} from '../src/activity/activity.math';

/** A small sample of the seed's rules: the ids are made up, but the kinds are real. */
const META = new Map<number, CategoryMeta>([
  [1, { displayName: 'Visual Studio Code', category: 'productive', matchType: 'process' }],
  [2, { displayName: 'Google Chrome', category: 'neutral', matchType: 'process' }],
  [3, { displayName: 'GitHub', category: 'productive', matchType: 'domain' }],
  [4, { displayName: 'YouTube', category: 'unproductive', matchType: 'domain' }],
  [5, { displayName: 'Facebook', category: 'unproductive', matchType: 'domain' }],
]);

const H = 3600;

const day = (text: string): Date => parseWorkDate(text);

// ── Score (D07) ──────────────────────────────────────────────────────────────

describe('productivity score: unknown time stays out of the denominator', () => {
  it('score is productive / (everything known), leaving out unknown', () => {
    const b = emptyBuckets();
    addSeconds(b, 'productive', 3 * H);
    addSeconds(b, 'neutral', 1 * H);
    addSeconds(b, 'unproductive', 0);
    addSeconds(b, null, 96 * H);

    const score = scoreOf(b);

    // Even with 96 hours unknown, the denominator is just 4 hours: null means
    // "don't know", which counts neither for nor against anyone
    expect(score.categorizedSec).toBe(4 * H);
    expect(score.scorePct).toBe(75);
  });

  it('avoids the mistake that would come from treating unknown time as neutral', () => {
    const b = emptyBuckets();
    addSeconds(b, 'productive', 1 * H);
    addSeconds(b, null, 9 * H);

    // Now: 100%, with "90% of time unknown" beside it
    // Wrongly treated as neutral: 10%, a completely different story from the same data
    expect(scoreOf(b).scorePct).toBe(100);
    expect(scoreOf(b).unknownPct).toBe(90);
  });

  it('"what percent is unknown" always sits beside the score', () => {
    const b = emptyBuckets();
    addSeconds(b, 'productive', 1 * H);
    addSeconds(b, null, 99 * H);

    const score = scoreOf(b);
    expect(score.scorePct).toBe(100);
    expect(score.unknownPct).toBe(99);
  });

  /**
   * The most useful test. Dividing by zero gives NaN, and covering it with
   * `?? 0` gives "0% productive", which would say the person did nothing all
   * day. The truth is that there is no information to report.
   */
  it('when known time is zero the score is null, not zero', () => {
    expect(scoreOf(emptyBuckets()).scorePct).toBeNull();

    const allUnknown = emptyBuckets();
    addSeconds(allUnknown, null, 8 * H);
    const score = scoreOf(allUnknown);

    expect(score.scorePct).toBeNull();
    expect(score.unknownPct).toBe(100);
    expect(score.totalSec).toBe(8 * H);
  });

  it('no number is NaN on a completely empty day', () => {
    const score = scoreOf(emptyBuckets());

    expect(score.totalSec).toBe(0);
    expect(score.categorizedSec).toBe(0);
    expect(score.unknownPct).toBe(0);
    expect(Number.isNaN(score.unknownPct)).toBe(false);
  });

  it('percentages stop at two decimals', () => {
    const b = emptyBuckets();
    addSeconds(b, 'productive', 1);
    addSeconds(b, 'neutral', 2);

    expect(scoreOf(b).scorePct).toBe(33.33);
  });

  it('negative time is not silently accepted', () => {
    expect(() => addSeconds(emptyBuckets(), 'productive', -1)).toThrow(RangeError);
    expect(() => addSeconds(emptyBuckets(), null, Number.NaN)).toThrow(RangeError);
  });
});

describe('per-day fold (D07)', () => {
  const groups: DailyGroup[] = [
    { employeeId: 7, workDate: day('2026-08-02'), categoryId: 1, seconds: 2 * H },
    { employeeId: 7, workDate: day('2026-08-02'), categoryId: 4, seconds: 2 * H },
    { employeeId: 7, workDate: day('2026-08-01'), categoryId: 1, seconds: 6 * H },
    { employeeId: 7, workDate: day('2026-08-01'), categoryId: null, seconds: 1 * H },
    { employeeId: 9, workDate: day('2026-08-01'), categoryId: 5, seconds: 3 * H },
  ];

  it('days come in date order, even when inserted in reverse', () => {
    const folded = foldDailyScores(groups, META);
    expect(folded.get(7)!.days.map((d) => d.workDate)).toEqual([
      '2026-08-01',
      '2026-08-02',
    ]);
  });

  it('each day has its own score, and the total is over the sum of all days', () => {
    const folded = foldDailyScores(groups, META)!;
    const seven = folded.get(7)!;

    expect(seven.days[0].scorePct).toBe(100); // 6 hours VS Code, 1 hour unknown
    expect(seven.days[0].unknownPct).toBe(round(1 / 7));
    expect(seven.days[1].scorePct).toBe(50); // 2 hours code, 2 hours YouTube

    // Total: 8 hours productive, 2 hours unproductive, so 80%
    expect(seven.total.scorePct).toBe(80);
    expect(seven.total.unknownSec).toBe(1 * H);
  });

  it('no zero row is made for days that have no rows', () => {
    // There are rows for 1 and 2 August, none for 3 August, so there are two days
    expect(foldDailyScores(groups, META).get(7)!.days).toHaveLength(2);
  });

  it('with no rows the employee is absent from the map (the service then sets a zero score)', () => {
    expect(foldDailyScores([], META).size).toBe(0);
  });

  it('a categoryId not in the map becomes "unknown", not a crash', () => {
    const folded = foldDailyScores(
      [{ employeeId: 1, workDate: day('2026-08-01'), categoryId: 999, seconds: H }],
      META,
    );

    expect(folded.get(1)!.total.unknownSec).toBe(H);
    expect(folded.get(1)!.total.scorePct).toBeNull();
  });
});

// ── Top 10 (D08) ─────────────────────────────────────────────────────────────

describe('normalize: the same thing is one row', () => {
  it('process names are lowercased', () => {
    expect(normalizeProcess('  Chrome.EXE ')).toBe('chrome.exe');
  });

  it('the www. of a domain is trimmed', () => {
    expect(normalizeDomain('WWW.YouTube.com')).toBe('youtube.com');
    expect(normalizeDomain('youtube.com.')).toBe('youtube.com');
  });

  /** `www.com` is a real domain: trimming blindly would turn it into `com` */
  it('nothing is trimmed if nothing would be left after www.', () => {
    expect(normalizeDomain('www.com')).toBe('www.com');
    expect(normalizeDomain('wwwx.com')).toBe('wwwx.com');
  });
});

describe('top apps and sites (D08)', () => {
  it('sorted largest to smallest, and ties give the same result every time', () => {
    const groups: UsageGroup[] = [
      { key: 'b.exe', categoryId: 1, seconds: 100, records: 1 },
      { key: 'a.exe', categoryId: 1, seconds: 100, records: 1 },
      { key: 'c.exe', categoryId: 1, seconds: 300, records: 1 },
    ];

    const first = foldUsage(groups, META, 'app').rows.map((r) => r.key);
    const again = foldUsage([...groups].reverse(), META, 'app').rows.map((r) => r.key);

    expect(first).toEqual(['c.exe', 'a.exe', 'b.exe']);
    expect(again).toEqual(first);
  });

  it('case variants merge into one row', () => {
    const report = foldUsage(
      [
        { key: 'Code.exe', categoryId: 1, seconds: 2 * H, records: 3 },
        { key: 'code.exe', categoryId: 1, seconds: 1 * H, records: 2 },
      ],
      META,
      'app',
    );

    expect(report.distinctKeys).toBe(1);
    expect(report.rows[0].seconds).toBe(3 * H);
    expect(report.rows[0].records).toBe(5);
  });

  /**
   * This is the quietest trap in D08. The category of `chrome.exe` rows comes
   * from the domain rule (youtube.com, github.com). If the rule's display_name
   * were used as the app name, the list would say "YouTube, 5 hours", when it
   * is really the whole browser's time.
   */
  it('browser time is not shown under a domain rule\'s name', () => {
    const report = foldUsage(
      [
        { key: 'chrome.exe', categoryId: 4, seconds: 3 * H, records: 10 }, // YouTube
        { key: 'chrome.exe', categoryId: 3, seconds: 2 * H, records: 8 }, // GitHub
      ],
      META,
      'app',
    );

    expect(report.rows[0].label).toBe('chrome.exe');
    expect(report.rows[0].mixed).toBe(true);
    expect(report.rows[0].category).toBe('unproductive'); // 3 hours > 2 hours
    expect(report.rows[0].buckets.productiveSec).toBe(2 * H);
  });

  it('when it falls under a single process rule, the friendly name is used', () => {
    const report = foldUsage(
      [{ key: 'code.exe', categoryId: 1, seconds: H, records: 1 }],
      META,
      'app',
    );

    expect(report.rows[0].label).toBe('Visual Studio Code');
    expect(report.rows[0].mixed).toBe(false);
  });

  it('the site list shows the domain rule\'s name', () => {
    const report = foldUsage(
      [{ key: 'www.youtube.com', categoryId: 4, seconds: H, records: 1 }],
      META,
      'site',
    );

    expect(report.rows[0].key).toBe('youtube.com');
    expect(report.rows[0].label).toBe('YouTube');
  });

  /**
   * The percentage denominator is the total time, not the sum of the 10
   * shown. Otherwise the percentages would always add to 100 and the tail of
   * 300 sites would be invisible.
   */
  it('the sharePct denominator is the total time, not the sum of the top list', () => {
    const groups: UsageGroup[] = Array.from({ length: 20 }, (_, i) => ({
      key: `app${String(i).padStart(2, '0')}.exe`,
      categoryId: 1,
      seconds: 100,
      records: 1,
    }));

    const report = foldUsage(groups, META, 'app', 10);

    expect(report.totalSec).toBe(2000);
    expect(report.distinctKeys).toBe(20);
    expect(report.otherSec).toBe(1000);
    expect(report.rows[0].sharePct).toBe(5); // 100 / 2000, not 100 / 1000

    const shown = report.rows.reduce((sum, r) => sum + r.sharePct, 0);
    expect(shown).toBe(50); // not 100: the other half is outside the list
  });

  it('on an empty range everything is zero, and no share is NaN', () => {
    const report = foldUsage([], META, 'app');

    expect(report.rows).toEqual([]);
    expect(report.totalSec).toBe(0);
    expect(report.otherSec).toBe(0);
    expect(report.distinctKeys).toBe(0);
  });

  it('when every row is unknown the category is null, yet the list still comes', () => {
    const report = foldUsage(
      [{ key: 'unknown.exe', categoryId: null, seconds: 5 * H, records: 4 }],
      META,
      'app',
    );

    expect(report.rows[0].category).toBeNull();
    expect(report.rows[0].mixed).toBe(false);
    expect(report.rows[0].label).toBe('unknown.exe');
    expect(report.rows[0].buckets.unknownSec).toBe(5 * H);
  });

  it('an empty key is dropped, but does not create a blank row', () => {
    const report = foldUsage(
      [
        { key: '   ', categoryId: null, seconds: H, records: 1 },
        { key: 'code.exe', categoryId: 1, seconds: H, records: 1 },
      ],
      META,
      'app',
    );

    expect(report.distinctKeys).toBe(1);
  });

  it('does not break when limit is zero or negative', () => {
    const report = foldUsage(
      [{ key: 'code.exe', categoryId: 1, seconds: H, records: 1 }],
      META,
      'app',
      0,
    );

    expect(report.rows).toEqual([]);
    expect(report.otherSec).toBe(H); // all of it is outside the list
  });
});

// ── Team summary (D09) ───────────────────────────────────────────────────────

describe('team-based site summary (D09)', () => {
  const groups: TeamGroup[] = [
    { domain: 'youtube.com', employeeId: 1, categoryId: 4, seconds: 5 * H },
    { domain: 'www.youtube.com', employeeId: 2, categoryId: 4, seconds: 1 * H },
    { domain: 'github.com', employeeId: 1, categoryId: 3, seconds: 2 * H },
    { domain: 'github.com', employeeId: 2, categoryId: 3, seconds: 2 * H },
    { domain: 'github.com', employeeId: 3, categoryId: 3, seconds: 2 * H },
  ];

  it('the same site is one row, with or without www.', () => {
    const report = foldTeamSites(groups, META);
    const youtube = report.rows.find((r) => r.domain === 'youtube.com')!;

    expect(youtube.totalSec).toBe(6 * H);
    expect(youtube.employees).toBe(2);
  });

  /**
   * The real danger of D09: passing off one person's habit as "the team's".
   * If 5 of 6 hours belong to one person, without `employees` and
   * `topEmployeeSec` the owner would think the whole team is stuck on YouTube.
   */
  it('shows how much of it is which employee\'s', () => {
    const report = foldTeamSites(groups, META);
    const youtube = report.rows.find((r) => r.domain === 'youtube.com')!;

    expect(youtube.topEmployeeId).toBe(1);
    expect(youtube.topEmployeeSec).toBe(5 * H);

    const github = report.rows.find((r) => r.domain === 'github.com')!;
    expect(github.employees).toBe(3);
    expect(github.topEmployeeSec).toBe(2 * H); // an equal share, not one person's
  });

  it('topEmployeeId is the same every time even on equal time', () => {
    const tied: TeamGroup[] = [
      { domain: 'a.com', employeeId: 9, categoryId: 3, seconds: H },
      { domain: 'a.com', employeeId: 4, categoryId: 3, seconds: H },
    ];

    expect(foldTeamSites(tied, META).rows[0].topEmployeeId).toBe(4);
    expect(foldTeamSites([...tied].reverse(), META).rows[0].topEmployeeId).toBe(4);
  });

  it('sorted by time, and the percentage denominator is the total time', () => {
    const report = foldTeamSites(groups, META, 1);

    expect(report.rows[0].domain).toBe('github.com'); // 6 hours
    expect(report.totalSec).toBe(12 * H);
    expect(report.rows[0].sharePct).toBe(50);
    expect(report.otherSec).toBe(6 * H);
    expect(report.distinctDomains).toBe(2);
  });

  it('on an empty range everything is zero', () => {
    const report = foldTeamSites([], META);
    expect(report.rows).toEqual([]);
    expect(report.totalSec).toBe(0);
    expect(report.distinctDomains).toBe(0);
  });
});

// ── Rule patterns (D06) ──────────────────────────────────────────────────────

describe('pattern validation: stopping rules that would be silently dropped', () => {
  it('a good pattern raises no objection', () => {
    expect(patternProblem('process', 'code.exe')).toBeNull();
    expect(patternProblem('process', 'docker desktop.exe')).toBeNull();
    expect(patternProblem('domain', 'mail.google.com')).toBeNull();
    expect(patternProblem('domain', 'localhost')).toBeNull();
    expect(patternProblem('title_regex', '^Jira\\b')).toBeNull();
  });

  it('an empty pattern is rejected: compile() would silently drop it', () => {
    expect(patternProblem('domain', '   ')).not.toBeNull();
  });

  /** A full URL is never stored in `app_usage`, so such a rule would never match */
  it('a full URL in place of a domain is rejected', () => {
    expect(patternProblem('domain', 'https://youtube.com/watch')).not.toBeNull();
    expect(patternProblem('domain', 'youtube.com/feed')).not.toBeNull();
    expect(patternProblem('domain', 'watching videos')).not.toBeNull();
    expect(patternProblem('domain', 'youtube')).not.toBeNull();
  });

  it('a full path in place of a process is rejected', () => {
    expect(patternProblem('process', 'C:\\Program Files\\code.exe')).not.toBeNull();
  });

  /** A bad regex is silently dropped by `compile()`: the owner would never know */
  it('a broken regex is rejected', () => {
    expect(patternProblem('title_regex', '([unclosed')).not.toBeNull();
  });

  it('an overlong regex is rejected: it could block the event loop', () => {
    expect(patternProblem('title_regex', 'a'.repeat(201))).not.toBeNull();
    expect(patternProblem('title_regex', 'a'.repeat(200))).toBeNull();
  });
});

// ── Dates and ranges ─────────────────────────────────────────────────────────

describe('reading and writing work_date', () => {
  /**
   * `work_date` is a `@db.Date`: the work-zone date, stored as UTC midnight.
   * Applying a timezone again here would shift every date by a day, and that
   * would show only on some servers.
   */
  it('dates are written as UTC, not by the server\'s timezone', () => {
    expect(toDateKey(new Date(Date.UTC(2026, 7, 9)))).toBe('2026-08-09');
    expect(toDateKey(parseWorkDate('2026-01-01'))).toBe('2026-01-01');
    expect(toDateKey(parseWorkDate('2026-12-31'))).toBe('2026-12-31');
  });

  it('a wrong format is rejected', () => {
    expect(() => parseWorkDate('2026-8-9')).toThrow(RangeError);
    expect(() => parseWorkDate('09-08-2026')).toThrow(RangeError);
    expect(() => parseWorkDate('')).toThrow(RangeError);
  });

  /** `Date.UTC(2026, 1, 31)` silently becomes 3 March: it is checked back */
  it('a non-existent date does not silently roll over', () => {
    expect(() => parseWorkDate('2026-02-31')).toThrow(RangeError);
    expect(() => parseWorkDate('2026-13-01')).toThrow(RangeError);
    expect(() => parseWorkDate('2026-00-10')).toThrow(RangeError);
  });

  it('29 February of a leap year is valid, but not in an ordinary year', () => {
    expect(toDateKey(parseWorkDate('2028-02-29'))).toBe('2028-02-29');
    expect(() => parseWorkDate('2026-02-29')).toThrow(RangeError);
  });
});

describe('resolving the range', () => {
  const today = parseWorkDate('2026-08-11');

  it('with nothing given, from the 1st of the current month to today', () => {
    const range = resolveRange(undefined, undefined, today);

    expect(toDateKey(range.from)).toBe('2026-08-01');
    expect(toDateKey(range.to)).toBe('2026-08-11');
    expect(range.days).toBe(11);
  });

  it('given the same day, the range is one day, not zero', () => {
    expect(resolveRange('2026-08-11', '2026-08-11', today).days).toBe(1);
  });

  it('a reversed range is rejected, or an empty report would silently come back', () => {
    expect(() => resolveRange('2026-08-11', '2026-08-01', today)).toThrow(RangeError);
  });

  it('a very long range is rejected: one typo would scan the whole table', () => {
    expect(() => resolveRange('2000-01-01', '2026-08-11', today)).toThrow(RangeError);
  });

  it('given only from, to is today', () => {
    const range = resolveRange('2026-08-05', undefined, today);
    expect(toDateKey(range.to)).toBe('2026-08-11');
    expect(range.days).toBe(7);
  });

  it('an empty string is treated as "not given"', () => {
    // writing `?from=&to=` in the query string makes express give an empty string
    const range = resolveRange('', '', today);
    expect(toDateKey(range.from)).toBe('2026-08-01');
    expect(toDateKey(range.to)).toBe('2026-08-11');
  });
});

/** For matching percentages in tests: the rounding rule is the same as in the code */
function round(fraction: number): number {
  return Math.round(fraction * 100 * 100) / 100;
}
