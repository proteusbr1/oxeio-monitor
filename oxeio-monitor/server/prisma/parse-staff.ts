/**
 * Reads and validates `staff.local.json` — pure functions, no I/O.
 *
 * Why a separate file: importing `seed.ts` starts it running (`main()` is
 * called at the bottom), so nothing inside it can be tested. This file decides
 * **who earns what**, so it is the right place to catch mistakes.
 *
 * Important: there used to be no validation at all, only
 * `JSON.parse(...) as Staff[]`, which lies to TypeScript. The results:
 *
 * - A three-column row left `monthlySalary` `undefined`, and Prisma failed with
 *   a message that **did not say which employee's row was wrong**.
 * - `"25000"` (quoted) gave a Prisma type error with the same vague message.
 * - `25000.5` silently lost the fraction, because the column is an `Int`.
 *
 * So every message includes the **employee code and the field name**; in a
 * 12-row file you should not have to hunt for the row to fix.
 */

/** One validated row, with `joinedOn` converted to a Date. */
export interface StaffRow {
  empCode: string;
  fullName: string;
  designation: string;
  monthlySalary: number;
  /** Careful: `undefined` means "leave the column untouched", not `null` (see below). */
  joinedOn?: Date;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `YYYY-MM-DD` to UTC midnight.
 *
 * Careful: `@db.Date` columns use UTC midnight (so does `countWorkdays`).
 * Building the date in local time would turn `2026-01-05` into the **previous
 * day** in Dhaka, and someone who joined on the 1st of a month would land in
 * the previous month.
 */
function parseDate(where: string, value: string): Date {
  if (!DATE.test(value)) {
    throw new Error(`${where}: joinedOn "${value}" — YYYY-MM-DD হতে হবে`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${where}: joinedOn "${value}" — এমন কোনো তারিখ নেই`);
  }

  /**
   * `2026-02-30` becomes 2 March in JS instead of `Invalid Date`. Without
   * this round-trip comparison the typo would go straight into proration.
   */
  if (date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${where}: joinedOn "${value}" — এমন কোনো তারিখ নেই`);
  }
  return date;
}

function str(where: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where}: ${field} — লেখা হতে হবে, খালি নয়`);
  }
  return value.trim();
}

/**
 * @param raw The result of `JSON.parse()` — not trusted.
 *
 * Careful: on a bad row this **throws**; it does not skip the row. Skipping
 * would silently drop an employee, and nobody would notice until payroll at
 * the end of the month.
 */
export function parseStaff(raw: unknown): StaffRow[] {
  if (!Array.isArray(raw)) {
    throw new Error('staff ফাইলটা একটা তালিকা (array) হতে হবে');
  }

  const rows: StaffRow[] = [];
  const seen = new Set<string>();

  raw.forEach((row: unknown, i: number) => {
    // Row numbers start at 1 so they match counting rows in the open file.
    const at = `সারি ${i + 1}`;

    if (!Array.isArray(row) || row.length < 4 || row.length > 5) {
      throw new Error(
        `${at}: ["কোড", "নাম", "পদবি", বেতন] — চার বা পাঁচ ঘর লাগে, পাওয়া গেছে ${
          Array.isArray(row) ? row.length : typeof row
        }`,
      );
    }

    const empCode = str(at, 'কোড', row[0]);
    const where = `${at} (${empCode})`;

    /**
     * Careful: with a duplicate code the seed's upsert would **overwrite the
     * first row with the second**: one employee vanishes without any error
     * and the other's name and salary take their place. Easy to do when the
     * list is built by copy-paste.
     */
    if (seen.has(empCode)) {
      throw new Error(`${where}: এই কোডটা আগেও আছে — প্রতিটা কোড আলাদা হতে হবে`);
    }
    seen.add(empCode);

    const monthlySalary = row[3];
    if (typeof monthlySalary !== 'number' || !Number.isFinite(monthlySalary)) {
      throw new Error(
        `${where}: বেতন সংখ্যা হতে হবে — উদ্ধৃতি ছাড়া, যেমন 25000`,
      );
    }
    // The column is an `Int`; a fraction would be silently truncated.
    if (!Number.isInteger(monthlySalary) || monthlySalary < 0) {
      throw new Error(`${where}: বেতন ভগ্নাংশ বা ঋণাত্মক হতে পারে না`);
    }

    rows.push({
      empCode,
      fullName: str(where, 'নাম', row[1]),
      designation: str(where, 'পদবি', row[2]),
      monthlySalary,
      ...(row[4] === undefined
        ? {}
        : { joinedOn: parseDate(where, str(where, 'joinedOn', row[4])) }),
    });
  });

  return rows;
}

/**
 * Whether the seed should insert staff when it is running from the sample list.
 *
 * Important: this guards against a production bug. `staff.local.json` is
 * **gitignored**, so it never exists on the VPS, and every seed run there
 * created the three sample employees from `staff.example.json` (salary 0).
 * That is exactly how they got into production, adding **624 hours** to the
 * team target and making the "how far behind" figure wrong.
 *
 * The rule is deliberately **narrow**: it applies only to the sample list, and
 * only when the database already has employees.
 * - With a real list (`staff.local.json`) the seed inserts everything as
 *   before, so updating staff still works.
 * - With an empty database the samples are inserted as before; otherwise
 *   nobody could clone the repo and just try the project.
 *
 * Careful: "empty" means **zero** employees, not "zero active" — a live system
 * where everyone was deactivated must not get the sample people back.
 */
export function shouldSeedSampleStaff(
  usingExample: boolean,
  existingEmployees: number,
): boolean {
  if (!usingExample) return true;
  return existingEmployees === 0;
}
