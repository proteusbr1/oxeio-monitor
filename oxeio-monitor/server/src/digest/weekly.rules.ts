import { WORK_TIMEZONE_LABEL, workDateOf } from '../agent/util/work-time';
import { addDays, toIsoDate } from '../reports/reports.range';
import type { AttendanceRow, SummaryRow } from '../reports/reports.types';

/**
 * **R3** — all calculations and wording of the weekly summary on Telegram.
 * Pure functions, no I/O.
 *
 * **There is no new definition here** — as in `digest.math.ts`. Hours, target,
 * leave and work days all come from `ReportsService`'s F01/F02 rows. Reading
 * `daily_summary` directly to build the week's target would create a
 * **fourth** implementation of the holiday calendar, and one day Telegram would
 * say a target of 38 hours while the report said 40 — and neither would be
 * trusted any more.
 *
 * Careful: **"no record" and "zero work" are not the same thing.** The most
 * important rule in this file. Ranking an employee with not a single
 * observation all week as "worked 0 hours" counts missing observation as
 * failure — whether the agent was off, the PC was off, or no work was done,
 * this file cannot know. So they do not go on the "behind" list; they go in a
 * separate "Not observed" group, and the reason is spelled out in the
 * message's footnote.
 *
 * Careful: **"no row" and "a row with 0 hours" are also different.** F01/F02
 * merge both into "no activity" (`status: worked > 0 ? 'worked' : 'no_activity'`
 * in `reports.attendance.service.ts`), but the difference **exists** in the DB:
 * `refreshDate()` writes a row for **every active employee** every day,
 * whether or not they worked. So a row existing = that day was measured.
 * Merged, the mistake would go **both ways**: someone whose agent runs fine
 * but who worked 0 hours all week would also be told "agent was off", and real
 * absence would never reach the "Behind" list. That is why `observed`
 * (`WeeklySource`) is not a number but simply "was that day watched at all".
 *
 * Careful: **the expectation starts counting from the day the server really
 * began watching.** On this installation tracking began on 13 August 2026, and
 * the default schedule is Friday 6 pm — so the **first** message's window was
 * 8-14 August, of which 8-12 nobody watched. Counting those days' targets in
 * the expectation would make the first message say, name by name, "32 hours
 * behind" — for days when the measuring instrument was not even installed, and
 * a Telegram message cannot be taken back once sent. So a day not watched is
 * in neither the expectation nor the shortfall.
 *
 * The adjustment is **written in the message** (`counted from …`). Otherwise
 * the number would be right but why it is smaller would be an invisible
 * assumption — and the reader, reconciling the whole week in their head, would
 * reach the same mistake again.
 *
 * The rule is not new — on the monthly page `elapsedWindow()` in
 * `summary.math.ts` does exactly this: max(window start, `joinedOn`, tracking
 * start). Here the limit is **per employee**, because `daily_summary` rows are
 * also written per employee; so this window never starts **earlier** than the
 * monthly page's, only equal or later — the two pages cannot contradict each
 * other (G88).
 *
 * Careful: **no screenshot, app name or domain ever goes into this message** —
 * only hours and names. Telegram messages are stored on its servers and float
 * up on the phone lock screen; sending someone's browsing there would
 * effectively remove the dashboard's role wall. No type in this file has room
 * for a domain or a file name — that is not an accident.
 *
 * Careful: **no money** — salary is owner-only and audited (ADR-023).
 */

/** Hours to two decimals — every number in the message looks the same */
function h(hours: number): string {
  return hours.toFixed(2);
}

/** Round to two decimals (the report's hours are already two decimals) */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ── Window and schedule ──────────────────────────────────────────────────────

/**
 * How many days the summary covers.
 *
 * Deliberately **"the last 7 days"**, not a calendar week. The week boundary in
 * this project differs per employee (`weekStartIsoDay()` — the day after their
 * weekly off day), so choosing one "last week" date pair would cut the work
 * week in the middle for those whose off day is different. The last 7 days is
 * the same length for everyone, and both dates are written at the top of the
 * message — so there is no doubt about what the reader is looking at.
 */
export const WEEKLY_WINDOW_DAYS = 7;

/** Careful: default Friday (ISO 5) — the end of a Monday-to-Friday week */
export const WEEKLY_DIGEST_DEFAULT_DAY = 5;
/** 6 pm (work zone) — just before the daily digest's 6:30, so the two do not arrive together */
export const WEEKLY_DIGEST_DEFAULT_HOUR = 18;

export interface WeeklyWindow {
  /** First day of the window, YYYY-MM-DD (work zone) */
  from: string;
  /** Last day of the window = today */
  to: string;
  days: number;
}

/**
 * The 7 days ending with the work day that `now` falls on.
 *
 * Careful: "today" means **the work zone's** today. The server runs in UTC; at 6 pm
 * Friday `now` is still afternoon in UTC, so the date would match — but if
 * someone ran it by hand at 11 pm, it would already be the next day in UTC and
 * the window would shift by a whole day.
 */
export function weeklyWindow(now: Date): WeeklyWindow {
  const today = workDateOf(now);
  return {
    from: toIsoDate(addDays(today, -(WEEKLY_WINDOW_DAYS - 1))),
    to: toIsoDate(today),
    days: WEEKLY_WINDOW_DAYS,
  };
}

export interface WeeklySchedule {
  /** ISO day — 1 = Monday … 7 = Sunday (same as the `weekly_off_day` column) */
  isoDay: number;
  /** 0-23, work-zone hour */
  hour: number;
  /** What goes into `@Cron` — six fields: second minute hour day month weekday */
  expression: string;
  /** Variables that could not be read — logged at job start, not silently defaulted */
  ignored: string[];
}

function intIn(raw: string | undefined, min: number, max: number): number | null {
  const text = (raw ?? '').trim();
  if (text.length === 0) return null;
  // Careful: not `parseInt` — it would take "18abc" as 18, and the typo would never be caught
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/**
 * `WEEKLY_DIGEST_DAY` / `WEEKLY_DIGEST_HOUR` → cron expression.
 *
 * Careful: **an ISO day and cron's weekday are not the same.** In cron Sunday
 * is 0, but in ISO it is 7 (and this repo uses ISO everywhere, including
 * `weekly_off_day`). Without `% 7`, `WEEKLY_DIGEST_DAY=7` would become "7" in
 * cron — node-cron treats that as Sunday too, but it cannot be relied on; and
 * the mistake would be found only seven days later, when the message did not come.
 *
 * Careful: a bad value gives **a default + `ignored`, not a crash** — the
 * price of a typo cannot be "the server will not start". But staying silent is
 * not an option either, otherwise the owner would think Monday was set while
 * the message came on Friday.
 */
export function weeklyScheduleOf(
  dayRaw?: string,
  hourRaw?: string,
): WeeklySchedule {
  const ignored: string[] = [];

  const day = intIn(dayRaw, 1, 7);
  if (day === null && (dayRaw ?? '').trim().length > 0) {
    ignored.push(`WEEKLY_DIGEST_DAY must be 1..7 (Mon..Sun), got "${dayRaw}"`);
  }

  const hour = intIn(hourRaw, 0, 23);
  if (hour === null && (hourRaw ?? '').trim().length > 0) {
    ignored.push(`WEEKLY_DIGEST_HOUR must be 0..23, got "${hourRaw}"`);
  }

  const isoDay = day ?? WEEKLY_DIGEST_DEFAULT_DAY;
  const atHour = hour ?? WEEKLY_DIGEST_DEFAULT_HOUR;

  return {
    isoDay,
    hour: atHour,
    expression: `0 0 ${atHour} * * ${isoDay % 7}`,
    ignored,
  };
}

// ── Where it is safe to send ─────────────────────────────────────────────────

/**
 * **Whether this is a private chat id** — Telegram's own rules tell us.
 *
 * A private chat's id is always a **positive integer** (it is the user id
 * itself). Group, supergroup and channel ids are **negative** (`-100…`), and
 * `@name` exists only for public channels/supergroups — a bot cannot address
 * a private chat by `@name`. So "digits only" = "private chat".
 *
 * Careful: conversely, anything unknown (`abc`, `+880…`) is taken as **not
 *    private** here, because the question is not "is this a group?" — it is
 *    "do we know this is **not** a group?". Not knowing means not knowing, and
 *    then there is no reason to risk sending a ranking by name (rule 2:
 *    calling "don't know" by the name "zero" is forbidden).
 */
export function isPrivateChatId(rawChatId: string): boolean {
  return /^\d+$/.test(rawChatId.trim());
}

/** The decision of `weeklyGateOf()` — whether to send, and if not, why */
export interface WeeklyGate {
  send: boolean;
  /** Careful: **always** present when `send === false`, otherwise `null` */
  blockedBecause: string | null;
}

/**
 * Careful: the variable that lets the owner knowingly send to a group too.
 * It is in both `.env.example` **and** `docker-compose.yml` — not just one.
 */
export const WEEKLY_ALLOW_GROUP_ENV = 'WEEKLY_DIGEST_ALLOW_GROUP';

/**
 * **Whether the weekly summary may go to this chat.**
 *
 * Careful: the chat id is **shared with alerts** (`TELEGRAM_CHAT_ID`). Alerts
 * carry only the hostname and alert type — fairly harmless in a team group, so
 * many people put the team group there. But the weekly summary **names who is
 * behind**; if it went to the same chat, on the very first Friday there would
 * be a weekly public humiliation, and **a Telegram message cannot be taken
 * back**. "Not the staff group" was written in three places and there was a
 * guard nowhere — this is that guard.
 *
 * **A conscious decision, not a silent block.** If the owner really wants a
 * group, they can write `WEEKLY_DIGEST_ALLOW_GROUP=true`; the path is open,
 * only the accident is closed.
 *
 * Careful: **alerts are not covered by this guard** — this function sits only
 * on the weekly summary path (`WeeklyDigestService`). `TelegramChannel.runOnce()`
 * runs as before, because no names go there.
 *
 * Careful: when the chat id is **empty**, no decision is made here (`send:
 * true`). Empty means Telegram is not configured at all, and the only place to
 * say so is `TelegramChannel` (`not_configured`). Blocking here would write the
 * wrong reason to the log — "looks like a group", when nothing was set.
 */
export function weeklyGateOf(
  rawChatId: string | undefined,
  rawAllowGroup: string | undefined,
): WeeklyGate {
  const chatId = (rawChatId ?? '').trim();

  // Careful: not configured at all — the decision belongs to the channel, not this function
  if (chatId.length === 0) return { send: true, blockedBecause: null };

  // Careful: `SMTP_SECURE` in `alerts.mailer.ts` is read exactly this way — same
  //    pattern, otherwise one repo would have two kinds of "true"
  if ((rawAllowGroup ?? '').trim().toLowerCase() === 'true') {
    return { send: true, blockedBecause: null };
  }

  if (isPrivateChatId(chatId)) return { send: true, blockedBecause: null };

  return {
    send: false,
    /**
     * Careful: **the chat id is not written** in the log line — anyone who gets
     *    it (with the bot token) can send to that group, and that is exactly why
     *    `TelegramChannel` filters the token out. It is not needed to say what to do anyway.
     */
    blockedBecause:
      'TELEGRAM_CHAT_ID is not a private chat id, so this could be a staff ' +
      'group. The weekly summary names who is behind and a Telegram message ' +
      'cannot be taken back, so it was not sent. Either point ' +
      "TELEGRAM_CHAT_ID at the owner's own chat (a positive numeric id), or " +
      `set ${WEEKLY_ALLOW_GROUP_ENV}=true to send it to that chat on purpose. ` +
      'Alerts are unaffected — they carry only hostnames and alert types.',
  };
}

// ── The week's rows ──────────────────────────────────────────────────────────

/**
 * An employee's standing.
 *
 * Careful: `no_records` is not a failure, it is **ignorance** — the server did
 * not see a single day of that employee. Someone who was seen yet did not work
 * does **not** come here; they are `behind` by the numbers, and that is the
 * honest answer. Merging the two was the earlier bug (see the note at the top
 * of the file).
 */
export type WeeklyStanding = 'on_track' | 'behind' | 'no_records' | 'off';

export interface WeeklyRow {
  employeeId: number;
  empCode: string;
  fullName: string;
  /** The window's total `credited` — work plus the owner's corrections */
  creditedHours: number;
  /** The window's total target, including today */
  targetHours: number;
  /**
   * **How many hours should have been done on observed days, up to
   * yesterday.**
   *
   * Days drop out for two separate reasons, both deliberate —
   *
   * 1. **Today.** Exactly the same decision as the daily digest, for the same
   *    reason (`expectedHours` in `digest.math.ts`): the job runs at 6 pm and
   *    the day is not over. Counting today's whole target in the expectation
   *    would put **almost everyone on the "behind" list every week**, and the
   *    list would stop being read within two weeks. So the calculation is
   *    generous — today's work counts in full, the claim does not.
   *
   * 2. Careful: **a day the server never watched.** A day before tracking was
   *    installed, or a day the server was down — there is no `daily_summary`
   *    row for it. Counting their targets in the expectation counts the
   *    unknown as shortfall, and the very first weekly message would then lie
   *    name by name (see the top of the file).
   */
  expectedHours: number;
  /** `creditedHours − expectedHours`; negative = behind */
  paceHours: number;
  /** How many work days in the window (excluding join/leave dates and holidays) */
  workdays: number;
  /** On how many days work **was recorded** */
  daysWithWork: number;
  /**
   * How many days of the window they were employed (not work days — holidays
   * count too). The denominator of `observedDays`; showing just one number
   * would not let the fraction be built.
   */
  windowDays: number;
  /** How many of those days the server really watched (a `daily_summary` row exists) */
  observedDays: number;
  /** `windowDays − observedDays` — these days are also left out of the expectation */
  unobservedDays: number;
  /**
   * The day the expectation started counting from — the **first** observed day
   * (excluding today). `null` = there is not a single day to count.
   *
   * It is printed in the message when later than the window start — otherwise
   * the reader, seeing the small `expectedHours`, would think the arithmetic was wrong.
   */
  countedFrom: string | null;
  /**
   * Careful: whether there is at least one observation in the week.
   *
   * The main condition is `observedDays > 0` — that is, the day's row was
   * written, whether or not the hours are zero. The condition used to be "are
   * there hours", so an employee with the agent running who really did not work
   * would drop into the "no record" group, and real absence would never be
   * noticed by anyone.
   *
   * Careful: the two side conditions (`daysWithWork`, `creditedHours`) are a
   * safeguard, not redundancy: when the owner enters a correction by hand
   * (`adjustment_sec`), `worked_sec` stays zero, and if the `observed` list
   * somehow came in empty (a query changed, old data was migrated), someone
   * with hours still must not be called "not observed" — that would disown the
   * owner's own written number.
   */
  recorded: boolean;
  standing: WeeklyStanding;
}

export interface Weekly {
  from: string;
  to: string;
  days: number;
  /** Sorted by employee code — the same order as the report */
  rows: WeeklyRow[];
  /** Furthest behind first */
  behind: WeeklyRow[];
  onTrack: WeeklyRow[];
  /** Careful: we know nothing about these people — not "zero hours" */
  noRecords: WeeklyRow[];
  /** There was not a single work day in the whole window (a long holiday and the like) */
  off: WeeklyRow[];
  /**
   * Careful: people who did not appear in the report at all — `status=inactive`
   * with `left_on` empty (`reports.context.service.ts`). Since when they were absent is
   * unknown, neither their hours nor their target can be worked out.
   *
   * Their names **are sent** in the message. The report deliberately names them
   * ("rather than dropping silently"), but the weekly message used to throw
   * `meta` away — so they vanished on Telegram, and reading "N of M staff" the
   * owner would think the team was just those M people. The only way to catch
   * that mistake was for someone to happen to remember.
   */
  excludedEmployees: string[];
  totals: {
    employees: number;
    /** Those about whom at least something is known */
    withData: number;
    /** Careful: not "the team's total" — the total **recorded**. Missing data adds nothing. */
    hoursRecorded: number;
    /** People with at least one day not observed — the message's warning sits on this */
    withGaps: number;
    /** Number of employees dropped from the report */
    excluded: number;
  };
}

/**
 * "The server watched that employee on that day" — a row exists in `daily_summary`.
 *
 * Deliberately **no number**, only existence. Hours, target and work days all
 * still come from F01/F02 as before (the note at the top of the file); the one
 * thing added here is the fact that the report's shape has no place to express.
 */
export interface ObservedDay {
  employeeId: number;
  /** YYYY-MM-DD (work zone) */
  date: string;
}

export interface WeeklySource {
  from: string;
  to: string;
  days: number;
  /**
   * F01, rows for the **whole window** — one per employee per day.
   *
   * Needed to know **the day's target**, which cannot come except per day: what
   * drops out of the expectation is today **and** the days not watched. F02
   * gives one target for the whole week, and there is no way to separate
   * "11 August's target" from it.
   *
   * Careful: rows for days before joining or after leaving are **not here at
   * all** (`employedOn` in `reports.context.service.ts`) — so this file has nothing
   * extra to do about `joinedOn`; those days are not in the expectation anyway.
   *
   * Careful: hours are **not summed from here**, they come from F02. Adding up
   * seven days of daily values rounded to two decimals would differ from F02's
   * total by a hundredth or two, and then Telegram and the report page would
   * give two different numbers for the same week (G88).
   */
  daily: readonly AttendanceRow[];
  /** F02 `groupBy=week`, from the window's first day → today */
  week: readonly SummaryRow[];
  /** Which (employee, day) pairs were watched at all */
  observed: readonly ObservedDay[];
  /** `meta.excludedEmployees` of F01/F02 */
  excludedEmployees: readonly string[];
}

/**
 * F01 + F02 + observation → the week's rows.
 *
 * The three sources do three different jobs, and that is deliberate —
 *   · **F02** (`week`) gives hours, total target and work days. Every number
 *     printed in the message comes from here, so the report page and Telegram
 *     never say different things.
 *   · **F01** (`daily`) gives only **the day's target** — to decide which day
 *     drops out of the expectation.
 *   · **`observed`** gives only "was that day measured at all".
 *
 * Careful: the base is **the week's summary rows**, not today's attendance —
 * the opposite of the daily digest. Reason: someone who left on Wednesday
 * **should** have their Saturday-Tuesday hours in the week's figures; going by
 * today's rows they would vanish and the team's total hours would silently look lower.
 *
 * Careful: a 7-day window can split into **two** week buckets for one employee
 * — someone's weekly off day is Friday, someone else's Saturday, and
 * `bucketOf()` starts the week on the day after the off day. So the buckets
 * are **added**, and the last one is not taken; taking it would lose half the
 * hours of those whose week is split in the middle.
 *
 * Careful: `shortfallHours` / `overtimeHours` are **not** added — each is
 * `max(0, …)` per bucket, and adding two positive numbers would raise both
 * shortfall and overtime at once (+5 in one bucket and −5 in another would
 * give "5 short and 5 over" — meaningless). So they are recomputed from the sum.
 */
export function buildWeekly(source: WeeklySource): Weekly {
  const coverage = coverageOf(source);

  /** employeeId → the running total */
  const folded = new Map<
    number,
    {
      empCode: string;
      fullName: string;
      creditedHours: number;
      targetHours: number;
      workdays: number;
      daysWithWork: number;
    }
  >();

  for (const row of source.week) {
    const acc = folded.get(row.employeeId) ?? {
      empCode: row.empCode,
      fullName: row.fullName,
      creditedHours: 0,
      targetHours: 0,
      workdays: 0,
      daysWithWork: 0,
    };

    acc.creditedHours += row.creditedHours;
    acc.targetHours += row.targetHours;
    acc.workdays += row.workdays;
    acc.daysWithWork += row.daysWithWork;

    folded.set(row.employeeId, acc);
  }

  const rows: WeeklyRow[] = [...folded].map(([employeeId, acc]) => {
    const creditedHours = round2(acc.creditedHours);
    const targetHours = round2(acc.targetHours);

    const seen = coverage.get(employeeId) ?? EMPTY_COVERAGE;

    /**
     * Careful: **subtract, do not add.** The total target comes from F02, and
     * only the targets of the uncounted days are taken off it. Building the
     * expectation by adding up days would accumulate each day's rounding and not
     * match F02's number, and "how far behind" would differ between two screens.
     *
     * Careful: `max(0, …)` — if every day drops out, the expectation is zero,
     * not negative. And with a zero expectation nobody can be behind, which is
     * what we want: in a week none of whose days was watched there is no basis
     * for blaming anyone.
     */
    const expectedHours =
      seen.windowDays > 0 && seen.countedFrom === null
        ? // Careful: no day could be counted → the expectation is **exactly** zero,
          //    not "nearly" zero. Subtraction would leave a remnant like 0.02 from
          //    the rounded targets, and the very first message would put the whole
          //    team "0.02 hours behind" — a small number, but a false sentence.
          0
        : Math.max(0, round2(targetHours - seen.uncountedTarget));
    const paceHours = round2(creditedHours - expectedHours);
    const recorded =
      seen.observedDays > 0 || acc.daysWithWork > 0 || creditedHours !== 0;

    return {
      employeeId,
      empCode: acc.empCode,
      fullName: acc.fullName,
      creditedHours,
      targetHours,
      expectedHours,
      paceHours,
      workdays: acc.workdays,
      daysWithWork: acc.daysWithWork,
      windowDays: seen.windowDays,
      observedDays: seen.observedDays,
      unobservedDays: seen.windowDays - seen.observedDays,
      countedFrom: seen.countedFrom,
      recorded,
      standing: standingOf(acc.workdays, recorded, paceHours),
    };
  });

  rows.sort((a, b) => (a.empCode < b.empCode ? -1 : a.empCode > b.empCode ? 1 : 0));

  const of = (s: WeeklyStanding): WeeklyRow[] =>
    rows.filter((r) => r.standing === s);

  const behind = of('behind').sort(
    // Furthest behind first; ties by code — so two runs in one week give the same message
    (a, b) => a.paceHours - b.paceHours || (a.empCode < b.empCode ? -1 : 1),
  );

  return {
    from: source.from,
    to: source.to,
    days: source.days,
    rows,
    behind,
    onTrack: of('on_track'),
    noRecords: of('no_records'),
    off: of('off'),
    // Careful: names stay in the report's order (they come from the employee
    //    list sorted by `empCode asc`) — running twice in one week gives the same message
    excludedEmployees: [...source.excludedEmployees],
    totals: {
      employees: rows.length,
      withData: rows.filter((r) => r.recorded).length,
      // Careful: the sum covers all rows — those with no record contribute 0, and
      //    that is correct: we **recorded no hours** for them. The message states
      //    "N of M staff have data" right beside it, so the total cannot be
      //    mistaken for a complete one.
      hoursRecorded: round2(rows.reduce((sum, r) => sum + r.creditedHours, 0)),
      withGaps: rows.filter((r) => r.unobservedDays > 0).length,
      excluded: source.excludedEmployees.length,
    },
  };
}

/** "How much was watched" for one employee — the accumulator of `coverageOf()` */
interface Coverage {
  /** Days of the window that fall within their employment (number of rows in F01) */
  windowDays: number;
  /** How many of those have a `daily_summary` row */
  observedDays: number;
  /** How many hours of target drop out of the expectation (today + unwatched days) */
  uncountedTarget: number;
  countedFrom: string | null;
}

/**
 * Careful: if there is no row in F01 at all (it should not happen — if F02 has
 * a row, F01 has too), nothing drops out, i.e. expectation = the full target.
 * Deliberately **the earlier behaviour**: without the new information the
 * calculation must not silently loosen and call everyone "on track".
 */
const EMPTY_COVERAGE: Coverage = {
  windowDays: 0,
  observedDays: 0,
  uncountedTarget: 0,
  countedFrom: null,
};

/**
 * Day-by-day observation → a per-employee window.
 *
 * Careful: not only unwatched days at the **start** — gaps in the middle drop
 * out too. If the server was down all of one Wednesday and ran before and
 * after, nobody watched that Wednesday either, so there is no right to ask for
 * its 8-hour target. A "count from the start" rule would silently turn that
 * gap into a shortfall.
 *
 * Careful: today is **not counted in the expectation even if watched** (the
 * day is not over), and does not go into `countedFrom` either — otherwise if
 * tracking began today the message would say "counted from today", when none
 * of today's hours is actually being asked for.
 */
function coverageOf(source: WeeklySource): Map<number, Coverage> {
  const seen = new Set(
    source.observed.map((o) => `${o.employeeId}|${o.date}`),
  );

  const byEmployee = new Map<number, Coverage>();

  for (const row of source.daily) {
    const acc = byEmployee.get(row.employeeId) ?? { ...EMPTY_COVERAGE };
    acc.windowDays += 1;

    const observed = seen.has(`${row.employeeId}|${row.date}`);
    if (observed) acc.observedDays += 1;

    if (observed && row.date !== source.to) {
      // Careful: strings compare fine because in YYYY-MM-DD alphabetical order = time order
      if (acc.countedFrom === null || row.date < acc.countedFrom) {
        acc.countedFrom = row.date;
      }
    } else {
      acc.uncountedTarget += row.targetHours;
    }

    byEmployee.set(row.employeeId, acc);
  }

  return byEmployee;
}

/**
 * Careful: the order matters.
 *
 * 1. **There was no work day at all** (the whole window is public holidays +
 *    weekly off days) → `off`. Calling these "no record" would put the whole
 *    team's names in that group in a holiday week, and the owner would think
 *    the agent had died on every machine.
 * 2. **Not a single observation** → `no_records`. Their `paceHours` is
 *    negative on paper, but that debt stands on an **assumed zero** — calling
 *    it "behind" counts not-knowing as failure.
 *    Careful: someone who **has** rows yet 0 hours does not come here — we know
 *    about them, and hiding known absence would make the list meaningless.
 * 3. The rest is plain arithmetic.
 */
function standingOf(
  workdays: number,
  recorded: boolean,
  paceHours: number,
): WeeklyStanding {
  if (workdays === 0) return 'off';
  if (!recorded) return 'no_records';
  return paceHours < -PACE_TOLERANCE_HOURS ? 'behind' : 'on_track';
}

/**
 * Careful: a shortfall under three minutes is not called "behind".
 *
 * F02's week target and F01's day target are both rounded to two decimals
 * (`secondsToHours`), and the expectation comes from subtracting one from the
 * other. When the daily target is not a whole number (208 ÷ 27 = 7.7037h),
 * seven days of rounding add up to two or three minutes either way. Putting
 * someone's name on the "Behind" list for those few seconds would blame them
 * unfairly — and a message sent by name cannot be taken back.
 *
 * The tolerance applies only when **sorting into groups**; the printed number
 * (`paceHours`) is never changed, so nothing is hidden.
 */
const PACE_TOLERANCE_HOURS = 0.05;

// ── The Telegram message ─────────────────────────────────────────────────────

/**
 * Telegram's `sendMessage` accepts no more than this in one message — over it
 * the whole call is HTTP 400, i.e. **nothing arrives**.
 *
 * Careful: the measure is in UTF-16 code units, and JS `String.length` counts
 * exactly that. So `Buffer.byteLength()` must not be used: a letter of many
 * non-Latin scripts is 3 bytes in UTF-8, so counting bytes would treat a team with non-Latin names as
 * "over the limit" at a third of the size and cut half the names.
 */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** For names — so a long name does not take a whole line of the screen */
const NAME_MAX = 40;
/** Careful: ORG_NAME is from env; a novel there would eat the message's whole limit */
const ORG_MAX = 60;

/**
 * Careful: newlines and control characters are trimmed out of names.
 *
 * The names are typed by hand by an admin, so it cannot be assumed that
 * nothing odd is in them. A single `\n` would make that row two lines and
 * muddle whose hours belong to which name below — it would also break the
 * trimming arithmetic (one line per row).
 *
 * No escaping is needed, because the message goes as **plain text** (there is
 * no `parse_mode` in `telegram.channel.ts`) — with Markdown, one `_` in a name
 * would make the whole message a 400.
 */
function name(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (clean.length === 0) return '(no name)';
  return clean.length > NAME_MAX ? `${clean.slice(0, NAME_MAX - 1)}…` : clean;
}

function who(row: WeeklyRow): string {
  return `${name(row.fullName)} (${row.empCode})`;
}

function days(row: WeeklyRow): string {
  return `${row.daysWithWork}/${row.workdays} days`;
}

/** `+8.00` / `-0.25` — the sign is placed separately, otherwise it would read "+-0.25" */
function signed(hours: number): string {
  return hours < 0 ? `-${h(-hours)}` : `+${h(hours)}`;
}

/**
 * Where the expectation window got shorter, written **in the row itself**.
 *
 * Careful: without it the number would be right but the reason invisible: the
 * reader would see "16 hours, 2/6 days, not behind" and, reconciling the whole
 * week in their head, think the system was going easy — when the real point is
 * that nobody watched the other days.
 *
 * Two different pictures, so two different sentences —
 * 1. The window started later (tracking just installed) → which day counting began on.
 * 2. The start is fine, with a gap in the middle (the server was down one day)
 *    → how many days.
 */
function coverageNote(row: WeeklyRow, windowFrom: string): string {
  if (row.unobservedDays === 0) return '';

  if (row.countedFrom !== null && row.countedFrom > windowFrom) {
    return ` · counted from ${row.countedFrom}`;
  }

  const d = row.unobservedDays;
  return ` · ${d} day${d === 1 ? '' : 's'} not observed`;
}

/**
 * Careful: "observed, no work done" — this is said in **separate words**.
 *
 * The text `0.00h` can carry two completely different meanings, and that was
 * the bug: the agent is running but nobody did anything all week — that is an
 * **observation**; the agent being off is a lack of observation. From the first
 * you can take action, from the second you can only fix the agent. Saying both
 * in the same word, the owner would do the wrong thing.
 */
function zeroWorkNote(row: WeeklyRow): string {
  return row.observedDays > 0 && row.creditedHours === 0
    ? ' · observed, no work recorded'
    : '';
}

interface Section {
  heading: string;
  lines: string[];
  /** The larger the number, the earlier it is trimmed */
  dropFirst: number;
}

export interface WeeklyMessage {
  text: string;
  /** How many **names** were dropped by trimming — numbers are never dropped */
  hidden: number;
}

/**
 * The whole Telegram message.
 *
 * Careful: the text is in English — the whole repo uses English in all
 * outgoing text, including the daily digest (`digest.math.ts`). Mixing two
 * languages would give the same owner different words in two languages.
 *
 * Careful: even with trimming, **each group's heading keeps the real number**
 * (`Behind (12)`) — only names are dropped. Showing "4 behind" when there are
 * really 12 would be a lie in the number, and that is the biggest offence in
 * this project.
 */
export function weeklyMessage(
  weekly: Weekly,
  orgName: string,
  limit: number = TELEGRAM_TEXT_LIMIT,
): WeeklyMessage {
  const org = orgName.trim().slice(0, ORG_MAX) || 'oXeio Monitoring';
  const { totals } = weekly;

  const head = [
    `${org} — Weekly summary`,
    `${weekly.from} → ${weekly.to} (${WORK_TIMEZONE_LABEL}, ${weekly.days} days)`,
    '',
  ];

  /**
   * The group of people dropped from the report — Careful: it is **always**
   * built, even in the "nobody" branch.
   *
   * If the whole team were inactive-with-empty-`left_on`, `totals.employees`
   * would be 0, and the branch below would stop at "Nobody was on the payroll"
   * — so exactly where the problem is biggest, not one name would go out.
   */
  const excludedSection: Section | null =
    weekly.excludedEmployees.length === 0
      ? null
      : {
          heading: `Not in this report (${weekly.excludedEmployees.length})`,
          lines: weekly.excludedEmployees.map((n) => `  • ${name(n)}`),
          // Careful: even if names get cut, the number in the heading stays —
          //    "how many are missing" is the real news here
          dropFirst: 3,
        };

  const excludedTail = [
    '  • "Not in this report": marked inactive with no leaving date, so there',
    '    is no way to tell which days should have counted. Fill in the leaving',
    '    date (or reactivate them) and they come back.',
  ];

  // ── Nobody ───────────────────────────────────────────────────────────────
  // Careful: "0.00h recorded · 0 of 0 staff" could be written, but it would read
  //    as if the team did nothing all week. Nobody being employed and nobody
  //    working are not the same thing.
  if (totals.employees === 0) {
    return fit(
      [...head, 'Nobody was on the payroll in this window.'],
      excludedSection === null ? [] : [excludedSection],
      excludedSection === null ? [] : ['', 'How to read this', ...excludedTail],
      limit,
    );
  }

  // ── Nobody has any record ────────────────────────────────────────────────
  // Careful: this branch is R3's core rule. If tracking was off for the whole
  //    week (agent update stuck, server newly installed, nobody opened a PC
  //    after the holidays) everyone's hours would come out zero — and reading
  //    "the team worked 0.00 hours" the owner could take a decision whose only
  //    basis is a dead agent.
  // Careful: not "0 hours of work" — "nothing was observed". `withData` now
  //    measures the existence of rows, not hours; so reaching this branch means
  //    not one row was written for anyone all week, i.e. the measuring
  //    instrument did not run.
  const teamLine =
    totals.withData === 0
      ? `Team — nothing was observed for any of the ${totals.employees} staff. ` +
        'This is not the same as nobody working; see the note below.'
      : `Team — ${h(totals.hoursRecorded)}h recorded · ` +
        `${totals.withData} of ${totals.employees} staff have data`;

  /**
   * Once for the whole team — if any day was not observed, it is written at
   * the **top** of the message, not at the tail of every row. In the first
   * week (tracking just installed) this is the most important sentence in the
   * whole message: the answer to why the numbers are small.
   */
  const gapLines =
    totals.withGaps === 0
      ? []
      : [
          `Not every day was observed — ${totals.withGaps} of ${totals.employees} staff ` +
            'have days with no data at all.',
          'Those days are left out of the expected hours, so they count neither as',
          'work nor as a shortfall.',
        ];

  const sections: Section[] = [
    {
      heading: `Behind (${weekly.behind.length})`,
      lines: weekly.behind.map(
        (r) =>
          `  • ${who(r)} — ${h(r.creditedHours)}h · ` +
          `${h(Math.abs(r.paceHours))} behind · ${days(r)}` +
          zeroWorkNote(r) +
          coverageNote(r, weekly.from),
      ),
      // Careful: trimmed last of all — the only group where reading leads to action
      dropFirst: 0,
    },
    {
      heading: `On track (${weekly.onTrack.length})`,
      lines: weekly.onTrack.map(
        (r) =>
          `  • ${who(r)} — ${h(r.creditedHours)}h · ` +
          `${signed(r.paceHours)} · ${days(r)}` +
          zeroWorkNote(r) +
          coverageNote(r, weekly.from),
      ),
      dropFirst: 2,
    },
    {
      // Careful: the heading used to say "No records", and that phrase could also read
      //    as "0 hours recorded" — exactly the two things this group exists to separate
      heading: `Not observed (${weekly.noRecords.length})`,
      // Careful: no hours are written here — nothing known is worth writing
      lines: weekly.noRecords.map((r) => `  • ${who(r)}`),
      dropFirst: 1,
    },
    {
      heading: `Off all week (${weekly.off.length})`,
      lines: weekly.off.map(
        (r) =>
          `  • ${who(r)}${r.creditedHours > 0 ? ` — ${h(r.creditedHours)}h` : ''}`,
      ),
      dropFirst: 4,
    },
    ...(excludedSection === null ? [] : [excludedSection]),
  ].filter((s) => s.lines.length > 0);

  /**
   * Careful: the explanations are **conditional** — there is no point teaching
   * the rule of a group that is not in the message, and every character comes
   * out of the 4096 quota. The explanation for what is present is never
   * dropped, because the footnote is outside trimming.
   */
  const tail = [
    '',
    'How to read this',
    `  • Window: the ${weekly.days} days ending today (${WORK_TIMEZONE_LABEL}).`,
    '  • Hours are credited — work plus adjustments made by the owner.',
    "  • Today's target is left out, because today is not over yet.",
  ];

  if (totals.withGaps > 0) {
    tail.push(
      '  • Days the server never saw are left out of the expected hours too.',
    );
    // Careful: the symbol is explained only when the symbol is actually in the
    //    message — otherwise the reader would look for text that is nowhere
    if (
      weekly.rows.some(
        (r) => coverageNote(r, weekly.from).includes('counted from'),
      )
    ) {
      tail.push('    "counted from" is the first day that did count.');
    }
  }

  if (weekly.noRecords.length > 0) {
    tail.push(
      '  • "Not observed" does NOT mean zero work. Nothing was recorded at all —',
      '    the agent may have been off. Alerts and the dashboard answer that.',
    );
  }

  if (excludedSection !== null) tail.push(...excludedTail);

  return fit([...head, teamLine, ...gapLines], sections, tail, limit);
}

/**
 * Fit within the limit — trim names from the end, replacing them with "… and N more".
 *
 * Careful: the whole message is rebuilt every time, with length not tracked
 * separately — because adding the "… and N more" line can make the message
 * **longer** in a step, and adding and subtracting lengths step by step makes
 * that case easy to get wrong. The job runs once a week; being simple and
 * certainly correct is what is valuable.
 */
function fit(
  head: string[],
  sections: Section[],
  tail: string[],
  limit: number,
): WeeklyMessage {
  const shown = sections.map((s) => s.lines.length);

  const render = (): string => {
    const body: string[] = [];
    for (const [i, section] of sections.entries()) {
      const hidden = section.lines.length - shown[i];
      body.push('', section.heading, ...section.lines.slice(0, shown[i]));
      if (hidden > 0) body.push(`  … and ${hidden} more`);
    }
    return [...head, ...body, ...tail].join('\n');
  };

  const order = sections
    .map((s, i) => ({ i, dropFirst: s.dropFirst }))
    .sort((a, b) => b.dropFirst - a.dropFirst)
    .map((s) => s.i);

  let text = render();
  while (text.length > limit) {
    const next = order.find((i) => shown[i] > 0);
    if (next === undefined) break;
    shown[next] -= 1;
    text = render();
  }

  const hidden = sections.reduce(
    (sum, s, i) => sum + (s.lines.length - shown[i]),
    0,
  );

  // Careful: the last safeguard. If trimming every name still does not fit (the
  //    headings + footnote alone go over the limit), cutting is the only way —
  //    otherwise Telegram would reject the whole message with a 400 and the
  //    weekly summary would not arrive anywhere.
  return { text: text.length > limit ? text.slice(0, limit) : text, hidden };
}
