import { describe, expect, it } from 'vitest';

import { UserRole } from '@prisma/client';

import {
  allocationSizes,
  amazonUrl,
  asinOf,
  canUseTargets,
  JOB_NUMBER_START,
  MAX_ISSUED_PER_DAY,
  parseBulk,
  topUpSize,
} from '../src/targets/targets.rules';

/**
 * **Design targets.**
 *
 * The single most important claim of this file: **different URLs of the same
 * product must not become different targets**. If they did, three designers
 * would make designs for the same product — three days of work wasted, and
 * nobody could tell.
 */

describe('asinOf — identity from a URL', () => {
  /** Field samples (supplied by the owner) and the familiar forms around them */
  it.each([
    ['https://www.amazon.com/dp/B0DJBD22LW', 'B0DJBD22LW'],
    ['https://www.amazon.com/dp/B0DJBD22LW/', 'B0DJBD22LW'],
    [
      'https://www.amazon.com/Funny-Cat-Shirt/dp/B0DJBD22LW/ref=sr_1_3?keywords=cat',
      'B0DJBD22LW',
    ],
    ['https://www.amazon.com/gp/product/B0DJBD22LW?th=1', 'B0DJBD22LW'],
    ['https://www.amazon.com/gp/aw/d/B0DJBD22LW', 'B0DJBD22LW'],
    // The same ASIN is the same in every country — the TLD is not pinned
    ['https://www.amazon.co.uk/dp/B0DJBD22LW', 'B0DJBD22LW'],
    ['https://amazon.de/dp/b0djbd22lw', 'B0DJBD22LW'],
    // Pasting a bare ASIN works too — people sometimes do that
    ['B0DJBD22LW', 'B0DJBD22LW'],
  ])('%s → %s', (url, asin) => {
    expect(asinOf(url)).toEqual({ asin });
  });

  /**
   * **This is the foundation of the whole scheme** — three different URLs, one ASIN.
   */
  it('three URL forms of the same product give the same identity', () => {
    const forms = [
      'https://www.amazon.com/dp/B0DJBD22LW',
      'https://www.amazon.com/Funny-Cat/dp/B0DJBD22LW/ref=sr_1_3',
      'https://www.amazon.com/gp/product/B0DJBD22LW?th=1',
    ];

    const asins = new Set(forms.map((f) => (asinOf(f) as { asin: string }).asin));
    expect(asins.size).toBe(1);
  });

  /**
   * An ASIN **cannot** be extracted from a short link — the only way is to ask
   * Amazon, and this product does not call outside sites from the server. So it
   * is a distinct reason, so the screen can say what to do.
   */
  it.each(['https://amzn.to/3xYzAbC', 'https://a.co/d/abc123'])(
    'short link rejected with its own reason — %s',
    (url) => {
      expect(asinOf(url)).toEqual({ reason: 'short_link' });
    },
  );

  it('a link that is not Amazon', () => {
    expect(asinOf('https://etsy.com/listing/123456')).toEqual({
      reason: 'not_amazon',
    });
  });

  /** Not every Amazon URL has an ASIN (search pages, categories) */
  it('Amazon but without an ASIN', () => {
    expect(asinOf('https://www.amazon.com/s?k=cat+t-shirt')).toEqual({
      reason: 'no_asin',
    });
  });

  it('an empty line does not crash', () => {
    expect(asinOf('   ')).toEqual({ reason: 'no_asin' });
  });
});

describe('amazonUrl — address from an ASIN', () => {
  /**
   * The owner's rule: any ASIN can simply be put after `/dp/` and the problem
   * is over. So the original URL is **not stored** — keeping it would leave two
   * forms of the same thing in the table (one with `?th=1`, another with
   * `ref=sr_1_3`).
   */
  it('builds the normal address', () => {
    expect(amazonUrl('B0DJBD22LW')).toBe('https://www.amazon.com/dp/B0DJBD22LW');
  });

  /** Pasted in any form, the same single address comes back */
  it('whichever way it is pasted, the address is the same', () => {
    const forms = [
      'https://www.amazon.com/Funny-Cat/dp/B0DJBD22LW/ref=sr_1_3',
      'https://www.amazon.co.uk/gp/product/B0DJBD22LW?th=1',
      'b0djbd22lw',
    ];

    const urls = new Set(
      forms.map((f) => amazonUrl((asinOf(f) as { asin: string }).asin)),
    );
    expect([...urls]).toEqual(['https://www.amazon.com/dp/B0DJBD22LW']);
  });
});

describe('parseBulk — 500 at once', () => {
  /**
   * **Duplicates inside the paste are caught too.** The same product coming
   * from two different searches is very common, and uncaught it would stall the database insert.
   */
  it('if the same ASIN appears twice, the second is rejected', () => {
    const { accepted, rejected } = parseBulk(
      [
        'https://www.amazon.com/dp/B0DJBD22LW',
        'https://www.amazon.com/gp/product/B0DJBD22LW',
        'https://www.amazon.com/dp/B0AAAA1111',
      ].join('\n'),
    );

    expect(accepted.map((a) => a.asin)).toEqual(['B0DJBD22LW', 'B0AAAA1111']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('duplicate_in_paste');
    // Line numbers count from 1 — they are shown on screen
    expect(rejected[0].line).toBe(2);
  });

  /** An empty line is **not an error** — a 500-line paste always has some */
  it('empty lines are silently skipped, not in the rejected list', () => {
    const { accepted, rejected } = parseBulk(
      '\n\nhttps://www.amazon.com/dp/B0DJBD22LW\n\n   \n',
    );

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  /**
   * **Failed lines are not dropped, they are returned — with the reason.**
   * If 7 of 500 are rejected, the researcher needs to know which 7; otherwise
   * they could not collect them again.
   */
  it('a rejection carries the line, the text and the reason — all three', () => {
    const { rejected } = parseBulk('https://etsy.com/listing/1\nhttps://amzn.to/x');

    expect(rejected).toEqual([
      { line: 1, text: 'https://etsy.com/listing/1', reason: 'not_amazon' },
      { line: 2, text: 'https://amzn.to/x', reason: 'short_link' },
    ]);
  });

  it('works with 500 lines too', () => {
    const lines = Array.from(
      { length: 500 },
      (_, i) => `https://www.amazon.com/dp/B${String(i).padStart(9, '0')}`,
    );

    expect(parseBulk(lines.join('\n')).accepted).toHaveLength(500);
  });
});

describe('JOB_NUMBER_START', () => {
  /**
   * **A number measured in the field, not picked.** In the designers' files the
   * largest number now is **973,065** (six digits); there is not a single
   * seven-digit one. If this constant fell below that, some old file would be
   * wrongly reported as "finished" — and the mistake would be silent.
   */
  it('above the largest number seen in the field', () => {
    expect(JOB_NUMBER_START).toBeGreaterThan(973_065);
  });
});

describe('topUpSize — how many still to give today', () => {
  const T = 25;
  const at = (completedToday: number, openCount: number, issuedToday = 0) =>
    topUpSize({
      staffType: 'designer',
      completedToday,
      openCount,
      issuedToday,
      dailyTarget: T,
    });

  /**
   * **The state the owner described** — hand completely empty.
   *
   * With the 30:25 ratio the full 30 comes back, just like the morning allocation.
   */
  it('hand empty, nothing finished → the full 30', () => {
    expect(at(0, 0)).toBe(30);
  });

  /**
   * **This is the real working state.** Skip 20, finish 10 and the hand is
   * empty — 15 more are needed to reach the target, and 18 including room for skips.
   */
  it('10 finished, hand empty → 18 for the remaining 15', () => {
    expect(at(10, 0)).toBe(18);
  });

  /**
   * **Nothing is given when the hand is full** — and in the field this is the
   * normal state: on 7 and 8 September everyone held 17–29.
   */
  it('enough in hand → 0', () => {
    expect(at(0, 30)).toBe(0);
    expect(at(10, 20)).toBe(0);
  });

  /** Something in hand but still not enough — only the shortfall is given */
  it('5 in hand, 18 needed → the remaining 13', () => {
    expect(at(10, 5)).toBe(13);
  });

  /**
   * **Once the target is reached, nothing more** — otherwise the two rules would
   * cancel each other: the limit says "stop finishing", and this would pour in more work.
   */
  it('target already reached → 0, even if the hand is empty', () => {
    expect(at(25, 0)).toBe(0);
    expect(at(32, 0)).toBe(0);
  });

  /** Someone with no target (a manager) — the morning allocation is enough */
  it('target 0 → nothing is ever given', () => {
    expect(topUpSize({ staffType: 'designer', completedToday: 0, openCount: 0, issuedToday: 0, dailyTarget: 0 })).toBe(0);
  });


  /**
   * **The gate is inside the function, not in the caller.**
   *
   * `DESIGN_WORK_STAFF_TYPES` includes the manager, so they get the morning
   * allocation too — and `designTargetOf()` returns the policy's **25** for them
   * as well. With the gate in the caller, someone would one day forget it, and
   * a manager who does 44 a day in the field would silently become a designer
   * with a target of 25.
   */
  it('no top-up for a manager — whatever the target number', () => {
    expect(
      topUpSize({
        staffType: 'manager',
        completedToday: 0,
        openCount: 0,
        issuedToday: 0,
        dailyTarget: 25,
      }),
    ).toBe(0);
  });

  /**
   * **The daily ceiling — otherwise every Skip would be refilled one by one.**
   *
   * 30 in hand, nothing finished → want 30 → give 0. Skip one and the hand is
   * 29 → give 1 again, skip again → 1 again. Without a ceiling someone could
   * churn through the whole pool in one day.
   */
  it('one Skip brings back exactly one, and nothing once the ceiling is used up', () => {
    // 29 in hand, nothing finished → shortfall 1
    expect(at(0, 29)).toBe(1);
    // 60 already given today — the ceiling is used up
    expect(at(0, 29, MAX_ISSUED_PER_DAY)).toBe(0);
  });

  it('near the ceiling, only what is left', () => {
    expect(at(10, 0, MAX_ISSUED_PER_DAY - 4)).toBe(4);
  });

  /** The ratio changes with the target, 1.2 is not a constant */
  it('with a target of 30 the ratio moves with it', () => {
    expect(topUpSize({ staffType: 'designer', completedToday: 0, openCount: 0, issuedToday: 0, dailyTarget: 30 })).toBe(30);
    expect(topUpSize({ staffType: 'designer', completedToday: 15, openCount: 0, issuedToday: 0, dailyTarget: 30 })).toBe(15);
  });
});

describe('allocationSizes — who gets how many', () => {
  /** Excluding targets already in hand — otherwise two hundred would pile up in a week */
  it('30 is filled up after excluding what is in hand', () => {
    const sizes = allocationSizes(
      [
        { employeeId: 1, openCount: 0 },
        { employeeId: 2, openCount: 22 },
        { employeeId: 3, openCount: 30 },
      ],
      1000,
    );

    expect(sizes.get(1)).toBe(30);
    expect(sizes.get(2)).toBe(8);
    // Someone whose hand is full gets no row at all — no point sending "0"
    expect(sizes.has(3)).toBe(false);
  });

  /**
   * **When the pool runs out, as many as there are** — and the order is the one
   * the caller supplies (employee code), not random. On a shortage day it must
   * be predictable who gets them, otherwise a different person would be left out
   * each day and nobody could say why.
   */
  it('when the pool is short, as many as possible in order', () => {
    const sizes = allocationSizes(
      [
        { employeeId: 1, openCount: 0 },
        { employeeId: 2, openCount: 0 },
      ],
      40,
    );

    expect(sizes.get(1)).toBe(30);
    expect(sizes.get(2)).toBe(10);
  });

  it('when the pool is empty, nobody gets anything', () => {
    expect(allocationSizes([{ employeeId: 1, openCount: 0 }], 0).size).toBe(0);
  });

  /** No crash even with no designers */
  it('empty when there is nobody', () => {
    expect(allocationSizes([], 500).size).toBe(0);
  });
});


/**
 * **Who may use the targets part.**
 *
 * The real job of this describe is **guarding the allow-list**. If the rule
 * ever goes back to a `role !== employee` shape, the **next** new `UserRole`
 * value would slip in silently — just as `researcher` slipped into screenshots
 * and pay adjustments when it was added.
 * So below, **who may not** is written down too, not only who may.
 */
describe('canUseTargets — who may touch the targets part', () => {
  it('the owner may', () => {
    expect(canUseTargets(UserRole.owner)).toBe(true);
  });

  it('a manager may', () => {
    expect(canUseTargets(UserRole.manager)).toBe(true);
  });

  it('a researcher may — this is the whole change', () => {
    expect(canUseTargets(UserRole.researcher)).toBe(true);
  });

  /**
   * **The most important claim.** A designer does not see the whole team's pool —
   * they see their own 30 in `/me/targets`. If this broke, nine designers could
   * suddenly see and change each other's work.
   */
  it('a designer (employee) may not', () => {
    expect(canUseTargets(UserRole.employee)).toBe(false);
  });

  /**
   * This measures whether the rule really is an allow-list. Every `UserRole`
   * value is walked through, and those not in the list **must** be `false`. If
   * someone changes the rule to `!== employee`, this test turns red at once —
   * before a new enum value is ever added, not on the day it is.
   */
  it('every role outside the list is "no"', () => {
    const allowed = new Set<string>([
      UserRole.owner,
      UserRole.manager,
      UserRole.researcher,
    ]);

    for (const role of Object.values(UserRole)) {
      expect(canUseTargets(role)).toBe(allowed.has(role));
    }
  });
});
