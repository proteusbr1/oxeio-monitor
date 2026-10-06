import { WORK_TIMEZONE_LABEL } from '../agent/util/dhaka-time';
import type { DesignView } from '../summary/design.rules';
import type { Digest, DigestRow } from './digest.math';

/**
 * **The daily report — Telegram's own look.**
 *
 * Careful: **why the email text does not work here.** Until now the email body
 * went to Telegram **verbatim** — one long list of all staff, then "behind",
 * then eight lines of *"How to read these numbers"*. In email that is fine
 * (read sitting down, once); on a phone it is not: the whole thing is a grey
 * wall, and the owner's two real questions — *who worked how many hours* and
 * *who reached the target* — got lost in it.
 *
 * **So it is arranged in groups**, as the owner chose: reached the target →
 * did not → did nothing today → off today → behind for the month. The answer
 * can be seen **without reading**, because every heading has a count beside it.
 *
 * Careful: **never sorted by hours.** Putting everyone in hours order would
 * turn this into a daily **leaderboard** — and that is on the README's "never"
 * list. Within each group the order is **by employee code**, exactly as in the
 * report ([10 § R22 note](../../../../docs/10-Roadmap.md)).
 *
 * Careful: **no app, domain or screenshot here either** — only hours. The
 * rule from `digest.math.ts` holds: Telegram messages get forwarded.
 */

/** `7.02` → `7h 01m`. Careful: nobody reading decimal hours on a phone converts them to minutes */
export function hm(hours: number): string {
  const total = Math.round(Math.abs(hours) * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;

  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * **Number first, name after** — and this is not decoration.
 *
 * Careful: with the name first, the column would shift with name length
 * ("Saifur" versus "Sk Nasif Iqbal Shovon"), so the numbers would no longer
 * line up — yet **comparing numbers at a glance** is the only job of this
 * message. With the number first the line stays short too (about 32
 * characters at most), so it does not wrap even on a narrow phone.
 */
function line(row: DigestRow, showDelta = false): string {
  const worked = hm(row.todayHours).padStart(7);

  if (!showDelta) return `  ${worked}  ${row.fullName}`;

  const gap = row.todayHours - row.todayTargetHours;
  // Careful: U+2212 (minus sign), not a hyphen — a hyphen looks like a dash next to a number
  const delta = `${gap < 0 ? '−' : '+'}${hmShort(gap)}`.padStart(7);

  return `  ${worked} ${delta}  ${row.fullName}`;
}

/**
 * **Under an hour, minutes only** — `59m`, not `0h 59m`.
 *
 * Not decoration, a **space budget**: the longest name is 21 characters
 * ("Sk Nasif Iqbal Shovon"), and saving three characters keeps the whole line
 * within 40. Careful: without the saving it would be 41, and on a narrow phone
 * the line would wrap and break the columns — making the whole reason for
 * monospace pointless. (This was caught by a test, not by eye.)
 */
function hmShort(hours: number): string {
  const total = Math.round(Math.abs(hours) * 60);
  if (total < 60) return `${total}m`;

  return hm(hours);
}

export interface DigestExtras {
  /**
   * How many PCs were silent during work hours today.
   *
   * Careful: this one line is the **whole Telegram presence** of the
   * `agent_down` alert. Before, every silence became its own message — **39**
   * were measured in the last 24 hours, 168 a week. The owner did not want
   * this type of alert. The alerts were not deleted, they are on the Alerts
   * page; only the daily flood on the phone was stopped.
   */
  silentPcs: number;
  /** Time of sending (Dhaka), such as `18:30` — says which moment the numbers are for */
  atTime: string;
  /**
   * Today's numbers for designers — by `empCode`.
   *
   * Careful: only designers have them; others have no entry here. An empty map
   * means "nobody has a design target", and then the section is not added at all.
   */
  designs?: ReadonlyMap<string, DesignView>;
}

/**
 * Careful: because it is sent with `parse_mode: 'HTML'`, **three characters
 * must be escaped**. An `&` in an employee's name is not unusual (names like
 * `Ali & Co`), and one unescaped `<` would make the whole message a 400 — so
 * **that day's report would not go at all**.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * By employee code — `Digest.rows` is already in that order, so there is no
 * sorting here. Careful: sorting anew would be the first opportunity to slip
 * into hours order.
 */
function pick(rows: readonly DigestRow[], test: (r: DigestRow) => boolean) {
  return rows.filter(test);
}

export function telegramDigest(
  digest: Digest,
  orgName: string,
  extras: DigestExtras,
): string {
  const { rows, totals } = digest;

  const off = pick(rows, (r) => r.offToday);
  const working = pick(rows, (r) => !r.offToday);
  const met = pick(working, (r) => r.todayHours >= r.todayTargetHours);
  const under = pick(working, (r) => r.todayHours > 0 && r.todayHours < r.todayTargetHours);
  const none = pick(working, (r) => r.todayHours === 0);

  /** Careful: the daily target is not the same for everyone (leave, joining date) — so the
   *  most common one is shown, and nothing if there is nobody */
  const target = working.length > 0 ? working[0].todayTargetHours : 0;

  const out: string[] = [
    `${orgName} · Daily report`,
    `${digest.workDate} · ${extras.atTime} ${WORK_TIMEZONE_LABEL}`,
    '',
    `Worked today   ${hm(totals.hoursToday)}`,
    `Staff          ${totals.workedToday} of ${totals.employees} worked`,
  ];

  if (target > 0) out.push(`Target         ${hm(target)} each`);

  const section = (
    title: string,
    group: readonly DigestRow[],
    showDelta: boolean,
  ) => {
    // Careful: an empty group is **not shown at all** — "NO WORK TODAY · 0" takes
    //    time to read, not to understand, and four empty headings a day is that wall again.
    if (group.length === 0) return;

    out.push('', `${title} · ${group.length}`);
    for (const r of group) out.push(line(r, showDelta));
  };

  section('✅ MET THE TARGET', met, false);
  section('⚠️ UNDER TARGET', under, true);

  if (none.length > 0) {
    out.push('', `⭕ NO WORK TODAY · ${none.length}`);
    // Careful: no hours are written here — all are 0, and a column of zeros says nothing
    for (const r of none) out.push(`  ${r.fullName}`);
  }

  /**
   * People on leave are listed too, although there is nothing to do about them.
   *
   * Careful: without it **the numbers would not add up** — "13 staff" above,
   * 11 names below, and no answer to where the other two went. That gap would
   * look exactly like "the agent is not working".
   */
  if (off.length > 0) {
    out.push('', `🌴 OFF TODAY · ${off.length}`);
    for (const r of off) out.push(`  ${r.fullName}`);
  }

  if (digest.behind.length > 0) {
    out.push('', `📉 BEHIND FOR THE MONTH · ${digest.behind.length}`);
    for (const r of digest.behind) {
      const gap = `−${hm(r.paceHours)}`.padStart(8);
      out.push(`  ${gap}  ${r.fullName}`);
      out.push(`            ${hm(r.monthHours)} of ${hm(r.expectedHours)}`);
    }
  }

  /**
   * Careful: the explanation is **two lines**, not the email's eight. Just
   * what is needed to avoid misreading the number: today's claim is not counted
   * in "behind", nor are days before the agent was installed. The rest is in
   * the email and on the dashboard.
   */
  if (digest.behind.length > 0) {
    out.push(
      '',
      "Behind excludes today's target, and days",
      'before tracking started for someone.',
    );
  }

  /**
   * **Today's designs** — the owner's target of 25.
   *
   * Careful: deliberately **not put inside** the hours groups: someone can be
   * behind on hours and still meet the design target, and the reverse. They
   * are two different measures, so separate sections — otherwise two answers
   * to "who is behind" would be mixed together.
   *
   * Careful: the order here too is by employee code, not by number.
   */
  const designRows = rows.filter((r) => extras.designs?.has(r.empCode));

  if (designRows.length > 0) {
    out.push('', `🎨 DESIGNS TODAY · ${designRows.length}`);

    for (const r of designRows) {
      const d = extras.designs!.get(r.empCode)!;

      /**
       * Careful: **with no target, just the number** (the owner's choice). The
       * manager designs too; the number is real but he has no target — so no
       * `/25` and no ✅. "How many were done" and "did they reach the target"
       * remain two separate questions.
       */
      const left = d.target === null
        ? `${String(d.done).padStart(3)}     `
        : `${String(d.done).padStart(3)}/${d.target} ${d.met ? '✅' : '  '}`;

      out.push(`  ${left} ${r.fullName}`);
    }
  }

  if (extras.silentPcs > 0) {
    // Careful: two lines — on one line it would be 52 characters, and on a narrow phone it
    //    would wrap and tangle with the columns below (caught by a test)
    out.push(
      '',
      `🖥️ ${extras.silentPcs} ${extras.silentPcs === 1 ? 'PC went' : 'PCs went'} silent today`,
      '   — the Alerts page says which',
    );
  }

  return out.join('\n');
}

/**
 * The whole message in one `<pre>` block — Telegram then shows it in
 * **monospace**, and only then do the number columns really line up.
 *
 * Careful: if sending fails, `TelegramChannel` **retries in plain text** —
 * because a formatting problem must never cost "that day's report was lost".
 */
export function asPreBlock(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}
