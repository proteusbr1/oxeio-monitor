/**
 * Bangladesh public holidays 2026–27: the list and its validation.
 * Pure functions, no I/O (same as `parse-staff.ts`, for the same reason:
 * importing `seed.ts` starts it running, so nothing inside it can be tested).
 *
 * Why this exists: the seed only had 7 fixed-date holidays. Eid, Ashura,
 * Shab-e-Barat and Durga Puja were all missing, so those days counted as
 * **workdays** and everyone's target and pace looked too high (deploy/README.md
 * section 2.1b). The two Eids of 2026 alone put 11 days on the wrong side.
 *
 * --- The most important decision in this file: `approximate` ---
 *
 * Lunar holiday dates **depend on moon sighting**: the government publishes a
 * probable date in advance and corrects the notification once the moon is
 * announced. Holidays on the Hindu and Buddhist calendars follow lunar days
 * (tithi) and move in the same way.
 *
 * Leaving out anything uncertain used to be one kind of lie ("no holiday").
 * But presenting an estimated date as certain is **another kind of lie**, and a
 * worse one, because nobody would think to verify it. So every row has
 * `approximate`, and when it is `true` a Bengali "probable" marker is appended
 * to the name stored in the DB, so the owner can **see on the Settings ->
 * Holidays page** which dates are not final yet.
 *
 * Careful: the marker is not stored in the `type` column, although that looks
 * like the natural place. The screen's Type picker has only three values
 * (public/optional/company); with an unknown value, the moment the owner edited
 * the holiday and pressed Save it would silently come back as `public`, and the
 * marker would be lost without anyone noticing. The owner reads and edits the
 * name column themselves, so the marker survives there.
 *
 * --- Sources (cross-checked on 2026-08-14) ---
 *
 * 2026: Ministry of Public Administration notification (2025-11-09, 28 days in
 *   all: 14 general + 14 by executive order). Careful: the PDF on mopa.gov.bd
 *   is a **scanned image**, so the rows could not be read from it directly. The
 *   dates below were matched across four independent sources (bangladatetoday.com,
 *   officeholidays.com, calendarlabs.com, mypihr.com), and the **weekday** of
 *   every date was checked separately (all match).
 * 2027: Careful: **the notification has not been published yet**; it usually
 *   comes out in November. The 2027 lunar dates are astronomical calculations,
 *   not government decisions.
 *
 * Careful: **fixed-date holidays have an uncertainty for 2027 too, but of a
 *   different kind.** Nobody doubts when 26 March falls; the doubt is whether
 *   the day will still be a public holiday (the list changes: 17 March and
 *   15 August were dropped in 2024, 7 November came back). `approximate` means
 *   **"the date may move"**, not "the holiday may not exist". Mixing the two
 *   would blur the marker's meaning, so fixed-date holidays stay `false` in
 *   2027 as well.
 *
 * Careful: **what this list does not contain:** one-off holidays (mourning,
 *   disasters, strikes), optional religious holidays, and Boishabi in the
 *   Chittagong Hill Tracts. Add those by hand in Settings -> Holidays. The
 *   count below will also not match the official 28 days for 2026, because
 *   1 May carries two holidays (May Day and Buddha Purnima) on the same day and
 *   the `holidays` table has one row per date.
 */

/** One row of the list. */
export interface HolidayEntry {
  /** `YYYY-MM-DD`, the Dhaka date (not a clock reading). */
  date: string;
  /** Bengali name; this is what goes to the DB and the screen. */
  name: string;
  /** English name, kept for searching and future translation (the UI is in English). */
  nameEn: string;
  /**
   * `true` = the date depends on moon sighting or the lunar calendar and the
   * government may change it later. See the long note above; this field is the
   * core of the file.
   */
  approximate: boolean;
  /**
   * Consecutive days of one festival, as a group. Used by the seed: when Eid
   * moves a day earlier or later, the owner moves the **whole group**, so if
   * even one day of a group has been moved by hand the seed leaves the whole
   * group alone (`planHolidaySeed`).
   */
  cluster?: string;
}

/**
 * Appended to the name of an estimated holiday so it stands out on screen.
 *
 * Careful: **the exact same string also exists in `src/reports/reports.range.ts`**
 * (`APPROX_HOLIDAY_SUFFIX`): the seed **writes** it, the report **reads** it.
 * One could not import the other, because each direction breaks something:
 * - `src/` -> `prisma/` moves the `rootDir` of `nest build`, so the output lands
 *   in `dist/src/main.js` while `start:prod` runs `dist/main.js`.
 * - `prisma/` -> `src/` would break the seed in the **runtime image**, which has
 *   `prisma/` and `dist/` but no `src/` (`server/Dockerfile`).
 * So there are two copies, and `test/holidays.spec.ts` checks they match. If the
 * copy drifted, the seed would still write the marker but the report would not
 * recognise it and would say "no probable dates" forever, and the uncertainty
 * would vanish silently.
 */
export const APPROX_SUFFIX = ' (সম্ভাব্য)';

// ── 2026 ────────────────────────────────────────────────────────────────────

const HOLIDAYS_2026: HolidayEntry[] = [
  {
    date: '2026-02-04',
    name: 'শবে বরাত',
    nameEn: 'Shab-e-Barat',
    approximate: true,
  },
  /**
   * One-off holiday, not part of the regular yearly list: an executive order
   * gave the whole country a holiday for the 13th Parliamentary Election and
   * Referendum (Ministry of Public Administration order, also in several
   * departments' notices). It is kept because those two days really were not
   * workdays; leaving them out would still overstate February 2026's target by
   * two days. Careful: do **not copy** these two into next year's list.
   */
  {
    date: '2026-02-11',
    name: 'ত্রয়োদশ জাতীয় সংসদ নির্বাচন (ভোটের আগের দিন)',
    nameEn: '13th Parliamentary Election (day before poll)',
    approximate: false,
    cluster: 'election-2026',
  },
  {
    date: '2026-02-12',
    name: 'ত্রয়োদশ জাতীয় সংসদ নির্বাচন ও গণভোট',
    nameEn: '13th Parliamentary Election & Referendum',
    approximate: false,
    cluster: 'election-2026',
  },
  {
    date: '2026-02-21',
    name: 'শহীদ দিবস ও আন্তর্জাতিক মাতৃভাষা দিবস',
    nameEn: 'Language Martyrs’ Day',
    approximate: false,
  },
  {
    date: '2026-03-17',
    name: 'শবে কদর',
    nameEn: 'Laylat al-Qadr',
    approximate: true,
  },
  // Eid-ul-Fitr: 19–23 March (5 days), Eid on 21 March. All four sources agree.
  {
    date: '2026-03-19',
    name: 'ঈদুল ফিতরের ছুটি (ঈদের আগের দিন)',
    nameEn: 'Eid-ul-Fitr holiday (eve)',
    approximate: true,
    cluster: 'eid-ul-fitr-2026',
  },
  {
    date: '2026-03-20',
    name: 'জুমাতুল বিদা ও ঈদুল ফিতরের ছুটি',
    nameEn: 'Jumatul Bida & Eid-ul-Fitr holiday',
    approximate: true,
    cluster: 'eid-ul-fitr-2026',
  },
  {
    date: '2026-03-21',
    name: 'ঈদুল ফিতর',
    nameEn: 'Eid-ul-Fitr',
    approximate: true,
    cluster: 'eid-ul-fitr-2026',
  },
  {
    date: '2026-03-22',
    name: 'ঈদুল ফিতরের ছুটি (২য় দিন)',
    nameEn: 'Eid-ul-Fitr holiday (2nd day)',
    approximate: true,
    cluster: 'eid-ul-fitr-2026',
  },
  {
    date: '2026-03-23',
    name: 'ঈদুল ফিতরের ছুটি (৩য় দিন)',
    nameEn: 'Eid-ul-Fitr holiday (3rd day)',
    approximate: true,
    cluster: 'eid-ul-fitr-2026',
  },
  {
    date: '2026-03-26',
    name: 'স্বাধীনতা ও জাতীয় দিবস',
    nameEn: 'Independence Day',
    approximate: false,
  },
  {
    date: '2026-04-14',
    name: 'পহেলা বৈশাখ (বাংলা নববর্ষ)',
    nameEn: 'Pahela Baishakh (Bengali New Year)',
    approximate: false,
  },
  /**
   * Two holidays fall on this day, but `holiday_date` is unique, so there is
   * one row. Buddha Purnima is lunar (it moves); May Day does not. The day is
   * a certain holiday because of May Day, so the row is `approximate: false`;
   * otherwise a firm holiday would be marked "probable".
   */
  {
    date: '2026-05-01',
    name: 'মে দিবস ও বুদ্ধ পূর্ণিমা',
    nameEn: 'May Day & Buddha Purnima',
    approximate: false,
  },
  // Eid-ul-Azha: 26–31 May (6 days), Eid on 28 May. All four sources agree.
  {
    date: '2026-05-26',
    name: 'ঈদুল আজহার ছুটি (১ম দিন)',
    nameEn: 'Eid-ul-Azha holiday (1st day)',
    approximate: true,
    cluster: 'eid-ul-azha-2026',
  },
  {
    date: '2026-05-27',
    name: 'ঈদুল আজহার ছুটি (ঈদের আগের দিন)',
    nameEn: 'Eid-ul-Azha holiday (eve)',
    approximate: true,
    cluster: 'eid-ul-azha-2026',
  },
  {
    date: '2026-05-28',
    name: 'ঈদুল আজহা',
    nameEn: 'Eid-ul-Azha',
    approximate: true,
    cluster: 'eid-ul-azha-2026',
  },
  {
    date: '2026-05-29',
    name: 'ঈদুল আজহার ছুটি (২য় দিন)',
    nameEn: 'Eid-ul-Azha holiday (2nd day)',
    approximate: true,
    cluster: 'eid-ul-azha-2026',
  },
  {
    date: '2026-05-30',
    name: 'ঈদুল আজহার ছুটি (৩য় দিন)',
    nameEn: 'Eid-ul-Azha holiday (3rd day)',
    approximate: true,
    cluster: 'eid-ul-azha-2026',
  },
  {
    date: '2026-05-31',
    name: 'ঈদুল আজহার ছুটি (৪র্থ দিন)',
    nameEn: 'Eid-ul-Azha holiday (4th day)',
    approximate: true,
    cluster: 'eid-ul-azha-2026',
  },
  {
    date: '2026-06-26',
    name: 'পবিত্র আশুরা',
    nameEn: 'Ashura',
    approximate: true,
  },
  {
    date: '2026-08-05',
    name: 'জুলাই গণঅভ্যুত্থান দিবস',
    nameEn: 'July Mass Uprising Day',
    approximate: false,
  },
  {
    date: '2026-08-26',
    name: 'ঈদে মিলাদুন্নবী (সা.)',
    nameEn: 'Eid-e-Miladunnabi',
    approximate: true,
  },
  {
    date: '2026-09-04',
    name: 'শুভ জন্মাষ্টমী',
    nameEn: 'Janmashtami',
    approximate: true,
  },
  {
    date: '2026-10-20',
    name: 'দুর্গাপূজা (মহানবমী)',
    nameEn: 'Durga Puja (Maha Navami)',
    approximate: true,
    cluster: 'durga-puja-2026',
  },
  {
    date: '2026-10-21',
    name: 'বিজয়া দশমী (দুর্গাপূজা)',
    nameEn: 'Vijaya Dashami (Durga Puja)',
    approximate: true,
    cluster: 'durga-puja-2026',
  },
  /**
   * The notification is from November 2025, but the cabinet restored this
   * holiday on 16 April 2026 (as a "Class A day"). So it is outside the main
   * list, and building from that list alone would have missed it.
   */
  {
    date: '2026-11-07',
    name: 'জাতীয় বিপ্লব ও সংহতি দিবস',
    nameEn: 'National Revolution and Solidarity Day',
    approximate: false,
  },
  {
    date: '2026-12-16',
    name: 'বিজয় দিবস',
    nameEn: 'Victory Day',
    approximate: false,
  },
  {
    date: '2026-12-25',
    name: 'বড়দিন',
    nameEn: 'Christmas Day',
    approximate: false,
  },
];

// ── 2027 ────────────────────────────────────────────────────────────────────
//
// Careful: the notification has **not been published yet**. The lunar dates
// are calculations, not government decisions, so all of them are
// `approximate: true`.
// The Eid holidays look short here (3 days) because the sources only agree on
// those days. Once the notification is out, Bangladesh usually gives more
// days. The rest were not guessed, because wrongly saying "holiday" would push
// the workday count in the opposite direction.

const HOLIDAYS_2027: HolidayEntry[] = [
  {
    date: '2027-01-24',
    name: 'শবে বরাত',
    nameEn: 'Shab-e-Barat',
    approximate: true,
  },
  {
    date: '2027-02-21',
    name: 'শহীদ দিবস ও আন্তর্জাতিক মাতৃভাষা দিবস',
    nameEn: 'Language Martyrs’ Day',
    approximate: false,
  },
  {
    date: '2027-03-05',
    name: 'জুমাতুল বিদা',
    nameEn: 'Jumatul Bida',
    approximate: true,
  },
  {
    date: '2027-03-06',
    name: 'শবে কদর',
    nameEn: 'Laylat al-Qadr',
    approximate: true,
  },
  {
    date: '2027-03-09',
    name: 'ঈদুল ফিতর',
    nameEn: 'Eid-ul-Fitr',
    approximate: true,
    cluster: 'eid-ul-fitr-2027',
  },
  {
    date: '2027-03-10',
    name: 'ঈদুল ফিতরের ছুটি (২য় দিন)',
    nameEn: 'Eid-ul-Fitr holiday (2nd day)',
    approximate: true,
    cluster: 'eid-ul-fitr-2027',
  },
  {
    date: '2027-03-11',
    name: 'ঈদুল ফিতরের ছুটি (৩য় দিন)',
    nameEn: 'Eid-ul-Fitr holiday (3rd day)',
    approximate: true,
    cluster: 'eid-ul-fitr-2027',
  },
  {
    date: '2027-03-26',
    name: 'স্বাধীনতা ও জাতীয় দিবস',
    nameEn: 'Independence Day',
    approximate: false,
  },
  {
    date: '2027-04-14',
    name: 'পহেলা বৈশাখ (বাংলা নববর্ষ)',
    nameEn: 'Pahela Baishakh (Bengali New Year)',
    approximate: false,
  },
  {
    date: '2027-05-01',
    name: 'মে দিবস',
    nameEn: 'May Day',
    approximate: false,
  },
  {
    date: '2027-05-16',
    name: 'ঈদুল আজহার ছুটি (ঈদের আগের দিন)',
    nameEn: 'Eid-ul-Azha holiday (eve)',
    approximate: true,
    cluster: 'eid-ul-azha-2027',
  },
  {
    date: '2027-05-17',
    name: 'ঈদুল আজহা',
    nameEn: 'Eid-ul-Azha',
    approximate: true,
    cluster: 'eid-ul-azha-2027',
  },
  {
    date: '2027-05-18',
    name: 'ঈদুল আজহার ছুটি (২য় দিন)',
    nameEn: 'Eid-ul-Azha holiday (2nd day)',
    approximate: true,
    cluster: 'eid-ul-azha-2027',
  },
  {
    date: '2027-05-20',
    name: 'বুদ্ধ পূর্ণিমা',
    nameEn: 'Buddha Purnima',
    approximate: true,
  },
  {
    date: '2027-06-15',
    name: 'পবিত্র আশুরা',
    nameEn: 'Ashura',
    approximate: true,
  },
  {
    date: '2027-08-05',
    name: 'জুলাই গণঅভ্যুত্থান দিবস',
    nameEn: 'July Mass Uprising Day',
    approximate: false,
  },
  {
    date: '2027-08-15',
    name: 'ঈদে মিলাদুন্নবী (সা.)',
    nameEn: 'Eid-e-Miladunnabi',
    approximate: true,
  },
  // Two sources differ by one day (24 vs 25 August). It is lunar and so
  // `approximate` anyway; one was picked and the other not inserted.
  {
    date: '2027-08-25',
    name: 'শুভ জন্মাষ্টমী',
    nameEn: 'Janmashtami',
    approximate: true,
  },
  {
    date: '2027-10-09',
    name: 'দুর্গাপূজা (মহানবমী)',
    nameEn: 'Durga Puja (Maha Navami)',
    approximate: true,
    cluster: 'durga-puja-2027',
  },
  {
    date: '2027-10-10',
    name: 'বিজয়া দশমী (দুর্গাপূজা)',
    nameEn: 'Vijaya Dashami (Durga Puja)',
    approximate: true,
    cluster: 'durga-puja-2027',
  },
  {
    date: '2027-11-07',
    name: 'জাতীয় বিপ্লব ও সংহতি দিবস',
    nameEn: 'National Revolution and Solidarity Day',
    approximate: false,
  },
  {
    date: '2027-12-16',
    name: 'বিজয় দিবস',
    nameEn: 'Victory Day',
    approximate: false,
  },
  {
    date: '2027-12-25',
    name: 'বড়দিন',
    nameEn: 'Christmas Day',
    approximate: false,
  },
];

/** The full list, sorted by date. */
export const BD_HOLIDAYS: readonly HolidayEntry[] = [
  ...HOLIDAYS_2026,
  ...HOLIDAYS_2027,
];

/** The years the list covers; the seed only looks at rows for these years. */
export const HOLIDAY_YEARS: readonly number[] = [
  ...new Set(BD_HOLIDAYS.map((h) => yearOf(h.date))),
];

// ── years whose notification is not out yet ─────────────────────────────────

/** A year still waiting for its notification. */
export interface PendingGazette {
  year: number;
  /** When the notification is expected, so the owner knows when to re-check. */
  dueBy: string;
}

/**
 * **Years whose official notification is not out yet.**
 *
 * That year's lunar dates are astronomical calculations, not government
 * decisions (see the sources note at the top of the file). They are in the list
 * anyway, because saying "no holiday" is more wrong than saying "probably a
 * holiday".
 *
 * But we must not stay silent: as soon as the rows are inserted they **change
 * `monthWorkdays` for future months**, so those months' targets already rest on
 * an estimate. The seed counts and reports this on every run (`gazetteNotes`).
 *
 * What to do when the notification is out: check the dates, fix the list in
 * this file, then **remove the year from here**. Otherwise the warning would
 * keep firing falsely and after a while nobody would read it.
 */
export const PENDING_GAZETTES: readonly PendingGazette[] = [
  { year: 2027, dueBy: 'নভেম্বর ২০২৬' },
];

/**
 * The seed's warning about years without a notification: **how many dates, and
 * when to re-check them**.
 *
 * Important: only `approximate` rows are counted, not every row of the year.
 * When 26 March falls does not depend on the notification; the doubt about
 * fixed-date days is of another kind ("will the day still be a holiday?"), and
 * mixing it into this number would give **one number, two definitions**.
 *
 * If the count is zero there is no message; there is no point talking about
 * an uncertainty that does not exist.
 */
export function gazetteNotes(
  entries: readonly HolidayEntry[],
  pending: readonly PendingGazette[] = PENDING_GAZETTES,
): string[] {
  return pending.flatMap(({ year, dueBy }) => {
    const unsure = entries.filter(
      (e) => yearOf(e.date) === year && e.approximate,
    );
    if (unsure.length === 0) return [];

    return [
      `⚠️ ${year}-এর ${unsure.length}টি তারিখ জ্যোতির্গণনার হিসাব — প্রজ্ঞাপন এখনো বেরোয়নি ` +
        `(${unsure[0].date} … ${unsure[unsure.length - 1].date})। ` +
        `ওগুলো এখনই ${year}-এর ওই মাসগুলোর কর্মদিবস ও টার্গেট ঠিক করছে। ` +
        `${dueBy}-এ প্রজ্ঞাপনের সাথে মিলিয়ে prisma/holidays.data.ts হালনাগাদ করুন।`,
    ];
  });
}

// ── validation ──────────────────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether `YYYY-MM-DD` is a real date.
 *
 * Careful: `new Date('2026-02-30')` **does not throw**; JS quietly makes it
 * 2 March. Without this round-trip check a typo in the list would go straight
 * into the workday count and turn some other day into a holiday.
 */
export function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

/** Call only with a valid date; `isRealDate()` is assumed to have run first. */
export function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * Finds mistakes in the list and returns their messages (empty means all good).
 *
 * It **does not stop at the first one; all problems are returned together**.
 * Otherwise fixing a 50-row list would mean finding one error at a time.
 */
export function validateHolidays(entries: readonly HolidayEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();

  entries.forEach((entry, i) => {
    const at = `সারি ${i + 1}`;

    if (!isRealDate(entry.date)) {
      problems.push(`${at}: "${entry.date}" — এমন কোনো তারিখ নেই`);
      return; // with a bad date the remaining checks are meaningless
    }

    /**
     * Careful: with a duplicate date the seed's upsert would **overwrite the
     * first row with the second**, with no error, because `holiday_date` is
     * unique. Easy to do when typing a cluster (Eid) by hand.
     */
    const before = seen.get(entry.date);
    if (before !== undefined) {
      problems.push(
        `${at}: ${entry.date} তারিখটা আগেও আছে ("${before}") — একটা তারিখে একটাই সারি`,
      );
    }
    seen.set(entry.date, entry.name);

    if (entry.name.trim() === '') {
      problems.push(`${at} (${entry.date}): নাম খালি`);
    }
    if (entry.nameEn.trim() === '') {
      problems.push(`${at} (${entry.date}): ইংরেজি নাম খালি`);
    }
    /** The API limits the `name` column to 120 characters (`CreateHolidayDto`). */
    if (holidayRowName(entry).length > 120) {
      problems.push(`${at} (${entry.date}): নাম ১২০ অক্ষরের বেশি`);
    }
    /**
     * Writing the "probable" marker into the name by hand would contradict
     * `approximate: false` and would also get appended twice.
     */
    if (entry.name.includes(APPROX_SUFFIX.trim())) {
      problems.push(
        `${at} (${entry.date}): নামে "${APPROX_SUFFIX.trim()}" লিখবেন না — approximate ঘরটাই যথেষ্ট`,
      );
    }
  });

  return problems;
}

// ── what goes into the DB ───────────────────────────────────────────────────

/**
 * What goes into the DB `name` column.
 *
 * An estimated holiday gets the "probable" marker appended, so the owner sees
 * on screen that the date is not final and fixes it once it is announced.
 */
export function holidayRowName(entry: HolidayEntry): string {
  return entry.approximate ? `${entry.name}${APPROX_SUFFIX}` : entry.name;
}

/**
 * Whether the name **ends with** the "probable" marker.
 *
 * Only the tail is checked, not `includes`: a parenthesis in the middle of a
 * name is not the marker. `isApproximateHoliday` in `src/reports/reports.range.ts`
 * follows exactly the same rule; `test/holidays.spec.ts` checks that the two
 * stay identical.
 */
export function hasApproxSuffix(name: string): boolean {
  return name.trim().endsWith(APPROX_SUFFIX.trim());
}

/** Strips the marker before comparing, so a row is still recognised without it. */
export function baseName(name: string): string {
  const trimmed = name.trim();
  return hasApproxSuffix(trimmed)
    ? trimmed.slice(0, -APPROX_SUFFIX.trim().length).trim()
    : trimmed;
}

// ── which months' figures are already out ───────────────────────────────────

/** `YYYY-MM-DD` to `YYYY-MM`. Call only with a valid date. */
export function monthKey(date: string): string {
  return date.slice(0, 7);
}

/**
 * **Today's** date in Dhaka (`YYYY-MM-DD`).
 *
 * Careful: `toISOString()` **always gives the UTC date**, whatever the
 * machine's TZ. Between midnight and 6 am in Dhaka the UTC date is still the
 * previous day, so the 6 hours are added **first**, `toISOString()` after.
 * Otherwise a seed run in the small hours of the 1st would see "today" in the
 * previous month, treat **that month as the current one**, and silently insert
 * holidays into the month that just ended, shifting its payroll.
 *
 * Careful: the machine's local time is deliberately not used. The compose
 * `migrate` service does set `TZ=Asia/Dhaka`, but `npm run seed` may run on the
 * owner's laptop in any time zone, and "today" would then differ per machine.
 *
 * Bangladesh is UTC+6 and had DST only once, in 2009, cancelled the same year.
 * Adding 6 hours is therefore enough and `Intl` is not needed (the dhaka-time
 * helper in `src/` cannot be imported from `prisma/`; see the note at the top
 * of the file).
 */
export function dhakaToday(now: Date): string {
  const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
  return new Date(now.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
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
 * There is **no payroll lock (roadmap R1) yet**; with one, this function would
 * ask "is the month locked?". Until then the calendar is the only safeguard,
 * and it is deliberately **over-cautious**: wrongly calling a future month
 * "closed" costs at most adding a date by hand, while the reverse moves money.
 */
export function isSettledMonth(date: string, today: string): boolean {
  return monthKey(date) <= monthKey(today);
}

// ── the seed plan ───────────────────────────────────────────────────────────

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
  /** One day of the cluster was seen moved, so the **whole cluster** is left alone. */
  keptByCluster: HolidayEntry[];
  /** Same date but a different name in the DB; reported to the owner. */
  renamed: { date: string; inDb: string; inList: string }[];
  /**
   * DB rows (in the covered years) that **no row of the list recognised**.
   * They are **never deleted**, only reported.
   *
   * Careful: "recognised" means matching by date **or by name**. It used to
   * check only the date, and the seed then said **two contradictory things**
   * about one row: if the owner moved Victory Day from 16 to 15 December, the
   * row landed in `keptByName` ("owner moved it, left untouched") **and** in
   * `unlisted` ("not in the list; is it still a holiday?"). When two truths are
   * printed about one thing, the reader trusts neither, and the other notes
   * depend on exactly that trust.
   */
  unlisted: ExistingHoliday[];
}

/**
 * Decides which rows get inserted and which do not: a pure computation that
 * can be tested without a DB.
 *
 * Main rule: **the seed never changes or deletes anything; it only inserts
 * missing rows.** The old code did `update: { name }`; keeping that would have
 * brought back the "probable" marker on a name the owner had corrected after
 * the announcement, on the next `db seed`.
 *
 * Careful: **the date is the key, so something slips through.** If the owner
 * moves the Eid row from 21 to 20 March, the 21st is then empty; checking only
 * the date, the seed would create another Eid there, i.e. **an extra
 * holiday**. So matching also uses the name and the cluster.
 *
 * One gap remains: if the owner **deletes** one day of a cluster (Eid
 * shortened from 6 days to 5), it cannot be recognised here, because a deleted
 * row looks the same as one that was never inserted. `seed.ts` handles that
 * separately: once a year has been seeded, the seed never looks at it again.
 */
/**
 * Key for matching by name: **year + trimmed name**.
 *
 * The year is part of the key; otherwise the 2026 "Eid-ul-Fitr" would block the
 * 2027 one, which is a different holiday.
 *
 * Careful: the key is now built in **one place**. It used to be the same
 * template written by hand in three places, with an **invisible NUL byte** in
 * the source as the separator. If an editor or formatter dropped it in one
 * place, the keys would stop matching: the seed would fail to recognise a
 * holiday the owner had moved and insert it again on the old date (an extra
 * holiday, silently reducing workdays), with nothing noticeable in the diff.
 */
function nameKey(date: string, name: string): string {
  return `${yearOf(date)} ${baseName(name)}`;
}

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

  /** First pass: find the clusters the owner moved by hand. */
  const movedClusters = new Set<string>();
  for (const entry of entries) {
    if (entry.cluster === undefined) continue;
    const found = byName.get(nameKey(entry.date, entry.name));
    if (found !== undefined && found.date !== entry.date) {
      movedClusters.add(entry.cluster);
    }
  }

  const plan: SeedPlan = {
    create: [],
    keptByDate: [],
    keptByName: [],
    keptByCluster: [],
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

    /**
     * Careful: the claim is made **before classifying**. Otherwise, for a moved
     * cluster (the `keptByCluster` branch below `continue`s early), nobody would
     * claim the row the owner moved, and Eid would be reported both as "cluster
     * moved by hand" and as "not in the list", two contradictory statements.
     */
    if (onDate !== undefined) claimed.add(onDate.date);
    if (sameName !== undefined) claimed.add(sameName.date);

    if (entry.cluster !== undefined && movedClusters.has(entry.cluster)) {
      plan.keptByCluster.push(entry);
      continue;
    }

    if (onDate !== undefined) {
      plan.keptByDate.push(entry);
      if (baseName(onDate.name) !== baseName(entry.name)) {
        plan.renamed.push({
          date: entry.date,
          inDb: onDate.name,
          inList: holidayRowName(entry),
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
 * the owner **deletes** a day after an announcement, the DB keeps no trace of
 * it; the next seed would see the day as missing and insert it again, counting
 * one holiday too many, the opposite of the mistake this file exists to
 * prevent.
 *
 * A new year added to the list is seeded automatically (in the list, not in
 * `seeded`). To deliberately seed a year again, remove it from the `settings`
 * row; that is a conscious decision, not an accident.
 */
export function yearsToSeed(
  all: readonly number[],
  seeded: readonly number[],
): number[] {
  const done = new Set(seeded);
  return all.filter((year) => !done.has(year)).sort((a, b) => a - b);
}

// ── what one seed run does ──────────────────────────────────────────────────

/**
 * When the seed is running, and with whose consent.
 *
 * Both fields are **required, with no default**, on purpose. A default for
 * `allowPast` would either silently insert past months (the very bug being
 * prevented) or silently block everything. The caller must state both.
 */
export interface SeedTiming {
  /** Today's date in Dhaka, `YYYY-MM-DD`: `dhakaToday(new Date())`. */
  today: string;
  /**
   * **Explicit consent** to insert holidays in the current and past months
   * (`SEED_HOLIDAYS_PAST=true`). Setting it to `true` means agreeing to change
   * those months' targets and the payroll denominator; see the note on
   * `isSettledMonth()`.
   */
  allowPast: boolean;
}

/** The full outcome of one seed run; computable without a DB, so testable. */
export interface HolidaySeedRun {
  /** Will really be inserted this time. */
  create: HolidayEntry[];
  /**
   * In the list, not in the DB, and the year is open, yet not inserted because
   * the date falls in a **current or past month** and consent (`allowPast`)
   * was not given.
   *
   * These are never dropped silently; each one is listed in the notes **by name
   * and date**. "Not inserted" and "no need to insert" are different things,
   * and the owner needs to know which.
   */
  needsConsent: HolidayEntry[];
  /**
   * In the list, **not** in the DB, yet not inserted because the year was
   * seeded earlier. Usually it means the owner deleted the row (an announcement
   * came), which is correct. It is still reported by name: staying silent would
   * suggest that the list and the DB are identical.
   */
  heldBack: HolidayEntry[];
  /** Already in the DB: matched by date, by name or by cluster. */
  kept: number;
  /** Notes printed on every run, whether or not anything was inserted. */
  notes: string[];
}

/**
 * List + DB + "which years are still open" gives this run's outcome.
 *
 * **One plan, one truth.** The seed used to plan only over the rows of the
 * **open years**, so once both years were seeded the `unlisted`/`renamed` notes
 * went **silent for good**. For example, `2026-08-15` (National Mourning Day,
 * dropped from the official list in 2024) sat in an existing DB, removing one
 * August workday, and after the first run the seed never mentioned it again.
 * Saying nothing is not a decision, it is hiding the issue, and the seed was
 * breaking its own rule on the second run.
 *
 * So the year filter now decides only **what gets inserted**, not **what gets
 * reported**. The plan is made over the whole list, every time.
 *
 * Rows outside `openYears` are never inserted; that protection is intact (see
 * the note on `yearsToSeed`).
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
        `⚠️⚠️ বসানো হয়নি: ${e.date} — "${holidayRowName(e)}" ` +
        `(${monthKey(e.date)} মাসের হিসাব ইতিমধ্যে চলে গেছে)`,
    ),
    /**
     * Careful: the last two sentences of this note were **verified, not
     * guessed** (`src/summary/summary-refresh.job.ts`,
     * `src/summary/day-close.job.ts`, `src/adjustments/adjustments.service.ts`):
     * the current month's rollup is rewritten automatically every 15 minutes,
     * but **there is no command or endpoint today to recompute a past month**.
     * Those rows change only when a time adjustment for that month is approved
     * or cancelled. Writing "run the seed, then refresh" would point to a path
     * that does not exist, and the numbers would silently disagree.
     */
    ...(needsConsent.length > 0
      ? [
          `⚠️⚠️ উপরের ${needsConsent.length}টি তারিখ বসালে ওই মাসগুলোর কর্মদিবস কমবে — ` +
            `target_sec · expected_sec · pace_sec আর পে-রোলের d÷D ভগ্নাংশ, সবই বদলাবে (সরাসরি টাকা)। ` +
            `চলতি মাস ১৫ মিনিটের মধ্যে নিজে থেকেই নতুন হিসাবে চলে যাবে; ` +
            `অতীত মাস স্থির থাকবে, তারপর ওই মাসের কোনো time-adjustment অনুমোদনের দিন হঠাৎ লাফ দেবে। ` +
            `সচেতনভাবে বসাতে: SEED_HOLIDAYS_PAST=true — তার আগে deploy/README.md § ২.১গ পড়ুন।`,
        ]
      : []),
    ...plan.unlisted.map(
      (row) => `⚠️ তালিকায় নেই: ${row.date} — "${row.name}" (এখনো ছুটি কি?)`,
    ),
    /**
     * Why the last part of this note is needed: when `planHolidaySeed()` finds
     * a match by date it **does not change the name** (on purpose, so the
     * owner's manual work is not wiped). So a row inserted by an older seed
     * will **never** get the "probable" marker of the list's newer name. This
     * is exactly what happened on the live VPS for 2026-03-17 (DB: "Father of
     * the Nation's birthday", list: "Shab-e-Qadr"). Without this note the
     * uncertainty would stay invisible on that row forever.
     */
    ...plan.renamed.map((diff) => {
      const markLost = hasApproxSuffix(diff.inList) && !hasApproxSuffix(diff.inDb);
      return (
        `⚠️ একই তারিখ, আলাদা নাম: ${diff.date} — DB-তে "${diff.inDb}", তালিকায় "${diff.inList}" — ` +
        `seed নাম বদলায় না` +
        (markLost
          ? `, তাই সারিটা কোনোদিন "${APPROX_SUFFIX.trim()}" চিহ্ন পাবে না; ঠিক করতে Settings → Holidays`
          : `; বদলাতে চাইলে Settings → Holidays`)
      );
    }),
    ...heldBack.map(
      (e) =>
        `⚠️ তালিকায় আছে, DB-তে নেই: ${e.date} — "${holidayRowName(e)}" (${yearOf(e.date)} আগেই বসানো, তাই বসানো হয়নি)`,
    ),
    ...plan.keptByName.map(
      (kept) =>
        `· "${kept.entry.name}" ${kept.foundAt}-এ আছে (তালিকায় ${kept.entry.date}) — ছোঁয়া হয়নি`,
    ),
    ...(plan.keptByCluster.length > 0
      ? [`· ${plan.keptByCluster.length}টি সারি বাদ — গুচ্ছটা হাতে সরানো হয়েছে`]
      : []),
  ];

  return {
    create,
    needsConsent,
    heldBack,
    kept:
      plan.keptByDate.length +
      plan.keptByName.length +
      plan.keptByCluster.length,
    notes,
  };
}

/**
 * Which years are marked "fully seeded" after this run.
 *
 * Important: **a year that still has rows waiting for consent is not closed.**
 * Otherwise 2026 would close on the very first run, and running with
 * `SEED_HOLIDAYS_PAST=true` would then insert nothing (`yearsToSeed` would skip
 * the year), so the flag would exist but not work. Code that does not do what
 * its comment says is worse than a bug.
 *
 * There is a cost, and it is not hidden: as long as a year has rows waiting
 * for consent it stays open, so if the owner deletes a holiday in that year's
 * **future months**, the next seed may insert it again (the gap described in
 * the note on `yearsToSeed`). This is still the lesser evil: an extra holiday
 * in a future month is visible and can be deleted by hand, whereas a consent
 * flag that silently does nothing would never be caught.
 */
export function yearsSettled(
  openYears: readonly number[],
  pending: readonly HolidayEntry[],
): number[] {
  const blocked = new Set(pending.map((e) => yearOf(e.date)));
  return openYears.filter((year) => !blocked.has(year));
}
