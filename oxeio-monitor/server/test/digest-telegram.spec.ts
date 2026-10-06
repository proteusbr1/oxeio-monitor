import { describe, expect, it } from 'vitest';

import type { Digest, DigestRow } from '../src/digest/digest.math';
import {
  asPreBlock,
  escapeHtml,
  hm,
  telegramDigest,
} from '../src/digest/digest.telegram';

/**
 * **The daily report, as it looks on Telegram** (18 August 2026).
 *
 * The two most important tests in this file: nobody is silently dropped (if
 * the numbers do not add up it looks like "agent broken"), and the list is
 * not sorted by hours — otherwise the message would become a leaderboard
 * every evening.
 */

const EXTRAS = { silentPcs: 0, atTime: '18:30' };

function row(over: Partial<DigestRow> = {}): DigestRow {
  return {
    employeeId: 1,
    empCode: 'OX-01',
    fullName: 'One',
    todayHours: 8,
    todayTargetHours: 8,
    offToday: false,
    idleToday: false,
    monthHours: 100,
    expectedHours: 100,
    paceHours: 0,
    behind: false,
    ...over,
  };
}

function digestOf(rows: DigestRow[], over: Partial<Digest> = {}): Digest {
  return {
    workDate: '2026-08-18',
    monthFrom: '2026-08-01',
    monthTo: '2026-08-18',
    rows,
    behind: rows.filter((r) => r.behind),
    idle: rows.filter((r) => r.idleToday),
    totals: {
      employees: rows.length,
      workedToday: rows.filter((r) => r.todayHours > 0).length,
      hoursToday: rows.reduce((sum, r) => sum + r.todayHours, 0),
    },
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════════

describe('hm — hours and minutes', () => {
  /** Nobody reading on a phone converts decimal hours into minutes */
  it('decimal hours into minutes', () => {
    expect(hm(7.02)).toBe('7h 01m');
    expect(hm(8)).toBe('8h 00m');
    expect(hm(0)).toBe('0h 00m');
  });

  /** The caller adds the sign (- or +), so this is always positive */
  it('a negative value is shown as its absolute value', () => {
    expect(hm(-2.5)).toBe('2h 30m');
  });

  it('rounding up to 60 minutes rolls into the hour', () => {
    expect(hm(7.999)).toBe('8h 00m');
  });
});

describe('escapeHtml', () => {
  /**
   * The message is sent with `parse_mode: HTML`. A `&` or `<` in a name would
   * make Telegram answer the whole call with 400 — so that day's report
   * would not go out at all.
   */
  it('the three dangerous characters', () => {
    expect(escapeHtml('Ali & <b>Co</b>')).toBe(
      'Ali &amp; &lt;b&gt;Co&lt;/b&gt;',
    );
  });

  it('is escaped inside the wrapper', () => {
    expect(asPreBlock('a & b')).toBe('<pre>a &amp; b</pre>');
  });
});

// ════════════════════════════════════════════════════════════════════════════

describe('telegramDigest', () => {
  /**
   * The most important test — nobody gets lost. If the top says "13 people",
   * all thirteen names must be below, including those on leave. Otherwise the
   * gap would look exactly like "the agent is not working".
   */
  it('everyone\'s name is in some group', () => {
    const rows = [
      row({ empCode: 'OX-01', fullName: 'Met', todayHours: 8 }),
      row({ empCode: 'OX-02', fullName: 'Under', todayHours: 5 }),
      row({ empCode: 'OX-03', fullName: 'Nothing', todayHours: 0, idleToday: true }),
      row({ empCode: 'OX-04', fullName: 'Resting', offToday: true, todayHours: 0, todayTargetHours: 0 }),
    ];

    const text = telegramDigest(digestOf(rows), 'oXeio', EXTRAS);

    for (const r of rows) expect(text).toContain(r.fullName);
    expect(text).toContain('4 worked');
  });

  it('met-target and missed-target are separate groups', () => {
    const text = telegramDigest(
      digestOf([
        row({ fullName: 'Met', todayHours: 8.5 }),
        row({ fullName: 'Short', todayHours: 6 }),
      ]),
      'oXeio',
      EXTRAS,
    );

    expect(text).toContain('MET THE TARGET · 1');
    expect(text).toContain('UNDER TARGET · 1');
    // The shortfall is written out, otherwise the reader would have to subtract in their head
    expect(text).toContain('−2h 00m');
  });

  /**
   * Exactly on target counts as met. With `>`, someone who did exactly 8
   * hours would land in the "behind" list every day — a mistake people take
   * personally.
   */
  it('exactly on target = met', () => {
    const text = telegramDigest(
      digestOf([row({ fullName: 'Exact', todayHours: 8, todayTargetHours: 8 })]),
      'oXeio',
      EXTRAS,
    );

    expect(text).toContain('MET THE TARGET · 1');
    expect(text).not.toContain('UNDER TARGET');
  });

  /** Empty groups are not shown — four empty headings every day is that wall again */
  it('empty group headings are not shown', () => {
    const text = telegramDigest(
      digestOf([row({ fullName: 'Met', todayHours: 8 })]),
      'oXeio',
      EXTRAS,
    );

    expect(text).not.toContain('NO WORK TODAY');
    expect(text).not.toContain('OFF TODAY');
    expect(text).not.toContain('BEHIND');
  });

  /**
   * The order is never by hours — `Digest.rows` arrives in staff-code order
   * and that stays intact. Sorting by hours would turn the message into a
   * leaderboard every evening (the README's "never").
   */
  it('within a group the order is by staff code, not by hours', () => {
    const text = telegramDigest(
      digestOf([
        row({ empCode: 'OX-01', fullName: 'Alpha', todayHours: 2 }),
        row({ empCode: 'OX-02', fullName: 'Bravo', todayHours: 7 }),
        row({ empCode: 'OX-03', fullName: 'Charlie', todayHours: 4 }),
      ]),
      'oXeio',
      EXTRAS,
    );

    expect(text.indexOf('Alpha')).toBeLessThan(text.indexOf('Bravo'));
    expect(text.indexOf('Bravo')).toBeLessThan(text.indexOf('Charlie'));
  });

  it('when behind for the month, both the count and the expectation are written', () => {
    const text = telegramDigest(
      digestOf([
        row({
          fullName: 'Behind',
          todayHours: 8,
          behind: true,
          paceHours: -12.5,
          monthHours: 96,
          expectedHours: 108.5,
        }),
      ]),
      'oXeio',
      EXTRAS,
    );

    expect(text).toContain('BEHIND FOR THE MONTH · 1');
    expect(text).toContain('−12h 30m');
    expect(text).toContain('96h 00m of 108h 30m');
    // Without the explanation the number is easy to misread
    expect(text).toContain("excludes today's target");
  });

  /**
   * The whole Telegram presence of `agent_down` is this one line — it used
   * to send 39 separate messages a day.
   */
  it('silent PCs on one line, and no line at all when zero', () => {
    const rows = [row({ fullName: 'A', todayHours: 8 })];

    expect(
      telegramDigest(digestOf(rows), 'oXeio', { ...EXTRAS, silentPcs: 3 }),
    ).toContain('3 PCs went silent');

    expect(
      telegramDigest(digestOf(rows), 'oXeio', { ...EXTRAS, silentPcs: 1 }),
    ).toContain('1 PC went silent');

    expect(telegramDigest(digestOf(rows), 'oXeio', EXTRAS)).not.toContain(
      'silent',
    );
  });

  /**
   * The tasks section — done / target.
   *
   * Only those with an entry in the map appear. Otherwise people the measure
   * is not for would be listed as "0/25" every day, which is an accusation,
   * not information.
   */
  it('only people with an entry appear in the tasks section', () => {
    const text = telegramDigest(
      digestOf([
        row({ empCode: 'OX-07', fullName: 'Assignee A', todayHours: 8 }),
        row({ empCode: 'OX-04', fullName: 'Coordinator B', todayHours: 8 }),
      ]),
      'oXeio',
      {
        ...EXTRAS,
        tasks: new Map([['OX-07', { done: 24, target: 25, met: false }]]),
      },
    );

    expect(text).toContain('✅ TASKS TODAY · 1');
    expect(text).toContain('24/25');
    // The name will be in the hours group above anyway — so the claim is
    // about the task number: someone without an entry gets no "/25"
    expect(text).not.toContain('/25  Coordinator B');
  });

  /** A check mark when the target is reached — consistent with the hours rule (`>=`) */
  it('check mark when the target is reached, none otherwise', () => {
    const make = (done: number) =>
      // Deliberately kept below the hours target — otherwise the
      // "MET THE TARGET" heading would make the claim false
      telegramDigest(digestOf([row({ empCode: 'OX-07', fullName: 'A', todayHours: 5 })]), 'oXeio', {
        ...EXTRAS,
        tasks: new Map([['OX-07', { done, target: 25, met: done >= 25 }]]),
      });

    // The section heading carries a ✅ too, so the claim is about the row
    expect(make(25)).toContain('25/25 ✅');
    expect(make(24)).toContain('24/25');
    expect(make(24)).not.toContain('24/25 ✅');
  });

  /**
   * Someone without a target who still finished tasks: the number appears,
   * but with no `/25` and no check mark.
   */
  it('someone without a target shows a number, but with no mould', () => {
    const text = telegramDigest(
      digestOf([row({ empCode: 'OX-01', fullName: 'Belal', todayHours: 5 })]),
      'oXeio',
      {
        ...EXTRAS,
        tasks: new Map([['OX-01', { done: 43, target: null, met: false }]]),
      },
    );

    expect(text).toContain('43');
    expect(text).not.toContain('43/');
    const line = text.split('\n').find((l) => l.includes('43') && l.includes('Belal'));
    expect(line).toBeDefined();
    expect(line).not.toContain('✅');
  });

  /** If nobody has anything to show, the section does not appear at all */
  it('no entries means no section', () => {
    const text = telegramDigest(digestOf([row()]), 'oXeio', EXTRAS);
    expect(text).not.toContain('TASKS TODAY');
  });

  /**
   * Keep lines short — on a narrow phone, wrapping would break the columns,
   * and then the whole reason for monospace would be pointless.
   */
  it('no line is longer than 40 characters', () => {
    const text = telegramDigest(
      digestOf([
        row({ fullName: 'Sk Nasif Iqbal Shovon', todayHours: 7.02 }),
        row({ empCode: 'OX-02', fullName: 'Sahariar Ahmed (Ali)', todayHours: 5.62 }),
      ]),
      'oXeio Monitoring',
      {
        silentPcs: 2,
        atTime: '18:30',
        tasks: new Map([['OX-01', { done: 24, target: 25, met: false }]]),
      },
    );

    for (const line of text.split('\n')) {
      expect(line.length, line).toBeLessThanOrEqual(40);
    }
  });

  /** No crash even with no staff — at month end everyone may be inactive */
  it('the message is still built when there is nobody', () => {
    const text = telegramDigest(digestOf([]), 'oXeio', EXTRAS);
    expect(text).toContain('0 of 0 worked');
  });
});
