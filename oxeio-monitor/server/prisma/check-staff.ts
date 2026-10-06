/**
 * Checks that `staff.local.json` is valid, **without a database**.
 *
 * Why it exists: the only way to validate the list used to be running the whole
 * seed, i.e. `scp` the file to the VPS, run the container there and dig the
 * error out of the Docker logs. One stray comma meant a full round trip.
 *
 * It writes **nothing** to the database; it only reads and reports, so it is
 * safe to run as often as you like.
 *
 *     npm run check:staff
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseStaff, type StaffRow } from './parse-staff';

const local = join(__dirname, 'staff.local.json');
const example = join(__dirname, 'staff.example.json');
const file = existsSync(local) ? local : example;

if (file === example) {
  console.error('❌ staff.local.json নেই — দেখা হচ্ছে staff.example.json');
  console.error(`   খোঁজা হয়েছিল: ${local}`);
  process.exitCode = 1;
}

let rows: StaffRow[];
try {
  const text = readFileSync(file, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    /**
     * Careful: JSON syntax errors are caught separately because the cause is
     * almost always the same: a **trailing comma** after the last row, or a
     * `]` in the wrong place after adding a date. Node's own message gives a
     * character offset, not a line number.
     */
    console.error(`❌ ফাইলটা বৈধ JSON নয়: ${(e as Error).message}`);
    console.error(
      '   সবচেয়ে সাধারণ কারণ: শেষ সারির পরে বাড়তি কমা, ' +
        'বা তারিখ বসাতে গিয়ে বন্ধনী সরে যাওয়া।',
    );
    process.exit(1);
  }
  rows = parseStaff(raw);
} catch (e) {
  console.error(`❌ ${(e as Error).message}`);
  process.exit(1);
}

const withDate = rows.filter((r) => r.joinedOn).length;
const pad = (s: string, n: number) => s.padEnd(n, ' ');

console.log(`✅ ${rows.length} জন — ধাঁচ ঠিক আছে\n`);
for (const r of rows) {
  const date = r.joinedOn?.toISOString().slice(0, 10) ?? '— তারিখ নেই';
  console.log(
    `   ${pad(r.empCode, 8)} ${pad(r.fullName, 22)} ` +
      `${pad(String(r.monthlySalary), 8)} ${date}`,
  );
}

/**
 * Careful: a missing join date is **not an error** (a four-column row is valid),
 * but it must not pass silently either: payroll proration then treats that
 * person as a full month, and nothing else would show it. So the count is
 * printed here; the exit code does not change.
 */
if (withDate < rows.length) {
  console.log(
    `\n⚠️  ${rows.length - withDate} জনের যোগদানের তারিখ নেই — তাঁদের হিসাব ` +
      'পুরো মাস ধরে হবে (G37 proration চলবে না)।',
  );
}
