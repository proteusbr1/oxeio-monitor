/**
 * Owner lockout: the only way back in.
 *
 * Careful: this system has no "forgot password" email link, deliberately. It
 * is an internal office server with no outside mail dependency. The result
 * was a **silent trap**: if the only owner lost the password (or the 2FA
 * phone), there was no way into the system at all. Staff hours would keep
 * accumulating with nobody able to see them or compute payroll.
 *
 * Careful: `prisma/seed.ts` cannot recover either. It upserts the owner with
 * `update: {}`, so an existing account keeps its password. That is right for
 * the seed (it runs repeatedly) but useless on a bad day.
 *
 * -- How to run ----------------------------------------------------------
 *
 * On the server (inside the container; this is how it is needed in a real
 * emergency):
 *
 *   docker compose exec api node dist/scripts/recover-owner.js --list
 *   docker compose exec api node dist/scripts/recover-owner.js --confirm
 *
 * On a dev machine:
 *
 *   npm run recover:owner -- --list
 *   npm run recover:owner -- --confirm --email owner@office.local
 *
 * Careful: the file is deliberately inside `src/`, not `scripts/`. The
 * production image contains only `dist/` and prod dependencies; `tsx` is not
 * there and the `scripts/` folder is not copied. Outside `src/`, the script
 * would be unusable on exactly the machine where it is the only thing that
 * helps. In `src/`, `nest build` compiles it too, and since nothing imports
 * it, it never runs at server start.
 *
 * Careful: running it needs a shell on the server, so whoever can do that
 * already has database access and can do anything. The script opens no new
 * hole; it only brings an existing power onto an audited, safe path.
 *
 * Careful: the password is **not taken** on the command line, it is
 * generated. As an argument it would stay in shell history and the `ps`
 * list, and people often pick something weak.
 *
 * The decisions are not here but in `src/auth/owner-recovery.ts`, so they can
 * be tested. This file only handles argv and the screen.
 */
import { PrismaClient } from '@prisma/client';

import { listOwners, recoverOwner } from '../auth/owner-recovery';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : undefined;
}

const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  if (has('list')) {
    const owners = await listOwners(prisma);

    if (owners.length === 0) {
      console.log('কোনো owner অ্যাকাউন্ট নেই।');
      return;
    }

    console.log(`${owners.length}টি owner অ্যাকাউন্ট:\n`);
    for (const o of owners) {
      const seen = o.lastLoginAt?.toISOString().slice(0, 16) ?? 'কখনো ঢোকেনি';
      console.log(
        `  #${o.id}  ${o.email}  (${o.fullName})  · ` +
          `${o.isActive ? 'সক্রিয়' : 'নিষ্ক্রিয়'} · ` +
          `${o.hasTwoFactor ? '2FA চালু' : '2FA নেই'} · শেষ লগইন ${seen}`,
      );
    }
    return;
  }

  /**
   * Careful: nothing changes without `--confirm`. This must not be something
   * that can run by accident: once it runs, the old password is **gone for
   * good**, and the owner would suddenly be locked out at login without
   * knowing why.
   */
  if (!has('confirm')) {
    console.error(
      'কিছুই বদলানো হয়নি।\n\n' +
        'এই স্ক্রিপ্ট owner-এর পাসওয়ার্ড **বদলে দেয়** (আগেরটা আর কাজ করবে না),\n' +
        'আর 2FA থাকলে সেটাও সরিয়ে দেয়। নিশ্চিত হলে `--confirm` দিন।\n\n' +
        'আগে দেখে নিন কোন কোন অ্যাকাউন্ট আছে: `--list`\n',
    );
    process.exitCode = 2;
    return;
  }

  const result = await recoverOwner(prisma, {
    email: arg('email'),
    fullName: arg('name'),
  });

  if (!result.ok) {
    console.error(`\n${result.detail}\n`);
    if (result.reason === 'no-owner-no-email') {
      console.error('  … --confirm --email owner@office.local [--name "নাম"]\n');
    } else {
      console.error('  … --list  দিয়ে দেখে নিন\n');
    }
    // Careful: distinct exit codes, so that when the script sits inside a
    // runbook, "what went wrong" can be answered without reading the output.
    process.exitCode = result.reason === 'no-owner-no-email' ? 3 : 4;
    return;
  }

  console.log(
    `\n✅ ${result.kind === 'created' ? 'নতুন owner অ্যাকাউন্ট তৈরি হলো' : 'পাসওয়ার্ড রিসেট হলো'}\n`,
  );
  console.log(`   ইমেইল    : ${result.email}`);
  console.log(`   পাসওয়ার্ড : ${result.password}\n`);
  console.log('⚠️ এই পাসওয়ার্ড আর কোথাও লেখা নেই — এখনই ব্যবহার করুন।');
  console.log('⚠️ প্রথম লগইনেই নতুন পাসওয়ার্ড চাওয়া হবে।');
  if (result.clearedTwoFactor) {
    console.log('⚠️ 2FA সরিয়ে দেওয়া হয়েছে — ঢুকে আবার চালু করে নিন।');
  }
  console.log('');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
