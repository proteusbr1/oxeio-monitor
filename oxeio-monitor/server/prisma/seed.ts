/**
 * oXeio — seed data
 *
 *   1. Work policy    — SEED_POLICY_* (default 176 hours a month, Sat+Sun off), screenshots whenever in use
 *   2. App categories — productive / neutral / unproductive rules
 *   3. Holidays       — only with SEED_COUNTRY: that country's public holidays, this year and next
 *   4. Staff          — from `prisma/staff.local.json`
 *   5. Owner account  — from SEED_OWNER_* in .env
 *
 * Safe to run repeatedly: everything is an upsert.
 *
 * Careful: there is **one exception, and it involves money.** Inserting
 * holidays is not a "safe repeat". A new holiday in the current or a past month
 * reduces that month's workdays, changes targets and pace, and changes the
 * payroll `d ÷ D` fraction. So the seed **does not insert anything** in those
 * months by itself; it only prints the dates by name. To insert them, set
 * `SEED_HOLIDAYS_PAST=true`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hash } from '@node-rs/argon2';
import { PrismaClient, UserRole } from '@prisma/client';

import type { ImportedHoliday } from '../src/calendar/holiday-import';
import { publicHolidays } from '../src/calendar/public-holidays';
import { DEFAULT_APP_CATEGORIES } from '../src/setup/default-categories';
import {
  planHolidaySeedRun,
  workToday,
  yearOf,
  yearsSettled,
  yearsToSeed,
} from './holiday-seed';
import { parseStaff, shouldSeedSampleStaff, type StaffRow } from './parse-staff';
import { seedHolidayCountry, seedPolicyFromEnv } from './seed-config';

const prisma = new PrismaClient();

// ── 1 · work policy ─────────────────────────────────────────────────────────

// SEED_POLICY_* — defaults in seed-config.ts (the setup wizard's starting point)
const SEED_POLICY = seedPolicyFromEnv(process.env);

async function seedWorkPolicy(): Promise<number> {
  const policy = await prisma.workPolicy.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      name: 'Standard',
      monthlyTargetHours: SEED_POLICY.monthlyTargetHours,
      expectedWorkdays: SEED_POLICY.expectedWorkdays,
      // ISO days; not a block — work on a day off still counts
      weeklyOffDays: SEED_POLICY.weeklyOffDays,
      // whenever the computer is in use
      screenshotFrom: null,
      screenshotTo: null,
      idleThresholdSec: 60,
      slotMinutes: 5,
      // Same zone the server runs on (WORK_TIMEZONE, default UTC)
      timezone: process.env.WORK_TIMEZONE?.trim() || 'UTC',
      isActive: true,
    },
  });
  return policy.id;
}

// ── 2 · app categories ──────────────────────────────────────────────────────

// the list lives in src/setup/default-categories.ts (shared with the setup wizard)
const RULES = DEFAULT_APP_CATEGORIES;

async function seedAppCategories(): Promise<number> {
  for (const [matchType, pattern, displayName, category, priority] of RULES) {
    const existing = await prisma.appCategory.findFirst({
      where: { matchType, pattern },
    });
    if (existing) {
      await prisma.appCategory.update({
        where: { id: existing.id },
        data: { displayName, category, priority: priority ?? 100 },
      });
    } else {
      await prisma.appCategory.create({
        data: { matchType, pattern, displayName, category, priority: priority ?? 100 },
      });
    }
  }
  return RULES.length;
}

// ── 3 · holidays ────────────────────────────────────────────────────────────
//
// Only when `SEED_COUNTRY` names a country: its nationwide public holidays for
// this year and next, from the same public calendar the setup wizard uses
// (src/calendar/public-holidays.ts). No country, no holidays — a guessed list
// would take workdays out of months that have none.

/** SEED_COUNTRY — resolved once, up front: a malformed value stops the seed before anything is written */
const HOLIDAY_COUNTRY: string | null = seedHolidayCountry(process.env);

/**
 * Explicit consent to insert holidays in the current and past months.
 *
 * Why a flag is needed: `npm run seed` looks harmless ("all upserts, safe to
 * repeat"), but a new holiday in the middle of the current month reduces that
 * month's workdays D, which raises `dailyTargetSec = monthly ÷ D`, which moves
 * `target_sec`, `expected_sec` and `pace_sec` in `monthly_summary`, and the
 * payroll `d ÷ D` fraction (`src/payroll/payroll.service.ts`) feeds **straight
 * into pay**. A routine command would silently change salaries.
 *
 * Careful: the value is compared with exactly `'true'`. `1` or `yes` is **not**
 * treated as consent, and the seed then lists the dates by name again, so the
 * mistake is visible rather than silent. The opposite rule, "any non-empty
 * value means yes", would turn a typo like `SEED_HOLIDAYS_PAST=false` into
 * consent.
 */
const ALLOW_PAST_HOLIDAYS = process.env.SEED_HOLIDAYS_PAST === 'true';

/** The single `settings` row recording which years have already been seeded. */
interface HolidaySeedState {
  years?: number[];
}

async function loadSeededYears(settingKey: string): Promise<number[]> {
  const row = await prisma.setting.findUnique({
    where: { key: settingKey },
    select: { value: true },
  });
  if (!row || typeof row.value !== 'object' || row.value === null) return [];
  const years = (row.value as HolidaySeedState).years;
  return Array.isArray(years) ? years.filter((y) => typeof y === 'number') : [];
}

/**
 * Seeds the holiday calendar.
 *
 * Important: **the seed never changes or deletes anything here; it only
 * inserts missing rows.** When a date changes, the owner fixes it in
 * Settings → Holidays, and the next `db seed` does not revert it.
 *
 * Important: **each year is seeded once** (`yearsToSeed`): a holiday the owner
 * deleted (a day the company works anyway) never comes back by itself.
 *
 * Important: **the seed does not insert anything in the current or past months
 * by itself.** Those months' figures are already out, so adding a holiday
 * would change targets and payroll retroactively. To insert them, set
 * `SEED_HOLIDAYS_PAST=true` (see the note on `ALLOW_PAST_HOLIDAYS`). Otherwise
 * the dates are printed **by name**.
 */
async function seedHolidays(): Promise<{ summary: string; notes: string[] }> {
  if (HOLIDAY_COUNTRY === null) {
    return {
      summary:
        'none (SEED_COUNTRY is not set) — add them on Settings → Policies & holidays, or with prisma/import-holidays.ts',
      notes: [],
    };
  }
  const settingKey = `seed.holidays.${HOLIDAY_COUNTRY}`;
  // "Today" is the work-zone date, not the machine's local clock (see `workToday()`).
  const today = workToday(new Date());
  const thisYear = yearOf(today);

  const seeded = await loadSeededYears(settingKey);
  const wanted = yearsToSeed([thisYear, thisYear + 1], seeded);
  if (wanted.length === 0) {
    return {
      summary: `${HOLIDAY_COUNTRY}: all years already seeded (${[...seeded].sort((a, b) => a - b).join(', ')})`,
      notes: [],
    };
  }

  // Fetched per year: a year the calendar could not give stays open, so the
  // next seed tries again.
  const entries: ImportedHoliday[] = [];
  const fetched: number[] = [];
  const notes: string[] = [];
  for (const year of wanted) {
    try {
      const { holidays, problems } = await publicHolidays(HOLIDAY_COUNTRY, year);
      entries.push(...holidays);
      notes.push(...problems.map((p) => `⚠️ ${p}`));
      fetched.push(year);
    } catch (err) {
      notes.push(
        `⚠️ ${year}: ${err instanceof Error ? err.message : String(err)} — not seeded, the next seed tries again`,
      );
    }
  }

  const rows = await prisma.holiday.findMany({
    select: { holidayDate: true, name: true },
  });
  const typeOf = new Map(entries.map((h) => [h.entry.date, h.type]));
  const run = planHolidaySeedRun(
    entries.map((h) => h.entry),
    rows.map((row) => ({
      date: row.holidayDate.toISOString().slice(0, 10),
      name: row.name,
    })),
    fetched,
    { today, allowPast: ALLOW_PAST_HOLIDAYS },
  );

  for (const entry of run.create) {
    await prisma.holiday.create({
      data: {
        // `@db.Date` columns use UTC midnight; local time would shift the
        // holiday to the previous day in the work zone (same trap as in `parse-staff.ts`).
        holidayDate: new Date(`${entry.date}T00:00:00.000Z`),
        name: entry.name,
        approximate: entry.approximate,
        type: typeOf.get(entry.date) ?? 'public',
      },
    });
  }

  /**
   * A year that still has rows waiting for consent is not "done"; otherwise
   * `SEED_HOLIDAYS_PAST=true` would do nothing on the next run (the reason and
   * its cost are in the note on `yearsSettled`).
   */
  const settledYears = yearsSettled(fetched, run.needsConsent);
  if (settledYears.length > 0) {
    const years = [...new Set([...seeded, ...settledYears])].sort((a, b) => a - b);
    await prisma.setting.upsert({
      where: { key: settingKey },
      create: { key: settingKey, value: { years } },
      update: { value: { years } },
    });
  }

  /**
   * The summary reports **each bucket separately**: "0 inserted" could mean
   * "everything was already there" or "18 dates are held back".
   */
  const parts = [
    `${HOLIDAY_COUNTRY}: ${run.create.length} inserted`,
    `${run.kept} already existed`,
  ];
  if (run.needsConsent.length > 0) {
    parts.push(`${run.needsConsent.length} held back (current/past month)`);
  }
  if (settledYears.length > 0) {
    parts.push(`years completed: ${settledYears.join(', ')}`);
  } else if (fetched.length > 0) {
    parts.push('no year completed — rows are waiting for consent');
  }

  return { summary: parts.join(' · '), notes: [...notes, ...run.notes] };
}

// ── 4 · staff list ──────────────────────────────────────────────────────────
//
// The list comes from `staff.local.json` (gitignored) — see below.
//
// `policySignedAt` is left empty on purpose: nobody has signed the monitoring
// policy yet. Filling it in must be a precondition of the rollout, so it is not
// pre-filled, which would make the condition meaningless.
//
// Salary is visible to the **owner only** ([ADR-023](../../docs/history/05-Options-Decisions.md)).
// It is needed to compute the shortfall amount. Manager reports do not include
// this column either.

/**
 * Important: **the real staff list is not in the repo.** It lives in
 * `prisma/staff.local.json`, which is gitignored.
 *
 * The reason is about people, not code: the list holds the **names and
 * salaries** of 12 people, and that is their data, not ours. Once a repo goes
 * to GitHub, even a private one, it sits on a third party's servers and any
 * collaborator can read it. Removing something from git history is also hard,
 * so it stays out from the start.
 *
 * If the file is missing, the seed runs with `staff.example.json` (sample
 * names, salary 0), so a fresh clone still runs but reveals nobody's salary.
 */
function loadStaff(): StaffRow[] {
  const local = join(__dirname, 'staff.local.json');
  const example = join(__dirname, 'staff.example.json');
  const file = existsSync(local) ? local : example;

  usingExample = file === example;

  if (usingExample) {
    console.warn(
      '⚠  staff.local.json not found — seeding from staff.example.json. ' +
        'Create staff.local.json to seed the real list.',
    );
  }

  /**
   * The old `as Staff[]` cast was a lie: TypeScript accepted whatever the JSON
   * held. The data is now really validated, and an error message names the row
   * and the field.
   */
  return parseStaff(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Whether we are running from the sample list. This one boolean is what
 * prevents the real production bug.
 *
 * `staff.local.json` is **gitignored**, so it never exists on the VPS. Every
 * seed run there therefore created the three sample employees from
 * `staff.example.json` (Example One/Two/Three, salary 0), which is exactly how
 * they got into production, adding 624 hours to the team target.
 */
let usingExample = false;

const STAFF: StaffRow[] = loadStaff();

/** Department derived from designation, to group reports by team. */
function departmentOf(designation: string): string {
  if (designation === 'Manager') return 'Management';
  if (designation === 'Accountant') return 'Finance';
  if (designation === 'Analyst') return 'Operations';
  return 'General';
}

async function seedEmployees(policyId: number): Promise<number> {
  /**
   * Important: **sample staff are not inserted once real staff exist.**
   *
   * The rule is narrow: it applies only to the **sample** list, and only when
   * the database already has employees. With `staff.local.json` the seed
   * inserts everything as before, so updating the real list still works.
   *
   * The reasoning is simple: a live system has no reason to gain sample people.
   * They only inflate the team target, crowd the board and make the "behind"
   * figure wrong, while nobody has worked a minute for them.
   *
   * On a fresh install (empty database) the samples are inserted as before;
   * otherwise nobody could clone the repo and just try the project.
   */
  const already = await prisma.employee.count();
  if (!shouldSeedSampleStaff(usingExample, already)) {
    console.warn(
      `⚠  ${already} staff already exist — the sample list was not inserted. ` +
        'Create prisma/staff.local.json to seed the real list.',
    );
    return 0;
  }

  for (const { empCode, joinedOn, ...rest } of STAFF) {
    const common = {
      ...rest,
      department: departmentOf(rest.designation),
      policyId,
      /**
       * Careful: with **no date the column is left untouched** (`undefined`);
       * `null` is never written. Otherwise a date someone set by hand in the
       * dashboard would be wiped on the next seed, and payroll proration with
       * it, silently.
       */
      ...(joinedOn ? { joinedOn } : {}),
    };

    await prisma.employee.upsert({
      where: { empCode },
      // `update` has no status, so re-running the seed does not bring back
      // someone who has left.
      update: common,
      create: { empCode, ...common },
    });
  }
  return STAFF.length;
}

// ── 5 · owner account ───────────────────────────────────────────────────────

async function seedOwner(): Promise<string> {
  const email = process.env.SEED_OWNER_EMAIL?.trim() || 'owner@oxeio.local';
  const password = process.env.SEED_OWNER_PASSWORD;
  const fullName = process.env.SEED_OWNER_NAME?.trim() || 'oXeio Owner';

  if (!password) {
    throw new Error(
      'SEED_OWNER_PASSWORD is not set. Put it in .env and run again — ' +
        'no default password is used, on purpose.',
    );
  }

  const passwordHash = await hash(password);

  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
      fullName,
      role: UserRole.owner,
      // Must be changed at first login: the seed password sits in .env in plain text.
      mustChangePw: true,
    },
  });

  return email;
}

// ── run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const policyId = await seedWorkPolicy();
  const rules = await seedAppCategories();
  const holidays = await seedHolidays();
  const staff = await seedEmployees(policyId);
  const ownerEmail = await seedOwner();

  console.log('✅ seed complete');
  console.log(
    `   work policy   : #${policyId} · ${SEED_POLICY.monthlyTargetHours.toLocaleString('en-US')} hours/month · screenshots whenever in use`,
  );
  console.log(`   app categories: ${rules} rules`);
  console.log(`   holidays      : ${holidays.summary}`);
  for (const note of holidays.notes) {
    console.log(`                   ${note}`);
  }
  console.log(`   staff         : ${staff} — nobody has signed the policy yet, needed before rollout`);
  console.log(`   owner         : ${ownerEmail} (must change the password on first login)`);
}

main()
  .catch((e: unknown) => {
    console.error('❌ seed failed:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
