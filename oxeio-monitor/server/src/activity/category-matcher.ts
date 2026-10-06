import type { MatchType, Productivity } from '@prisma/client';

/**
 * Classify an app/site as productive, neutral or unproductive (D05).
 * A pure function with no I/O.
 *
 * It lives in its own file for the same reason as
 * [payroll.math.ts](../payroll/payroll.math.ts): this decision ends up in
 * reports as "who worked how much", and it could not be tested in isolation if
 * it were mixed with the database.
 *
 * Careful: **categories never enter pay calculations.** Money depends only on
 * seconds ([09 § 4](../../../../docs/09-Build-Log.md)). Someone who is
 * "unproductive" all day still has no hours deducted; this is information, not
 * punishment.
 */

export interface CategoryRule {
  id: number;
  matchType: MatchType;
  pattern: string;
  displayName: string;
  category: Productivity;
  /** Careful: **the smaller number wins**; see compile() below. */
  priority: number;
}

export interface CompiledRule extends CategoryRule {
  /** Lower-case pattern for process/domain. */
  needle: string;
  /** For title_regex; otherwise null. */
  regex: RegExp | null;
}

/** What the decision is based on: three fields of one `app_usage` row. */
export interface UsageFacts {
  processName: string;
  domain?: string | null;
  windowTitle?: string | null;
}

/**
 * Careful: `title_regex` is written by the owner (D06), and JavaScript regex has
 * no timeout, so catastrophic backtracking would block the whole Node event
 * loop. Two safeguards: keep patterns short, and the title is already capped at
 * 1000 characters (`AppUsageDto`). Neither is a complete fix, so this match
 * type is not used in the seed, and rules are audited when added in D06.
 */
export const MAX_REGEX_LENGTH = 200;

/**
 * Sort and compile the rules once. Matching takes only the **first hit**, so
 * the sort order is the real decision.
 *
 * **Order: priority asc, then pattern length desc, then id asc.**
 *
 * 1. **priority: the smaller number comes first.** In the seed, browsers have
 *    priority 200 and everything else 100. Reversed, `chrome.exe` (neutral)
 *    would always win and **every browsing minute would become neutral**,
 *    youtube.com and github.com alike. That defeats the whole purpose of D05,
 *    and no error would show anywhere.
 *
 * 2. **length: the longer pattern comes first**, i.e. the more specific one.
 *    `mail.google.com` (productive) and `google.com` (neutral) both match
 *    Gmail; if the specific one did not win, Gmail would be "neutral".
 *
 * 3. **id: only for determinism.** On a tie the result stays the same each
 *    time; otherwise categorizing the same row twice could give two results.
 */
export function compile(rules: readonly CategoryRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];

  for (const rule of rules) {
    const needle = rule.pattern.trim().toLowerCase();
    if (needle.length === 0) continue;

    let regex: RegExp | null = null;

    if (rule.matchType === 'title_regex') {
      if (rule.pattern.length > MAX_REGEX_LENGTH) continue;

      try {
        regex = new RegExp(rule.pattern, 'i');
      } catch {
        // Careful: a bad regex must not break ingest; skipping one rule does far
        // less harm. The skipped rule is reported in the service log.
        continue;
      }
    }

    compiled.push({ ...rule, needle, regex });
  }

  return compiled.sort(
    (a, b) =>
      a.priority - b.priority ||
      b.needle.length - a.needle.length ||
      a.id - b.id,
  );
}

/** `null` if nothing matches; an unknown app is never forced into a category. */
export function matchCategory(
  rules: readonly CompiledRule[],
  facts: UsageFacts,
): CompiledRule | null {
  const process = facts.processName?.trim().toLowerCase() ?? '';
  const domain = facts.domain?.trim().toLowerCase() ?? '';
  const title = facts.windowTitle ?? '';

  for (const rule of rules) {
    switch (rule.matchType) {
      case 'process':
        if (process.length > 0 && process === rule.needle) return rule;
        break;

      case 'domain':
        if (domain.length > 0 && domainMatches(domain, rule.needle)) return rule;
        break;

      case 'title_regex':
        if (title.length > 0 && rule.regex?.test(title) === true) return rule;
        break;
    }
  }

  return null;
}

/**
 * Whether the domain matches, either exactly or as a subdomain.
 *
 * Careful: **plain `includes()` or `endsWith()` is not enough.**
 * `endsWith('google.com')` would also make `notgoogle.com` and
 * `evilgoogle.com` count as "Google". So the match must fall on a **label
 * boundary**: `mail.google.com` yes, `notgoogle.com` no.
 *
 * This way an `atlassian.net` rule also works for `acme.atlassian.net`, which
 * is needed because each company's Jira lives on its own subdomain.
 */
function domainMatches(domain: string, pattern: string): boolean {
  if (domain === pattern) return true;

  return (
    domain.length > pattern.length + 1 &&
    domain.endsWith(pattern) &&
    domain[domain.length - pattern.length - 1] === '.'
  );
}
