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
      console.log('No owner accounts.');
      return;
    }

    console.log(`${owners.length} owner account(s):\n`);
    for (const o of owners) {
      const seen = o.lastLoginAt?.toISOString().slice(0, 16) ?? 'never logged in';
      console.log(
        `  #${o.id}  ${o.email}  (${o.fullName})  · ` +
          `${o.isActive ? 'active' : 'inactive'} · ` +
          `${o.hasTwoFactor ? '2FA on' : '2FA off'} · last login ${seen}`,
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
      'Nothing was changed.\n\n' +
        "This script **replaces** the owner's password (the old one stops working),\n" +
        'and removes 2FA if it is set. If you are sure, pass `--confirm`.\n\n' +
        'First see which accounts exist: `--list`\n',
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
      console.error('  … --confirm --email owner@office.local [--name "Name"]\n');
    } else {
      console.error('  … check with --list\n');
    }
    // Careful: distinct exit codes, so that when the script sits inside a
    // runbook, "what went wrong" can be answered without reading the output.
    process.exitCode = result.reason === 'no-owner-no-email' ? 3 : 4;
    return;
  }

  console.log(
    `\n✅ ${result.kind === 'created' ? 'new owner account created' : 'password reset'}\n`,
  );
  console.log(`   email    : ${result.email}`);
  console.log(`   password : ${result.password}\n`);
  console.log('⚠️ This password is not stored anywhere else — use it now.');
  console.log('⚠️ A new password will be required at the first login.');
  if (result.clearedTwoFactor) {
    console.log('⚠️ 2FA was removed — log in and turn it on again.');
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
