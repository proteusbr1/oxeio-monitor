/**
 * oXeio — seed data
 *
 *   1. Work policy    — 208 hours a month, Friday weekly off, screenshots 07:00–23:00
 *   2. App categories — productive / neutral / unproductive rules
 *   3. Holidays       — public holidays for 2026–27 (`holidays.data.ts`)
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
 * `SEED_HOLIDAYS_PAST=true` (deploy/README.md section 2.1c).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hash } from '@node-rs/argon2';
import { MatchType, PrismaClient, Productivity, UserRole } from '@prisma/client';

import { resolveHolidaySet, type HolidaySet } from './holiday-sets';
import {
  workToday,
  gazetteNotes,
  holidayRowName,
  planHolidaySeedRun,
  validateHolidays,
  yearsSettled,
  yearsToSeed,
} from './holidays.data';
import { parseStaff, shouldSeedSampleStaff, type StaffRow } from './parse-staff';
import { seedPolicyFromEnv } from './seed-config';

const prisma = new PrismaClient();

// ── 1 · work policy ─────────────────────────────────────────────────────────

// SEED_POLICY_* — defaults are the numbers below as they always were (seed-config.ts)
const SEED_POLICY = seedPolicyFromEnv(process.env);

async function seedWorkPolicy(): Promise<number> {
  const policy = await prisma.workPolicy.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      name: 'Standard',
      monthlyTargetHours: SEED_POLICY.monthlyTargetHours, // default 208
      expectedWorkdays: SEED_POLICY.expectedWorkdays, // default 26
      weeklyOffDays: SEED_POLICY.weeklyOffDays, // ISO: Friday ([5]); not a block, Friday work still counts
      screenshotFrom: '07:00',
      screenshotTo: '23:00',
      idleThresholdSec: 60,
      slotMinutes: 5,
      // Same zone the server runs on (WORK_TIMEZONE, default Asia/Dhaka)
      timezone: process.env.WORK_TIMEZONE?.trim() || 'Asia/Dhaka',
      isActive: true,
    },
  });
  return policy.id;
}

// ── 2 · app categories ──────────────────────────────────────────────────────

type Rule = [MatchType, string, string, Productivity, number?];

const RULES: Rule[] = [
  // ── development ───────────────────────────────────────────────
  [MatchType.process, 'code.exe', 'Visual Studio Code', Productivity.productive],
  [MatchType.process, 'devenv.exe', 'Visual Studio', Productivity.productive],
  [MatchType.process, 'rider64.exe', 'JetBrains Rider', Productivity.productive],
  [MatchType.process, 'webstorm64.exe', 'WebStorm', Productivity.productive],
  [MatchType.process, 'pycharm64.exe', 'PyCharm', Productivity.productive],
  [MatchType.process, 'idea64.exe', 'IntelliJ IDEA', Productivity.productive],
  [MatchType.process, 'sublime_text.exe', 'Sublime Text', Productivity.productive],
  [MatchType.process, 'notepad++.exe', 'Notepad++', Productivity.productive],
  [MatchType.process, 'windowsterminal.exe', 'Windows Terminal', Productivity.productive],
  [MatchType.process, 'powershell.exe', 'PowerShell', Productivity.productive],
  [MatchType.process, 'cmd.exe', 'Command Prompt', Productivity.productive],
  [MatchType.process, 'git-bash.exe', 'Git Bash', Productivity.productive],
  [MatchType.process, 'docker desktop.exe', 'Docker Desktop', Productivity.productive],
  [MatchType.process, 'postman.exe', 'Postman', Productivity.productive],
  [MatchType.process, 'insomnia.exe', 'Insomnia', Productivity.productive],
  [MatchType.process, 'datagrip64.exe', 'DataGrip', Productivity.productive],
  [MatchType.process, 'ssms.exe', 'SQL Server Mgmt Studio', Productivity.productive],
  [MatchType.process, 'pgadmin4.exe', 'pgAdmin', Productivity.productive],
  [MatchType.process, 'mysqlworkbench.exe', 'MySQL Workbench', Productivity.productive],
  [MatchType.process, 'sourcetree.exe', 'Sourcetree', Productivity.productive],
  [MatchType.process, 'gitkraken.exe', 'GitKraken', Productivity.productive],
  [MatchType.domain, 'github.com', 'GitHub', Productivity.productive],
  [MatchType.domain, 'gitlab.com', 'GitLab', Productivity.productive],
  [MatchType.domain, 'bitbucket.org', 'Bitbucket', Productivity.productive],
  [MatchType.domain, 'stackoverflow.com', 'Stack Overflow', Productivity.productive],
  [MatchType.domain, 'developer.mozilla.org', 'MDN', Productivity.productive],
  [MatchType.domain, 'npmjs.com', 'npm', Productivity.productive],
  [MatchType.domain, 'nuget.org', 'NuGet', Productivity.productive],
  [MatchType.domain, 'docs.microsoft.com', 'Microsoft Docs', Productivity.productive],
  [MatchType.domain, 'learn.microsoft.com', 'Microsoft Learn', Productivity.productive],
  [MatchType.domain, 'vercel.com', 'Vercel', Productivity.productive],
  [MatchType.domain, 'netlify.com', 'Netlify', Productivity.productive],
  [MatchType.domain, 'digitalocean.com', 'DigitalOcean', Productivity.productive],
  [MatchType.domain, 'aws.amazon.com', 'AWS', Productivity.productive],
  [MatchType.domain, 'console.cloud.google.com', 'Google Cloud', Productivity.productive],
  [MatchType.domain, 'chatgpt.com', 'ChatGPT', Productivity.productive],
  [MatchType.domain, 'claude.ai', 'Claude', Productivity.productive],

  // ── design ────────────────────────────────────────────────────
  [MatchType.process, 'photoshop.exe', 'Adobe Photoshop', Productivity.productive],
  [MatchType.process, 'illustrator.exe', 'Adobe Illustrator', Productivity.productive],
  [MatchType.process, 'indesign.exe', 'Adobe InDesign', Productivity.productive],
  [MatchType.process, 'afterfx.exe', 'After Effects', Productivity.productive],
  [MatchType.process, 'adobe premiere pro.exe', 'Premiere Pro', Productivity.productive],
  [MatchType.process, 'figma.exe', 'Figma', Productivity.productive],
  [MatchType.process, 'coreldrw.exe', 'CorelDRAW', Productivity.productive],
  [MatchType.process, 'blender.exe', 'Blender', Productivity.productive],
  [MatchType.domain, 'figma.com', 'Figma', Productivity.productive],
  [MatchType.domain, 'canva.com', 'Canva', Productivity.productive],
  [MatchType.domain, 'dribbble.com', 'Dribbble', Productivity.productive],
  [MatchType.domain, 'behance.net', 'Behance', Productivity.productive],
  [MatchType.domain, 'unsplash.com', 'Unsplash', Productivity.productive],

  // ── office and documents ──────────────────────────────────────
  [MatchType.process, 'excel.exe', 'Microsoft Excel', Productivity.productive],
  [MatchType.process, 'winword.exe', 'Microsoft Word', Productivity.productive],
  [MatchType.process, 'powerpnt.exe', 'PowerPoint', Productivity.productive],
  [MatchType.process, 'outlook.exe', 'Outlook', Productivity.productive],
  [MatchType.process, 'onenote.exe', 'OneNote', Productivity.productive],
  [MatchType.process, 'acrobat.exe', 'Adobe Acrobat', Productivity.productive],
  [MatchType.process, 'acrord32.exe', 'Acrobat Reader', Productivity.productive],
  [MatchType.domain, 'docs.google.com', 'Google Docs', Productivity.productive],
  [MatchType.domain, 'sheets.google.com', 'Google Sheets', Productivity.productive],
  [MatchType.domain, 'drive.google.com', 'Google Drive', Productivity.productive],
  [MatchType.domain, 'mail.google.com', 'Gmail', Productivity.productive],
  [MatchType.domain, 'outlook.office.com', 'Outlook Web', Productivity.productive],
  [MatchType.domain, 'notion.so', 'Notion', Productivity.productive],
  [MatchType.domain, 'atlassian.net', 'Jira / Confluence', Productivity.productive],
  [MatchType.domain, 'trello.com', 'Trello', Productivity.productive],
  [MatchType.domain, 'asana.com', 'Asana', Productivity.productive],
  [MatchType.domain, 'clickup.com', 'ClickUp', Productivity.productive],

  // ── communication (work, but hard to measure) ─────────────────
  [MatchType.process, 'ms-teams.exe', 'Microsoft Teams', Productivity.productive],
  [MatchType.process, 'teams.exe', 'Microsoft Teams', Productivity.productive],
  [MatchType.process, 'slack.exe', 'Slack', Productivity.productive],
  [MatchType.process, 'zoom.exe', 'Zoom', Productivity.productive],
  [MatchType.process, 'skype.exe', 'Skype', Productivity.neutral],
  [MatchType.domain, 'meet.google.com', 'Google Meet', Productivity.productive],
  [MatchType.domain, 'zoom.us', 'Zoom', Productivity.productive],
  [MatchType.domain, 'slack.com', 'Slack', Productivity.productive],
  [MatchType.domain, 'web.whatsapp.com', 'WhatsApp Web', Productivity.neutral],

  // ── neutral ───────────────────────────────────────────────────
  [MatchType.process, 'explorer.exe', 'File Explorer', Productivity.neutral],
  [MatchType.process, 'chrome.exe', 'Google Chrome', Productivity.neutral, 200],
  [MatchType.process, 'msedge.exe', 'Microsoft Edge', Productivity.neutral, 200],
  [MatchType.process, 'firefox.exe', 'Mozilla Firefox', Productivity.neutral, 200],
  [MatchType.process, 'calc.exe', 'Calculator', Productivity.neutral],
  [MatchType.process, 'notepad.exe', 'Notepad', Productivity.neutral],
  [MatchType.process, 'snippingtool.exe', 'Snipping Tool', Productivity.neutral],
  [MatchType.domain, 'google.com', 'Google Search', Productivity.neutral],
  [MatchType.domain, 'bing.com', 'Bing', Productivity.neutral],
  [MatchType.domain, 'wikipedia.org', 'Wikipedia', Productivity.neutral],
  [MatchType.domain, 'linkedin.com', 'LinkedIn', Productivity.neutral],
  [MatchType.domain, 'prothomalo.com', 'Prothom Alo', Productivity.neutral],
  [MatchType.domain, 'bdnews24.com', 'bdnews24', Productivity.neutral],

  // ── unproductive ──────────────────────────────────────────────
  [MatchType.domain, 'facebook.com', 'Facebook', Productivity.unproductive],
  [MatchType.domain, 'messenger.com', 'Messenger', Productivity.unproductive],
  [MatchType.domain, 'instagram.com', 'Instagram', Productivity.unproductive],
  [MatchType.domain, 'tiktok.com', 'TikTok', Productivity.unproductive],
  [MatchType.domain, 'x.com', 'X (Twitter)', Productivity.unproductive],
  [MatchType.domain, 'twitter.com', 'Twitter', Productivity.unproductive],
  [MatchType.domain, 'youtube.com', 'YouTube', Productivity.unproductive],
  [MatchType.domain, 'netflix.com', 'Netflix', Productivity.unproductive],
  [MatchType.domain, 'hoichoi.tv', 'Hoichoi', Productivity.unproductive],
  [MatchType.domain, 'reddit.com', 'Reddit', Productivity.unproductive],
  [MatchType.domain, 'pinterest.com', 'Pinterest', Productivity.unproductive],
  [MatchType.domain, 'twitch.tv', 'Twitch', Productivity.unproductive],
  [MatchType.domain, 'daraz.com.bd', 'Daraz', Productivity.unproductive],
  [MatchType.domain, 'amazon.com', 'Amazon', Productivity.unproductive],
  [MatchType.domain, 'cricbuzz.com', 'Cricbuzz', Productivity.unproductive],
  [MatchType.domain, 'espncricinfo.com', 'ESPNcricinfo', Productivity.unproductive],
  [MatchType.process, 'steam.exe', 'Steam', Productivity.unproductive],
  [MatchType.process, 'epicgameslauncher.exe', 'Epic Games', Productivity.unproductive],
  [MatchType.process, 'spotify.exe', 'Spotify', Productivity.unproductive],
  [MatchType.process, 'vlc.exe', 'VLC Player', Productivity.unproductive],
];

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
// This used to hold only 7 **fixed-date** holidays; the lunar ones (Eid, Ashura,
// Shab-e-Barat, Durga Puja…) were left out because they "can't be predicted".
// But leaving them out counts those days as **workdays**, which quietly says
// "no holiday" and is an active error: everyone's target and pace looked too
// high. The list now lives in `holidays.data.ts`, and estimated dates are
// stored **as estimates**, with a Bengali "probable" marker at the end of the
// name. The reasoning is in the header of that file.

/**
 * SEED_COUNTRY (default BD) — which list to write; `none` writes nothing
 * (holiday-sets.ts). Resolved once, up front: an unknown country stops the
 * seed before anything is written.
 */
const HOLIDAY_SET: HolidaySet | null = resolveHolidaySet(process.env);

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
 * inserts missing rows.** When the government announces a change, the owner
 * fixes the date or name in Settings → Holidays, and the next `db seed` does
 * not revert it. The old code did `update: { name }`, which wiped every manual
 * correction on the next seed.
 *
 * Important: **the notes are printed on every run, whether or not anything was
 * inserted.** It used to return early once a year was seeded, so the
 * `unlisted`/`renamed` notes went silent for good after the first run. Saying
 * nothing is not a decision, it is hiding the issue.
 *
 * Important: **the seed does not insert anything in the current or past months
 * by itself.** Those months' figures are already out, so adding a holiday
 * would change targets and payroll retroactively. To insert them, set
 * `SEED_HOLIDAYS_PAST=true` (see the note on `ALLOW_PAST_HOLIDAYS`). Otherwise
 * the dates are printed **by name**.
 */
async function seedHolidays(): Promise<{
  summary: string;
  standing: string[];
  notes: string[];
}> {
  if (HOLIDAY_SET === null) {
    return {
      summary: 'skipped (SEED_COUNTRY=none) — add them in Settings → Holidays or with prisma/import-holidays.ts',
      standing: [],
      notes: [],
    };
  }
  const { entries, years: allYears, pending, settingKey } = HOLIDAY_SET;

  const problems = validateHolidays(entries);
  if (problems.length > 0) {
    // Stop here: a wrong date goes straight into the workday count.
    throw new Error(`Errors in the holiday list:\n  - ${problems.join('\n  - ')}`);
  }

  const seeded = await loadSeededYears(settingKey);
  const years = yearsToSeed(allYears, seeded);

  // The DB is read on **every** run, whether or not a year is left to seed;
  // otherwise we could not tell whether there is anything to report.
  const rows = await prisma.holiday.findMany({
    select: { holidayDate: true, name: true },
  });

  // The plan covers the **whole list**; `years` only decides what gets inserted.
  const run = planHolidaySeedRun(
    entries,
    rows.map((row) => ({
      date: row.holidayDate.toISOString().slice(0, 10),
      name: row.name,
    })),
    years,
    // "Today" is the work-zone date, not the machine's local clock (see `workToday()`).
    { today: workToday(new Date()), allowPast: ALLOW_PAST_HOLIDAYS },
  );

  for (const entry of run.create) {
    await prisma.holiday.create({
      data: {
        // `@db.Date` columns use UTC midnight; local time would shift the
        // holiday to the previous day in the work zone (same trap as in `parse-staff.ts`).
        holidayDate: new Date(`${entry.date}T00:00:00.000Z`),
        name: holidayRowName(entry),
        // The screen's Type picker only offers public/optional/company; any
        // other value would silently change when the owner hits Edit → Save.
        type: 'public',
      },
    });
  }

  /**
   * A year that still has rows waiting for consent is not "done"; otherwise
   * `SEED_HOLIDAYS_PAST=true` would do nothing on the next run (the reason and
   * its cost are in the note on `yearsSettled`).
   *
   * `settings` is only touched when a year was really completed; otherwise
   * every run would rewrite the same value and `updated_at` would be wrong.
   */
  const settledYears = yearsSettled(years, run.needsConsent);
  if (settledYears.length > 0) {
    await prisma.setting.upsert({
      where: { key: settingKey },
      create: {
        key: settingKey,
        value: { years: [...seeded, ...settledYears] },
      },
      update: { value: { years: [...seeded, ...settledYears] } },
    });
  }

  /**
   * The summary reports **each bucket separately**. It used to print only how
   * many were inserted; now it also counts the ones that were **not**, because
   * "0 inserted" could mean two very different things: "everything was already
   * correct" or "18 dates are held back".
   */
  const approx = run.create.filter((h) => h.approximate).length;
  const parts = [
    `${run.create.length} inserted (${approx} approximate dates)`,
    `${run.kept} already existed`,
  ];
  if (run.needsConsent.length > 0) {
    parts.push(`${run.needsConsent.length} held back (current/past month)`);
  }
  if (run.heldBack.length > 0) {
    parts.push(`${run.heldBack.length} in a closed year (not inserted)`);
  }
  /**
   * Three states are reported separately. "No year completed" and "all years
   * already completed" both mean nothing new was closed, but the first means
   * something is held back and the second means everything is fine.
   */
  if (years.length === 0) {
    const done = [...seeded].sort((a, b) => a - b).join(', ');
    parts.push(`all years already complete (${done})`);
  } else if (settledYears.length > 0) {
    parts.push(`years completed: ${settledYears.join(', ')}`);
  } else {
    parts.push('no year completed — rows are waiting for consent');
  }

  /**
   * Old or unrecognised rows are **never deleted**, only reported. For
   * example, 17 March and 15 August were dropped from the 2024 public holidays,
   * yet an earlier seed inserted them, and in existing databases they still
   * reduce the workdays. We cannot tell a wrong row from a holiday the owner
   * added themselves, so the decision is theirs. But saying nothing is not a
   * decision, it is hiding the issue, so `run.notes` is returned on every run,
   * even when `run.create` is empty.
   */
  return {
    summary: parts.join(' · '),
    // **Standing** facts about the list, kept apart from what this run did.
    standing: gazetteNotes(entries, pending),
    notes: run.notes,
  };
}

// ── 4 · staff list ──────────────────────────────────────────────────────────
//
// The list comes from `staff.local.json` (gitignored) — see below.
//
// `policySignedAt` is left empty on purpose: nobody has signed the monitoring
// policy yet. Filling it in must be a precondition of the rollout, so it is not
// pre-filled, which would make the condition meaningless.
//
// Salary is visible to the **owner only** ([ADR-023](../../docs/05-Options-Decisions.md)).
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
  if (designation === 'Designer') return 'Design';
  if (designation === 'Researcher') return 'Research';
  return 'Intern';
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
  const email = process.env.SEED_OWNER_EMAIL ?? 'owner@oxeio.local';
  const password = process.env.SEED_OWNER_PASSWORD;
  const fullName = process.env.SEED_OWNER_NAME ?? 'oXeio Owner';

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
    `   work policy   : #${policyId} · ${SEED_POLICY.monthlyTargetHours.toLocaleString('en-US')} hours/month · screenshots 07:00–23:00`,
  );
  console.log(`   app categories: ${rules} rules`);
  console.log(`   holidays      : ${holidays.summary}`);
  console.log(
    '                   ⚠️ dates marked "(সম্ভাব্য)" depend on the moon/tithi — fix them when the announcement comes',
  );
  // Standing facts about the list first, then what this run did.
  for (const note of [...holidays.standing, ...holidays.notes]) {
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
