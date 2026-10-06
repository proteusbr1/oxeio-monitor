import type { HolidayEntry } from '../src/calendar/holiday-import';
import { Zone } from '../src/agent/util/zone';

export type { HolidayEntry } from '../src/calendar/holiday-import';

/**
 * Planning a holiday insert — for the seed (`SEED_COUNTRY`, from the public
 * calendar) and `import-holidays.ts` (a CSV or ICS file).
 * Pure functions, no I/O (same as `parse-staff.ts`, for the same reason:
 * importing `seed.ts` starts it running, so nothing inside it can be tested).
 *
 * Two rules carry everything here:
 *   1. **Nothing already in the table is changed or deleted.** The owner fixes
 *      dates and names in Settings → Holidays; the next seed or import must
 *      not undo that.
 *   2. **The current and past months are not touched without consent.** A new
 *      holiday there changes that month's workdays, its targets and the
 *      prorated salary (`isSettledMonth`).
 */

// ── dates ───────────────────────────────────────────────────────────────────

/** Call only with a valid date (`isRealDate()` in holiday-import.ts). */
export function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** `YYYY-MM-DD` to `YYYY-MM`. Call only with a valid date. */
export function monthKey(date: string): string {
  return date.slice(0, 7);
}

/**
 * **Today's** date in the work time zone (`YYYY-MM-DD`).
 *
 * Careful: `toISOString()` **always gives the UTC date**, whatever the
 * machine's TZ. In a zone ahead of UTC (UTC+6, say) the UTC date is still the
 * previous day between local midnight and 6 am, so the zone's date is taken
 * **first**, `toISOString()` after.
 * Otherwise a seed run in the small hours of the 1st would see "today" in the
 * previous month, treat **that month as the current one**, and silently insert
 * holidays into the month that just ended, shifting its payroll.
 *
 * Careful: the machine's local time is deliberately not used. `npm run seed`
 * may run on the owner's laptop in any time zone, and "today" would then
 * differ per machine.
 *
 * The day is cut in the work time zone (`WORK_TIMEZONE`, default UTC) — the
 * same rule the server uses (daylight saving included).
 */
export function workToday(
  now: Date,
  timeZone = process.env.WORK_TIMEZONE?.trim() || 'UTC',
): string {
  return new Zone(timeZone).dateOf(now.getTime()).toISOString().slice(0, 10);
}

/**
 * Whether the date falls in a month whose figures are **already out**.
 *
 * **The current month counts too.** That is the key decision here. The current
 * month's `monthly_summary` rows are written daily, and a holiday inserted
 * mid-month reduces that month's workdays D, which raises
 * `dailyTargetSec = monthly ÷ D`, which moves `target_sec`, `expected_sec` and
 * `pace_sec`, and the payroll `d ÷ D` fraction (`src/payroll/payroll.service.ts`)
 * goes straight into pay. So **the figures for past days change retroactively**.
 *
 * Future months are safe: they have no `monthly_summary` rows yet, so inserting
 * a holiday moves nobody's numbers.
 *
 * It is deliberately **over-cautious**: wrongly calling a future month
 * "closed" costs at most adding a date by hand, while the reverse moves money.
 */
export function isSettledMonth(date: string, today: string): boolean {
  return monthKey(date) <= monthKey(today);
}

// ── the plan ────────────────────────────────────────────────────────────────

/** A row already in the DB. */
export interface ExistingHoliday {
  /** `YYYY-MM-DD` */
  date: string;
  name: string;
}

export interface SeedPlan {
  /** To be inserted. */
  create: HolidayEntry[];
  /** A row exists for that date; left untouched. */
  keptByDate: HolidayEntry[];
  /** A row with that name exists on another date: the owner moved it, so it is left untouched. */
  keptByName: { entry: HolidayEntry; foundAt: string }[];
  /** Same date but a different name in the DB; reported to the owner. */
  renamed: { date: string; inDb: string; inList: string }[];
  /**
   * DB rows (in the covered years) that **no row of the list recognised**.
   * They are **never deleted**, only reported.
   *
   * Careful: "recognised" means matching by date **or by name**. Checking only
   * the date, the planner would say **two contradictory things** about one
   * row: if the owner moved a holiday from the 16th to the 15th, the row would
   * land in `keptByName` ("owner moved it, left untouched") **and** in
   * `unlisted` ("not in the list; is it still a holiday?"). When two truths are
   * printed about one thing, the reader trusts neither.
   */
  unlisted: ExistingHoliday[];
}

/**
 * Key for matching by name: **year + trimmed name**.
 *
 * The year is part of the key; otherwise last year's "New Year's Day" would
 * block this year's, which is a different holiday.
 */
function nameKey(date: string, name: string): string {
  return `${yearOf(date)} ${name.trim()}`;
}

/**
 * Decides which rows get inserted and which do not: a pure computation that
 * can be tested without a DB.
 *
 * Main rule: **nothing is changed or deleted; only missing rows are inserted.**
 *
 * Careful: **the date is the key, so something slips through.** If the owner
 * moves a holiday from the 21st to the 20th, the 21st is then empty; checking
 * only the date, the planner would create it again there, i.e. **an extra
 * holiday**. So matching also uses the name.
 *
 * One gap remains: a row the owner **deleted** cannot be recognised here,
 * because a deleted row looks the same as one that was never inserted. The
 * seed handles that separately: once a year has been seeded, it never looks
 * at it again (`yearsToSeed`).
 */
export function planHolidaySeed(
  entries: readonly HolidayEntry[],
  existing: readonly ExistingHoliday[],
): SeedPlan {
  const years = new Set(entries.map((e) => yearOf(e.date)));
  const inScope = existing.filter((row) => years.has(yearOf(row.date)));

  const byDate = new Map(inScope.map((row) => [row.date, row]));
  const byName = new Map(
    inScope.map((row) => [nameKey(row.date, row.name), row]),
  );

  const plan: SeedPlan = {
    create: [],
    keptByDate: [],
    keptByName: [],
    renamed: [],
    unlisted: [],
  };

  /**
   * DB rows that some list entry recognised, by date or by name. `unlisted` is
   * exactly the **remainder**, so the two lists can never contradict each
   * other about the same row.
   */
  const claimed = new Set<string>();

  for (const entry of entries) {
    const onDate = byDate.get(entry.date);
    const sameName = byName.get(nameKey(entry.date, entry.name));

    if (onDate !== undefined) claimed.add(onDate.date);
    if (sameName !== undefined) claimed.add(sameName.date);

    if (onDate !== undefined) {
      plan.keptByDate.push(entry);
      if (onDate.name.trim() !== entry.name.trim()) {
        plan.renamed.push({
          date: entry.date,
          inDb: onDate.name,
          inList: entry.name,
        });
      }
      continue;
    }

    if (sameName !== undefined) {
      plan.keptByName.push({ entry, foundAt: sameName.date });
      continue;
    }

    plan.create.push(entry);
  }

  plan.unlisted = inScope.filter((row) => !claimed.has(row.date));

  return plan;
}

/**
 * Which years the seed touches this time.
 *
 * Important: **a year that has been seeded once is never touched again.** If
 * the owner **deletes** a day (the company works it anyway), the DB keeps no
 * trace of it; the next seed would see the day as missing and insert it again,
 * counting one holiday too many.
 *
 * To deliberately seed a year again, remove it from the `settings` row; that
 * is a conscious decision, not an accident.
 */
export function yearsToSeed(
  all: readonly number[],
  seeded: readonly number[],
): number[] {
  const done = new Set(seeded);
  return all.filter((year) => !done.has(year)).sort((a, b) => a - b);
}

// ── what one run does ───────────────────────────────────────────────────────

/**
 * When the run happens, and with whose consent.
 *
 * Both fields are **required, with no default**, on purpose. A default for
 * `allowPast` would either silently insert past months (the very bug being
 * prevented) or silently block everything. The caller must state both.
 */
export interface SeedTiming {
  /** Today's date in the work zone, `YYYY-MM-DD`: `workToday(new Date())`. */
  today: string;
  /**
   * **Explicit consent** to insert holidays in the current and past months
   * (`SEED_HOLIDAYS_PAST=true`, `--allow-past`). Setting it to `true` means
   * agreeing to change those months' targets and the payroll denominator; see
   * the note on `isSettledMonth()`.
   */
  allowPast: boolean;
}

/** The full outcome of one run; computable without a DB, so testable. */
export interface HolidaySeedRun {
  /** Will really be inserted this time. */
  create: HolidayEntry[];
  /**
   * In the list, not in the DB, and the year is open, yet not inserted because
   * the date falls in a **current or past month** and consent (`allowPast`)
   * was not given. Never dropped silently; each one is listed in the notes
   * **by name and date**.
   */
  needsConsent: HolidayEntry[];
  /**
   * In the list, **not** in the DB, yet not inserted because the year was
   * seeded earlier. Usually it means the owner deleted the row, which is
   * correct. It is still reported by name: staying silent would suggest that
   * the list and the DB are identical.
   */
  heldBack: HolidayEntry[];
  /** Already in the DB: matched by date or by name. */
  kept: number;
  /** Notes printed on every run, whether or not anything was inserted. */
  notes: string[];
}

/**
 * List + DB + "which years are still open" gives this run's outcome.
 *
 * **One plan, one truth.** The plan is made over the whole list every time; the
 * year filter decides only **what gets inserted**, not **what gets reported**
 * — otherwise, once every year was seeded, the `unlisted`/`renamed` notes
 * would go silent for good.
 *
 * **Two separate filters, for two separate reasons**, deliberately not merged:
 * - `heldBack`: the year was seeded earlier, so a day the owner deleted is not
 *   brought back.
 * - `needsConsent`: the month's figures are already out, so money must not move.
 * A row that falls in both goes **only into `heldBack`**: if the year is closed
 * it would not be inserted even with consent, so asking for consent would give
 * false hope.
 */
export function planHolidaySeedRun(
  entries: readonly HolidayEntry[],
  existing: readonly ExistingHoliday[],
  openYears: readonly number[],
  when: SeedTiming,
): HolidaySeedRun {
  const plan = planHolidaySeed(entries, existing);
  const open = new Set(openYears);

  const heldBack = plan.create.filter((e) => !open.has(yearOf(e.date)));
  const inOpenYear = plan.create.filter((e) => open.has(yearOf(e.date)));

  const settled = inOpenYear.filter((e) => isSettledMonth(e.date, when.today));
  const future = inOpenYear.filter((e) => !isSettledMonth(e.date, when.today));

  const needsConsent = when.allowPast ? [] : settled;
  const create = when.allowPast ? inOpenYear : future;

  /**
   * The order is deliberate: **what needs the owner's attention** (⚠️) comes
   * first, then what is merely informational (·). When the console output is
   * long, the top lines are the ones that get read. The money warning (⚠️⚠️)
   * comes before everything else.
   */
  const notes = [
    ...needsConsent.map(
      (e) =>
        `⚠️⚠️ Not inserted: ${e.date} — "${e.name}" ` +
        `(the figures for ${monthKey(e.date)} are already out)`,
    ),
    /**
     * Careful: the last two sentences of this note were **verified, not
     * guessed** (`src/summary/summary-refresh.job.ts`,
     * `src/summary/day-close.job.ts`, `src/adjustments/adjustments.service.ts`):
     * the current month's rollup is rewritten automatically every 15 minutes,
     * but a past month's rows change only when a time adjustment for that
     * month is approved or cancelled.
     */
    ...(needsConsent.length > 0
      ? [
          `⚠️⚠️ Inserting the ${needsConsent.length} dates above would reduce the working days of those months — ` +
            `target_sec · expected_sec · pace_sec and the payroll d÷D fraction would all change (real money). ` +
            `The current month moves to the new figures by itself within 15 minutes; ` +
            `a past month stays fixed, then jumps suddenly the day any time adjustment for that month is approved. ` +
            `To insert them on purpose: SEED_HOLIDAYS_PAST=true.`,
        ]
      : []),
    ...plan.unlisted.map(
      (row) => `⚠️ Not in the list: ${row.date} — "${row.name}" (is it still a holiday?)`,
    ),
    ...plan.renamed.map(
      (diff) =>
        `⚠️ Same date, different name: ${diff.date} — DB has "${diff.inDb}", list has "${diff.inList}" — ` +
        `the seed does not rename; to rename it, go to Settings → Holidays`,
    ),
    ...heldBack.map(
      (e) =>
        `⚠️ In the list but not in the DB: ${e.date} — "${e.name}" (${yearOf(e.date)} was seeded earlier, so it was not inserted)`,
    ),
    ...plan.keptByName.map(
      (kept) =>
        `· "${kept.entry.name}" is on ${kept.foundAt} (list has ${kept.entry.date}) — left untouched`,
    ),
  ];

  return {
    create,
    needsConsent,
    heldBack,
    kept: plan.keptByDate.length + plan.keptByName.length,
    notes,
  };
}

/**
 * Which years are marked "fully seeded" after this run.
 *
 * Important: **a year that still has rows waiting for consent is not closed.**
 * Otherwise the current year would close on the very first run, and running
 * with `SEED_HOLIDAYS_PAST=true` would then insert nothing (`yearsToSeed` would
 * skip the year), so the flag would exist but not work.
 *
 * There is a cost, and it is not hidden: as long as a year has rows waiting
 * for consent it stays open, so if the owner deletes a holiday in that year's
 * **future months**, the next seed may insert it again. This is still the
 * lesser evil: an extra holiday in a future month is visible and can be
 * deleted by hand, whereas a consent flag that silently does nothing would
 * never be caught.
 */
export function yearsSettled(
  openYears: readonly number[],
  pending: readonly HolidayEntry[],
): number[] {
  const blocked = new Set(pending.map((e) => yearOf(e.date)));
  return openYears.filter((year) => !blocked.has(year));
}
