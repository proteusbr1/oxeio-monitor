import { describe, expect, it } from 'vitest';

import {
  KNOWN_JOB_FROM,
  designIdOf,
  designFirstSeenInDay,
  dailyCompletionCap,
  designTargetOf,
  designView,
  hasDesignTarget,
  keepKnownLongIds,
} from '../src/summary/design.rules';

/**
 * **Daily design counting** (21 August 2026).
 *
 * The two most important claims in this file: nothing is read except from a
 * design app (otherwise a browser title would one day slip in as a design —
 * exactly the content reading the README says is "never" done), and only
 * designers have a target.
 *
 * The samples are not invented — they come from the field `app_usage` of
 * 19-21 August.
 */

describe('designIdOf — job number from a title', () => {
  /** Real titles from the field */
  it.each([
    ['37933-Woodcock Bird Vintage Illustration T-Shirt.ai @ 54 % (RGB/Preview)', '37933'],
    ['37904Love Cockatiel Women Parrot for Bird Lovers T-Shirt.ai', '37904'],
    ['3218-Bruh It\'s My 7th Birthday 7 Year Old Bday Kids T-Shirt.ai', '3218'],
    ['37769......Green Cheek Conure Retro T-Shirt.ai', '37769'],
  ])('%s → %s', (title, id) => {
    expect(designIdOf('Illustrator.exe', title)).toBe(id);
  });

  /**
   * Allow-list: a new app never comes under reading by itself. If this test
   * breaks, someone has probably turned it into a deny-list.
   */
  it('nothing is read except from design apps', () => {
    for (const app of ['chrome.exe', 'ms-teams.exe', 'explorer.exe', 'notepad.exe']) {
      expect(designIdOf(app, '37933-Something.ai')).toBeNull();
    }
  });

  it('the app name works in any letter case', () => {
    expect(designIdOf('ILLUSTRATOR.EXE', '1234-x.ai')).toBe('1234');
    expect(designIdOf('Photoshop.exe', '1234-x.psd')).toBe('1234');
  });

  /**
   * Work-in-progress files are not counted: `Untitled-1*` means not saved yet,
   * and `Template.ai` is opened every day. Both drop out automatically
   * because they do not start with a digit.
   */
  it.each([
    'Untitled-1* @ 16.67 % (RGB/Preview)',
    'Template.ai* @ 33.33 % (RGB/Preview)',
    'My Custom T-shirt Designing Template.ai*',
    'Raccoon.psd @ 66.7% (Layer 0, RGB/8#)',
    'Vegetable_turkey_t-shirt_design_202608201646_upscayl_4x_real',
  ])('preparation files are excluded — %s', (title) => {
    expect(designIdOf('Illustrator.exe', title)).toBeNull();
  });

  /** `4 [Converted].eps` exists in the field — a one-digit number is not a job number */
  /**
   * Seven-digit job numbers (22 August 2026) — the target serial numbers
   * start from 1,000,000.
   *
   * With the old rule (`/^(\d{3,6})/`, no boundary) these were cut off at the
   * first six digits, and ten consecutive jobs collapsed into one number. The
   * second test below guards against that mistake.
   */
  it.each([
    ['1000042-Bird Vintage T-Shirt.ai @ 54 % (RGB/Preview)', '1000042'],
    ['1000299-Cat Retro.psd', '1000299'],
    ['1000000-First One.ai', '1000000'],
  ])('seven-digit job number — %s → %s', (title, id) => {
    expect(designIdOf('Illustrator.exe', title)).toBe(id);
  });

  /** Two consecutive jobs must stay separate — that was the real damage */
  it('consecutive job numbers do not merge', () => {
    const a = designIdOf('Illustrator.exe', '1000042-Bird.ai');
    const b = designIdOf('Illustrator.exe', '1000043-Cat.ai');
    expect(a).toBe('1000042');
    expect(b).toBe('1000043');
    expect(a).not.toBe(b);
  });

  /**
   * Eight or more digits = a stock file id, not a job number.
   *
   * In the field these created 66 wrong rows in `design_credits` —
   * `10163372_181` became `101633` and was counted as a design.
   */
  it.each([
    '10163372_181_Vector.eps',
    '136482370_79_stock.ai',
    '20260820164512_export.psd',
  ])('8+ digit stock ids are excluded — %s', (title) => {
    expect(designIdOf('Illustrator.exe', title)).toBeNull();
  });

  it('not fewer than three digits', () => {
    expect(designIdOf('Illustrator.exe', '4 [Converted].eps')).toBeNull();
    expect(designIdOf('Illustrator.exe', '99-x.ai')).toBeNull();
    expect(designIdOf('Illustrator.exe', '100-x.ai')).toBe('100');
  });

  it('no crash when there is no title', () => {
    expect(designIdOf('Illustrator.exe', null)).toBeNull();
    expect(designIdOf('Illustrator.exe', '')).toBeNull();
  });
});

describe('designFirstSeenInDay — unique numbers and first instant', () => {
  const AT = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 6, h, m));

  /**
   * The same design is returned to many times a day — in the field, 1553
   * distinct titles across 3873 rows. Counting rows would make the number
   * meaningless.
   */
  it('the same number appearing many times counts once', () => {
    const rows = [
      { processName: 'Illustrator.exe', windowTitle: '37933-A.ai @ 54 %', startedAt: AT(5) },
      { processName: 'Illustrator.exe', windowTitle: '37933-A.ai @ 120 %', startedAt: AT(6) },
      { processName: 'Illustrator.exe', windowTitle: '37904-B.ai', startedAt: AT(7) },
      { processName: 'chrome.exe', windowTitle: '37905-C — Google Chrome', startedAt: AT(8) },
      { processName: 'Illustrator.exe', windowTitle: 'Untitled-3*', startedAt: AT(9) },
    ];

    expect([...designFirstSeenInDay(rows).keys()].sort()).toEqual([
      '37904',
      '37933',
    ]);
  });

  /**
   * The earliest instant is kept, not the last (G163).
   *
   * Rows can arrive in any order, so the later one is placed first here — a
   * naive "keep the last" would turn this red.
   */
  it('across several rows with the same number, the earliest instant wins', () => {
    const rows = [
      { processName: 'Illustrator.exe', windowTitle: '37933-A.ai', startedAt: AT(14) },
      { processName: 'Illustrator.exe', windowTitle: '37933-A.ai @ 54 %', startedAt: AT(9, 12) },
      { processName: 'Illustrator.exe', windowTitle: '37933-B.ai', startedAt: AT(11) },
    ];

    expect(designFirstSeenInDay(rows).get('37933')).toEqual(AT(9, 12));
  });

  it('empty when there is nothing', () => {
    expect(designFirstSeenInDay([]).size).toBe(0);
  });
});

describe('hasDesignTarget · designView', () => {
  /**
   * No staff type set means "leave out", not "zero". Otherwise, until the
   * type was set, everyone would show up in the list as "0/25" every day —
   * which is an accusation, not information.
   */
  it('only designers have a target', () => {
    expect(hasDesignTarget('designer')).toBe(true);
    expect(hasDesignTarget('researcher')).toBe(false);
    expect(hasDesignTarget('manager')).toBe(false);
    expect(hasDesignTarget(null)).toBe(false);
    expect(hasDesignTarget(undefined)).toBe(false);
  });

  /**
   * The owner's decision (22 August): the manager (OX-01) also designs —
   * 43 in three days. After the staff type changed, the number was vanishing
   * although the work was real. So the number is shown, without a target.
   */
  it('not a designer but did the work — the number is shown, no target', () => {
    expect(designView('manager', 43, 25)).toEqual({
      done: 43,
      target: null,
      met: false,
    });
    expect(designView('researcher', 3, 25)?.target).toBeNull();
  });

  /**
   * Without a target, `met` is never `true` — even if 43 > 25. The check mark
   * means "target reached", and they have no target.
   */
  it('someone without a target never gets the check mark', () => {
    expect(designView('manager', 999, 25)?.met).toBe(false);
  });

  /** If no work was done, show nothing — reading "0" feels like an accusation */
  it('nothing is shown when no design was done', () => {
    expect(designView('researcher', 0, 25)).toBeNull();
    expect(designView(null, 0, 25)).toBeNull();
    expect(designView('designer', 0, 0)).toBeNull();
  });

  /** A designer's target of 0 = off, so only the number is shown (no target) */
  it('when a designer\'s target is off, only the number', () => {
    expect(designView('designer', 12, 0)).toEqual({
      done: 12,
      target: null,
      met: false,
    });
  });

  /** Exactly on target = reached, consistent with the hours rule */
  it('exactly at the target = reached', () => {
    expect(designView('designer', 25, 25)).toEqual({
      done: 25,
      target: 25,
      met: true,
    });
    expect(designView('designer', 24, 25)?.met).toBe(false);
    expect(designView('designer', 39, 25)?.met).toBe(true);
  });
});

/**
 * With seven digits, the number must really have been allocated (22 August
 * 2026).
 *
 * Seven-digit stock ids exist too — in the field four came in on a single
 * day (`1536601`, `5005369`, `5524618`, `9937760`) and were being counted as
 * designs.
 */

describe('dailyCompletionCap — the most "done" allowed per day', () => {
  /**
   * The cap is the target number itself, not a separate constant.
   *
   * With two separate numbers, someone's target would one day be raised to 30
   * while the cap stayed at 25, making the target impossible to reach.
   */
  it('a designer\'s own target is the cap', () => {
    expect(dailyCompletionCap('designer', 30, 25)).toBe(30);
    expect(dailyCompletionCap('designer', null, 25)).toBe(25);
  });

  /**
   * The manager has no cap.
   *
   * In the field OX-01 does up to 44 a day and has no target at all. The
   * policy number (25) applies to them too, so the gate has to be on
   * `staffType`, not on the number.
   */
  it('no target means no cap — even with 25 in the policy', () => {
    expect(dailyCompletionCap('manager', null, 25)).toBeNull();
    expect(dailyCompletionCap('researcher', null, 25)).toBeNull();
    expect(dailyCompletionCap(null, null, 25)).toBeNull();
  });

  /**
   * 0 means "this person's target is off", not a penalty — `designTargetOf`
   * documents it as a valid decision. Treating the cap as 0 would stop them
   * finishing anything.
   */
  it('a target of 0 means no cap, not a cap of 0', () => {
    expect(dailyCompletionCap('designer', 0, 25)).toBeNull();
    expect(dailyCompletionCap('designer', null, 0)).toBeNull();
    expect(dailyCompletionCap('designer', null, null)).toBeNull();
  });
});

describe('keepKnownLongIds — long numbers must be on the list', () => {
  it('the threshold is one million', () => {
    expect(KNOWN_JOB_FROM).toBe(1_000_000);
  });

  it('a known job number is kept', () => {
    const kept = keepKnownLongIds(new Set(['1000042']), new Set(['1000042']));
    expect([...kept]).toEqual(['1000042']);
  });

  /** The real stock ids found in the field */
  it.each(['1536601', '5005369', '5524618', '9937760'])(
    'unknown long numbers are dropped — %s',
    (id) => {
      expect(keepKnownLongIds(new Set([id]), new Set()).size).toBe(0);
    },
  );

  /**
   * Six digits or fewer are outside this condition — old jobs (like 37933)
   * have no target row. Putting them under it would silently zero the whole
   * history. This test guards against that mistake.
   */
  it.each(['193', '3218', '37933', '973065'])(
    'short numbers are kept without the list — %s',
    (id) => {
      expect([...keepKnownLongIds(new Set([id]), new Set())]).toEqual([id]);
    },
  );

  it('in a mixed set only the unknown long ones are dropped', () => {
    const kept = keepKnownLongIds(
      new Set(['37933', '1000042', '5524618', '973065']),
      new Set(['1000042']),
    );
    expect([...kept].sort()).toEqual(['1000042', '37933', '973065']);
  });

  /** If the list is empty (the day before targets went live), all long numbers are dropped */
  it('with an empty list, long numbers are not kept', () => {
    expect(keepKnownLongIds(new Set(['1000042']), new Set()).size).toBe(0);
  });
});

describe('designTargetOf — whose target is how much', () => {
  /**
   * What the owner wanted (in his own words in the schema): everyone has a
   * daily target of 25, and one designer has a daily target of 15.
   *
   * The column was created long ago, but nobody read it and nobody wrote it;
   * `policy?.dailyDesignTarget ?? 0` was hand-written in three places. On 23
   * August 2026 the rule was moved to one place, and this test guards it.
   */
  it('a person\'s own number wins when they have one', () => {
    expect(designTargetOf(15, 25)).toBe(15);
  });

  it('the policy\'s number applies when they have none', () => {
    expect(designTargetOf(null, 25)).toBe(25);
    expect(designTargetOf(undefined, 25)).toBe(25);
  });

  /**
   * The most important test. Writing `||` instead of `??` would break it, and
   * if that went unnoticed the owner could not switch off someone's target:
   * even after setting 0, the policy's 25 would silently come back.
   */
  it('0 means "target off" — it does not fall back to the policy', () => {
    expect(designTargetOf(0, 25)).toBe(0);
  });

  /** With no policy either, 0 — meaning no target, and `designView` then shows no cell */
  it('0 when neither exists', () => {
    expect(designTargetOf(null, null)).toBe(0);
    expect(designTargetOf(undefined, undefined)).toBe(0);
  });

  /** The policy's 0 is also respected — "everyone's target off" is a valid decision */
  it('a 0 in the policy applies too', () => {
    expect(designTargetOf(null, 0)).toBe(0);
  });
});
