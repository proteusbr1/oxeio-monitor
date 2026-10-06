import { describe, expect, it } from 'vitest';

import {
  compile,
  matchCategory,
  type CategoryRule,
} from '../src/activity/category-matcher';

/**
 * D05: category matching.
 *
 * Most of what is verified here is silent mistakes: if the order is reversed
 * or a subdomain boundary is wrong, no error appears anywhere, only the
 * report numbers go wrong, and nobody can catch that.
 */

let nextId = 1;

function rule(
  matchType: CategoryRule['matchType'],
  pattern: string,
  category: CategoryRule['category'],
  priority = 100,
): CategoryRule {
  return {
    id: nextId++,
    matchType,
    pattern,
    displayName: pattern,
    category,
    priority,
  };
}

const CHROME = rule('process', 'chrome.exe', 'neutral', 200);
const YOUTUBE = rule('domain', 'youtube.com', 'unproductive');
const GOOGLE = rule('domain', 'google.com', 'neutral');
const GMAIL = rule('domain', 'mail.google.com', 'productive');
const JIRA = rule('domain', 'atlassian.net', 'productive');
const EXCEL = rule('process', 'excel.exe', 'productive');

const RULES = compile([CHROME, YOUTUBE, GOOGLE, GMAIL, JIRA, EXCEL]);

const match = (facts: {
  processName: string;
  domain?: string | null;
  windowTitle?: string | null;
}) => matchCategory(RULES, facts);

describe('category matcher: order', () => {
  /**
   * The most important test. If the order were reversed, `chrome.exe`
   * (neutral) would always win, and every browsing minute would become
   * neutral, youtube.com and github.com alike. D05 would then separate
   * nothing.
   */
  it('a domain rule beats the browser process', () => {
    const hit = match({ processName: 'chrome.exe', domain: 'youtube.com' });

    expect(hit?.category).toBe('unproductive');
    expect(hit?.displayName).toBe('youtube.com');
  });

  /** The more specific one first, or Gmail would become a "neutral search engine". */
  it('a more specific domain beats a less specific one', () => {
    expect(
      match({ processName: 'chrome.exe', domain: 'mail.google.com' })?.category,
    ).toBe('productive');

    expect(
      match({ processName: 'chrome.exe', domain: 'www.google.com' })?.category,
    ).toBe('neutral');
  });

  it('when the domain cannot be read, the browser\'s own rule stays', () => {
    // Reading the URL failed: all we know is "it was in the browser"
    const hit = match({ processName: 'chrome.exe', domain: null });

    expect(hit?.category).toBe('neutral');
    expect(hit?.displayName).toBe('chrome.exe');
  });

  it('the same input gives the same result every time', () => {
    const shuffled = compile([GMAIL, CHROME, JIRA, GOOGLE, YOUTUBE, EXCEL]);
    const facts = { processName: 'chrome.exe', domain: 'mail.google.com' };

    expect(matchCategory(shuffled, facts)?.id).toBe(
      matchCategory(RULES, facts)?.id,
    );
  });
});

describe('category matcher: domain boundaries', () => {
  it('a subdomain matches', () => {
    // Every company's Jira is on a different subdomain; otherwise the rule is useless
    expect(
      match({ processName: 'chrome.exe', domain: 'acme.atlassian.net' })
        ?.category,
    ).toBe('productive');
  });

  /**
   * A plain `endsWith()` would make these "Google" too. Someone could create
   * `notgoogle.com` on purpose to confuse the report.
   */
  it.each(['notgoogle.com', 'evilgoogle.com', 'xgoogle.com'])(
    '%s is not treated as google.com',
    (domain) => {
      expect(match({ processName: 'chrome.exe', domain })?.displayName).not.toBe(
        'google.com',
      );
    },
  );

  it('matching is from the end: youtube.com.bd is a different site', () => {
    // The domain rule did not match, so it stays on the browser's own rule
    const hit = match({ processName: 'chrome.exe', domain: 'youtube.com.bd' });

    expect(hit?.displayName).toBe('chrome.exe');
    expect(hit?.category).toBe('neutral');
  });

  it('upper and lower case make no difference', () => {
    expect(
      match({ processName: 'CHROME.EXE', domain: 'YouTube.COM' })?.category,
    ).toBe('unproductive');
  });
});

describe('category matcher: what does not match', () => {
  /**
   * An unknown app is not forced to neutral. null means "don't know", neutral
   * means "know, and neutral". Mixing them would silently count unknown apps
   * in the good direction in the D07 score.
   */
  it('an unknown app stays null', () => {
    expect(match({ processName: 'unknown-thing.exe' })).toBeNull();
  });

  it('process rules work even for disguised browsing', () => {
    // domain and title are both null: DomainParser.LooksPrivate stripped them
    const hit = match({
      processName: 'chrome.exe',
      domain: null,
      windowTitle: null,
    });

    expect(hit?.category).toBe('neutral');
  });

  it('nothing matches an empty process name', () => {
    expect(match({ processName: '' })).toBeNull();
  });
});

describe('category matcher: title_regex', () => {
  const TITLE = rule('title_regex', 'Figma$', 'productive');
  const withTitle = compile([TITLE, CHROME]);

  it('a matching title is picked up', () => {
    expect(
      matchCategory(withTitle, {
        processName: 'chrome.exe',
        windowTitle: 'Dashboard — Figma',
      })?.category,
    ).toBe('productive');
  });

  it('a non-matching title is not picked up', () => {
    expect(
      matchCategory(withTitle, {
        processName: 'chrome.exe',
        windowTitle: 'Dashboard — Sketch',
      })?.displayName,
    ).toBe('chrome.exe');
  });

  /**
   * If a bad regex broke ingest, the whole batch's data would be lost.
   * Dropping one rule is far less harm.
   */
  it('a bad regex is silently dropped, and ingest does not break', () => {
    const bad = rule('title_regex', '(((', 'productive');
    const compiled = compile([bad, EXCEL]);

    expect(compiled).toHaveLength(1);
    expect(
      matchCategory(compiled, { processName: 'excel.exe' })?.category,
    ).toBe('productive');
  });

  it('an overlong regex is not accepted', () => {
    // ReDoS risk: JavaScript cannot time out a regex
    const huge = rule('title_regex', 'a'.repeat(300), 'productive');

    expect(compile([huge])).toHaveLength(0);
  });
});

describe('category matcher: non-browser apps', () => {
  it('the process name must match exactly', () => {
    expect(match({ processName: 'excel.exe' })?.category).toBe('productive');
    expect(match({ processName: 'myexcel.exe' })).toBeNull();
    expect(match({ processName: 'excel' })).toBeNull();
  });

  it('without a domain, the process rule applies', () => {
    // The agent never sends a domain for non-browsers
    // (ForegroundWindowProbe: `RawUrl = isBrowser ? … : null`)
    expect(
      match({ processName: 'excel.exe', domain: null })?.displayName,
    ).toBe('excel.exe');
  });
});
