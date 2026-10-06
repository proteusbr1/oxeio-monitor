/**
 * Import holidays from a CSV or ICS file — for any country, state or city.
 *
 *   npm run holidays:import -- path/to/holidays.csv            # writes
 *   npm run holidays:import -- path/to/holidays.ics --dry-run  # only prints
 *
 * Inside docker (the `migrate` service has the source and `prisma/` mounted):
 *   docker compose --profile setup run --rm migrate \
 *     npx tsx prisma/import-holidays.ts prisma/holidays.local.csv
 *
 * ⚠️⚠️ Same rule as the seed (seed.ts, `SEED_HOLIDAYS_PAST`): a holiday in the
 *    current or a past month changes that month's workdays, its targets and
 *    the prorated salary. Those dates are listed and left out unless you
 *    pass `--allow-past` (or `SEED_HOLIDAYS_PAST=true`) on purpose — read
 *    deploy/README.md § ২.১গ first.
 * ⚠️ Nothing already in the table is changed or deleted: an existing date is
 *    kept as it is, a different name for it is only reported.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { PrismaClient } from '@prisma/client';

// ⚠️ from src/: this script runs in the `migrate` container, which has the source
import { parseHolidayFile } from '../src/calendar/holiday-import';
import {
  dhakaToday,
  holidayRowName,
  planHolidaySeedRun,
  yearOf,
} from './holidays.data';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const allowPast =
    args.includes('--allow-past') || process.env.SEED_HOLIDAYS_PAST === 'true';

  if (!file) {
    console.error(
      'Usage: import-holidays <file.csv|file.ics> [--dry-run] [--allow-past]',
    );
    process.exitCode = 2;
    return;
  }

  const { holidays, problems } = parseHolidayFile(
    file,
    readFileSync(file, 'utf8'),
  );
  for (const p of problems) console.log(`   ⚠️ ${p}`);
  if (holidays.length === 0) {
    console.log(`No holidays found in ${basename(file)}.`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.holiday.findMany({
      select: { holidayDate: true, name: true },
    });
    const entries = holidays.map((h) => h.entry);
    const typeOf = new Map(holidays.map((h) => [h.entry.date, h.type]));

    const run = planHolidaySeedRun(
      entries,
      rows.map((r) => ({
        date: r.holidayDate.toISOString().slice(0, 10),
        name: r.name,
      })),
      // every year in the file is open — unlike the seed, a file is imported on purpose
      [...new Set(entries.map((e) => yearOf(e.date)))],
      { today: dhakaToday(new Date()), allowPast },
    );

    for (const note of run.notes) console.log(`   ${note}`);

    if (!dryRun) {
      for (const entry of run.create) {
        await prisma.holiday.create({
          data: {
            holidayDate: new Date(`${entry.date}T00:00:00.000Z`),
            name: holidayRowName(entry),
            type: typeOf.get(entry.date) ?? 'public',
          },
        });
      }
    }

    const verb = dryRun ? 'would be added' : 'added';
    console.log(
      `${basename(file)}: ${run.create.length} ${verb} · ${run.kept} already there` +
        (run.needsConsent.length > 0
          ? ` · ${run.needsConsent.length} in current/past months left out (see above)`
          : '') +
        (problems.length > 0
          ? ` · ${problems.length} skipped (see above)`
          : ''),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error('❌ import failed:', e);
  process.exitCode = 1;
});
