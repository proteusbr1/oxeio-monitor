/**
 * One-off history correction: G163 *(7 September 2026, already run)*.
 *
 * Careful: this is not a regular job and is not meant to be run again. It is kept
 * **as a record** of exactly what was changed in production data and how.
 * The whole story is in [09 § ৩ঞ৩১.১৩](../../../docs/09-Build-Log.md).
 *
 * Careful: **the rule is not rewritten here.** The container's
 * `/app/dist/summary/design.rules.js` is used to call the **real `designIdOf()`**.
 * Translating the regex into SQL would create two definitions, and two definitions
 * drifting apart is exactly what produced this bug (and G112 and G162).
 *
 * How to run (on the VPS):
 *   docker cp backfill-g163-started-at.cjs oxeio-api:/app/backfill.js
 *   docker exec -e DRY=1 -w /app oxeio-api node /app/backfill.js   # dry run
 *   docker exec -e DRY=0 -w /app oxeio-api node /app/backfill.js   # for real
 *
 * Result: 711 rows, distinct clock values 1 -> 703, `started_at < assigned_at` 711 -> 0.
 */
const { PrismaClient } = require('@prisma/client');
const { designIdOf } = require('/app/dist/summary/design.rules');

const DRY = process.env.DRY !== '0';
const DHAKA_OFFSET_MS = 6 * 3600_000;
const DAY_MS = 86_400_000;

const iso = (d) => (d === null || d === undefined ? null : new Date(d).toISOString());

(async () => {
  const prisma = new PrismaClient();

  try {
    // ── 1. Targets that have the marker set ────────────────────────────
    const targets = await prisma.$queryRawUnsafe(`
      SELECT dt.id, dt.job_number, dt.assigned_to_id, dt.started_at,
             dt.assigned_at, dt.completed_at, dc.first_work_date
      FROM design_targets dt
      JOIN design_credits dc ON dc.employee_id = dt.assigned_to_id
                            AND dc.design_id = dt.job_number::text
      WHERE dt.started_at IS NOT NULL
      ORDER BY dt.id
    `);

    // ── 2. All rows of the design apps, picked by the real rule ─────────
    const usage = await prisma.$queryRawUnsafe(`
      SELECT employee_id, work_date, process_name, window_title, started_at
      FROM app_usage
      WHERE process_name IN ('Illustrator.exe','Photoshop.exe')
    `);

    /** `employee|day|number` -> the earliest moment on that day */
    const firstSeen = new Map();

    for (const r of usage) {
      const id = designIdOf(r.process_name, r.window_title);
      if (id === null) continue;

      const key = `${r.employee_id}|${new Date(r.work_date).getTime()}|${id}`;
      const known = firstSeen.get(key);
      const at = new Date(r.started_at).getTime();
      if (known === undefined || at < known) firstSeen.set(key, at);
    }

    // ── 3. Matching ─────────────────────────────────────────────────────
    const updates = [];
    const missing = [];
    const unchanged = [];
    const suspect = [];

    for (const t of targets) {
      const dayMs = new Date(t.first_work_date).getTime();
      const key = `${t.assigned_to_id}|${dayMs}|${t.job_number}`;
      const want = firstSeen.get(key);

      if (want === undefined) {
        missing.push(t);
        continue;
      }

      const have = new Date(t.started_at).getTime();
      if (want === have) {
        unchanged.push(t);
        continue;
      }

      // Guard: the new value must stay inside that Dhaka day
      const dayStart = dayMs - DHAKA_OFFSET_MS;
      if (want < dayStart || want >= dayStart + DAY_MS) {
        suspect.push({ t, want, why: 'outside its own Dhaka day' });
        continue;
      }

      // Guard: "start" is never after "end"
      if (t.completed_at !== null && want > new Date(t.completed_at).getTime()) {
        suspect.push({ t, want, why: 'after completed_at' });
        continue;
      }

      updates.push({ id: t.id, from: have, to: want, assignedAt: t.assigned_at });
    }

    const stillBeforeAssigned = updates.filter(
      (u) => u.assignedAt !== null && u.to < new Date(u.assignedAt).getTime(),
    );

    console.log('── G163 ব্যাকফিল ' + (DRY ? '(DRY RUN — কিছুই লেখা হয়নি)' : '(সত্যিই লিখছে)'));
    console.log('চিহ্ন বসানো টার্গেট      :', targets.length);
    console.log('বদলাবে                   :', updates.length);
    console.log('আগে থেকেই ঠিক            :', unchanged.length);
    console.log('উৎস পাওয়া যায়নি          :', missing.length);
    console.log('সন্দেহজনক (ছোঁয়া হবে না) :', suspect.length);
    console.log('বদলের পরেও assigned_at-এর আগে :', stillBeforeAssigned.length);

    for (const s of suspect.slice(0, 10)) {
      console.log('  ⚠️ suspect', String(s.t.id), s.why, iso(s.want));
    }
    for (const m of missing.slice(0, 10)) {
      console.log('  ⚠️ missing', String(m.id), 'job', m.job_number, 'day', iso(m.first_work_date));
    }

    console.log('\n── নমুনা (প্রথম ৮টা)');
    for (const u of updates.slice(0, 8)) {
      console.log('  ', String(u.id), iso(u.from), '→', iso(u.to));
    }

    // Backup: the old values go to stdout, to be captured in a local file
    console.log('NEW_JSON_START');
    console.log(JSON.stringify(
      updates.map((u) => [String(u.id), new Date(u.to).toISOString()]),
    ));
    console.log('NEW_JSON_END');

    console.log('\n── BACKUP_JSON_START');
    console.log(JSON.stringify(
      targets.map((t) => ({ id: String(t.id), startedAt: iso(t.started_at) })),
    ));
    console.log('── BACKUP_JSON_END');

    if (DRY) {
      console.log('\nDRY RUN — কিছুই লেখা হয়নি।');
      return;
    }

    // ── 4. Writing, in a single transaction ─────────────────────────────
    const written = await prisma.$transaction(
      updates.map((u) =>
        prisma.$executeRawUnsafe(
          'UPDATE design_targets SET started_at = $1 WHERE id = $2 AND started_at = $3',
          new Date(u.to),
          u.id,
          new Date(u.from),
        ),
      ),
    );

    const total = written.reduce((a, b) => a + b, 0);
    console.log('\n✅ লেখা হয়েছে:', total, 'সারি');

    if (total !== updates.length) {
      console.log('⚠️⚠️ সংখ্যা মেলেনি — প্রত্যাশা', updates.length);
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
